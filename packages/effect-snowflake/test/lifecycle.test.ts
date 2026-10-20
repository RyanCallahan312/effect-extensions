import { it } from "@effect/vitest";
import {
  Table,
  RecordBatchReader,
  tableFromArrays,
  tableToIPC,
} from "apache-arrow";
import {
  Cause,
  Effect,
  Exit,
  Fiber,
  Redacted,
  Scope,
  Stream,
  Tracer,
} from "effect";
import { describe, expect } from "vitest";

import { makeWithDriver, SnowflakeError } from "../src/index.ts";
import { fixture, options, secret } from "./fixture.ts";

const finalizers = (scope: Scope.Scope) =>
  "finalizers" in scope.state ? (scope.state.finalizers?.size ?? 0) : 0;

const parentScope = Effect.gen(function* acquireParent() {
  const scope = yield* Effect.acquireRelease(
    Scope.make("parallel"),
    (value, exit) => Scope.close(value, exit)
  );

  yield* Scope.addFinalizer(scope, Effect.void);
  yield* Scope.addFinalizer(scope, Effect.void);

  return scope;
});

describe("Snowflake resource failures", () => {
  it.effect(
    "revealed named options override advanced options without mutating input",
    () =>
      Effect.gen(function* overrideOptions() {
        const f = fixture();

        const databaseOptions = Object.freeze({
          "adbc.snowflake.sql.account": Redacted.make("old-account"),
          "adbc.snowflake.sql.client_option.jwt_private_key":
            Redacted.make("old-path"),
          password: Redacted.make("old-password"),
        });

        yield* Effect.scoped(
          makeWithDriver({
            ...options,
            databaseOptions,
            password: Redacted.make("new-password"),
            privateKeyPath: "/key.p8",
          })
        ).pipe(Effect.provide(f.layer));
        expect(f.input?.databaseOptions).toMatchObject({
          "adbc.snowflake.sql.account": options.account,
          "adbc.snowflake.sql.client_option.jwt_private_key": "/key.p8",
          password: "new-password",
        });
        expect(Redacted.value(databaseOptions.password)).toBe("old-password");
      })
  );

  it.effect(
    "fails before native I/O when a redacted credential was wiped",
    () =>
      Effect.gen(function* rejectWipedCredential() {
        const f = fixture();
        const password = Redacted.make(secret);
        Redacted.wipeUnsafe(password);

        const error = yield* Effect.scoped(
          makeWithDriver({ ...options, password })
        ).pipe(Effect.provide(f.layer), Effect.flip);

        expect(error.operation).toBe("options");
        expect(f.events).toEqual([]);
        expect(JSON.stringify(error)).not.toContain(secret);
      })
  );

  it.effect("detaches failed acquisitions from a long-lived parent scope", () =>
    Effect.gen(function* retireFailedAcquisitions() {
      const f = fixture();
      const parent = yield* parentScope;
      const before = finalizers(parent);
      f.rejections.add("connect");

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const error = yield* makeWithDriver(options).pipe(
          Scope.provide(parent),
          Effect.provide(f.layer),
          Effect.flip
        );

        expect(error.operation).toBe("connect");
        expect(finalizers(parent)).toBe(before);
      }

      expect(
        f.events.filter((event) => event === "database.close")
      ).toHaveLength(5);
    })
  );

  it.effect(
    "awaits interrupted authentication and closes its late connection",
    () =>
      Effect.gen(function* interruptAcquisition() {
        const f = fixture();
        const parent = yield* parentScope;
        const before = finalizers(parent);
        const gate = f.pause("connect");

        const acquiring = yield* makeWithDriver(options).pipe(
          Scope.provide(parent),
          Effect.provide(f.layer),
          Effect.forkChild
        );

        yield* Effect.promise(() => gate.entered);

        const stopped = yield* Fiber.interrupt(acquiring).pipe(
          Effect.forkChild
        );

        yield* Effect.yieldNow;
        expect(f.events).not.toContain("database.close");
        gate.release();
        yield* Fiber.join(stopped);
        const exit = yield* Fiber.await(acquiring);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(f.events.slice(-2)).toEqual([
          "connection.close",
          "database.close",
        ]);
        expect(finalizers(parent)).toBe(before);
      })
  );

  it.effect(
    "retires completed queries and streams from their owner scope",
    () =>
      Effect.gen(function* retireCompletedOperations() {
        const f = fixture();
        const parent = yield* parentScope;

        const db = yield* makeWithDriver(options).pipe(
          Scope.provide(parent),
          Effect.provide(f.layer)
        );

        const owner = f.acquiringScope;

        if (owner === undefined) {
          return yield* Effect.die("Missing native acquisition scope");
        }

        const before = finalizers(owner);

        for (let attempt = 0; attempt < 20; attempt += 1) {
          yield* db.query("select");
          yield* db.stream("stream").pipe(Stream.take(1), Stream.runDrain);
        }

        expect(finalizers(owner)).toBe(before);
        yield* Scope.close(parent, Exit.void);
        expect(
          f.events.filter((event) => event === "statement.close")
        ).toHaveLength(40);
        expect(
          f.events.filter((event) => event === "connection.close")
        ).toHaveLength(1);
      })
  );

  for (const operation of [
    "connect",
    "statement.create",
    "sql",
    "bind",
    "query",
    "execute",
  ]) {
    it.effect(`normalizes asynchronous ${operation} rejection`, () =>
      Effect.gen(function* rejectNativePromise() {
        const f = fixture();
        f.rejections.add(operation);

        const run = Effect.scoped(
          Effect.gen(function* useRejectedResource() {
            const db = yield* makeWithDriver(options);

            if (operation === "execute") {
              return yield* db.execute("select").pipe(Effect.asVoid);
            }

            return yield* db
              .query("select", tableFromArrays({ id: [1] }))
              .pipe(Effect.asVoid);
          })
        );

        const error = yield* run.pipe(Effect.provide(f.layer), Effect.flip);
        expect(error).toBeInstanceOf(SnowflakeError);
        expect(JSON.stringify(error)).not.toContain(secret);
        expect(f.events.at(-1)).toBe("database.close");
      })
    );
  }

  it.effect(
    "rechecks client health after a queued query obtains the permit",
    () =>
      Effect.gen(function* rejectQueuedQueryAfterCleanupFailure() {
        const f = fixture();
        const gate = f.pause("query");
        f.rejections.add("statement.close");
        yield* Effect.scoped(
          Effect.gen(function* queueAfterFailedCleanup() {
            const db = yield* makeWithDriver(options);

            const first = yield* db
              .query("blocked")
              .pipe(Effect.exit, Effect.forkChild);

            yield* Effect.promise(() => gate.entered);

            const queued = yield* db
              .execute("unsafe")
              .pipe(Effect.flip, Effect.forkChild);

            yield* Effect.yieldNow;
            gate.release();
            expect(Exit.isFailure(yield* Fiber.join(first))).toBe(true);
            expect((yield* Fiber.join(queued)).operation).toBe("closed");
            expect(f.events).not.toContain("sql:unsafe");
          })
        ).pipe(Effect.provide(f.layer));
      })
  );

  it.effect(
    "preserves failed commit and failed rollback in the same Cause",
    () =>
      Effect.gen(function* combineTransactionFailures() {
        const f = fixture();
        f.rejections.add("commit");
        f.rejections.add("rollback");
        yield* Effect.scoped(
          Effect.gen(function* runFailedTransaction() {
            const db = yield* makeWithDriver(options);

            const exit = yield* db
              .transaction(() => Effect.succeed(1))
              .pipe(Effect.exit);

            if (Exit.isSuccess(exit)) {
              return yield* Effect.die("Expected transaction failure");
            }

            const failures = exit.cause.reasons
              .filter(Cause.isFailReason)
              .map((reason) => reason.error.operation);

            const defects = exit.cause.reasons
              .filter(Cause.isDieReason)
              .map((reason) => reason.defect);

            expect(failures).toEqual(["transaction.commit"]);
            expect(defects).toEqual([
              expect.objectContaining({ operation: "transaction.rollback" }),
            ]);
            expect(f.events).not.toContain("autocommit:true");
          })
        ).pipe(Effect.provide(f.layer));
      })
  );

  for (const streaming of [false, true]) {
    it.effect(
      `invalidates the connection after ${streaming ? "stream" : "query"} reader cancellation fails`,
      () =>
        Effect.gen(function* failReaderCleanup() {
          const f = fixture();
          f.readerFactory = () => {
            const reader = RecordBatchReader.from(tableToIPC(f.result));
            reader.cancel = () => Promise.reject(new Error(secret));

            return reader;
          };

          yield* Effect.scoped(
            Effect.gen(function* closeFailingReader() {
              const db = yield* makeWithDriver(options);

              const run = streaming
                ? db.stream("stream").pipe(Stream.runDrain)
                : db.query("query").pipe(Effect.asVoid);

              const exit = yield* Effect.exit(run);

              if (Exit.isSuccess(exit)) {
                return yield* Effect.die("Expected cleanup defect");
              }

              expect(
                exit.cause.reasons
                  .filter(Cause.isDieReason)
                  .map((reason) => reason.defect)
              ).toContainEqual(
                expect.objectContaining({ operation: "reader.close" })
              );
              expect(f.events.at(-1)).toBe("statement.close");
              expect(
                (yield* db.execute("unsafe").pipe(Effect.flip)).operation
              ).toBe("closed");
            })
          ).pipe(Effect.provide(f.layer));
        })
    );
  }

  it.effect(
    "joins the same delayed reader teardown during consumer and owner closure",
    () =>
      Effect.gen(function* joinConcurrentStreamTeardown() {
        const f = fixture();
        const closing = Promise.withResolvers<boolean>();
        const release = Promise.withResolvers<boolean>();
        let closes = 0;
        f.readerFactory = () => {
          const reader = RecordBatchReader.from(tableToIPC(f.result));
          reader.cancel = async () => {
            closes += 1;
            closing.resolve(true);
            await release.promise;
          };

          return reader;
        };

        const owner = yield* Scope.make("parallel");

        const db = yield* makeWithDriver(options).pipe(
          Scope.provide(owner),
          Effect.provide(f.layer)
        );

        const consuming = yield* db
          .stream("stream")
          .pipe(Stream.take(1), Stream.runDrain, Effect.forkChild);

        yield* Effect.promise(() => closing.promise);

        const stopped = yield* Scope.close(owner, Exit.void).pipe(
          Effect.forkChild
        );

        yield* Effect.yieldNow;
        expect(f.events).not.toContain("connection.close");
        release.resolve(true);
        yield* Fiber.join(stopped);
        yield* Fiber.await(consuming);
        expect(closes).toBe(1);
        expect(f.events.slice(-3)).toEqual([
          "statement.close",
          "connection.close",
          "database.close",
        ]);
      })
  );

  it.effect(
    "reports cleanup defects to a scope that interrupts active work",
    () =>
      Effect.gen(function* reportOwnerCleanupDefect() {
        const f = fixture();
        const gate = f.pause("query");
        f.rejections.add("statement.close");
        const owner = yield* Scope.make();

        const db = yield* makeWithDriver(options).pipe(
          Scope.provide(owner),
          Effect.provide(f.layer)
        );

        const active = yield* db
          .query("blocked")
          .pipe(Effect.exit, Effect.forkChild);

        yield* Effect.promise(() => gate.entered);

        const stopped = yield* Scope.close(owner, Exit.void).pipe(
          Effect.exit,
          Effect.forkChild
        );

        yield* Effect.yieldNow;
        gate.release();
        const exit = yield* Fiber.join(stopped);
        expect(Exit.isFailure(exit)).toBe(true);
        yield* Fiber.join(active);
        expect(f.events.slice(-2)).toEqual([
          "connection.close",
          "database.close",
        ]);
      })
  );

  it.effect(
    "ends operation spans without exposing SQL, parameters, or credentials",
    () =>
      Effect.gen(function* traceSafeOperations() {
        const f = fixture();
        const spans: Tracer.Span[] = [];
        const original = yield* Tracer.Tracer;

        const tracer = Tracer.make({
          ...original,
          span(config) {
            const span = original.span(config);
            spans.push(span);

            return span;
          },
        });

        yield* Effect.scoped(
          Effect.gen(function* runTracedOperations() {
            const db = yield* makeWithDriver({
              ...options,
              password: Redacted.make(secret),
            });

            yield* db.query(secret, tableFromArrays({ value: [secret] }));
            yield* db.stream(secret).pipe(Stream.runDrain);
            yield* db.transaction((tx) => tx.execute(secret));
          })
        ).pipe(
          Effect.provide(f.layer),
          Effect.provideService(Tracer.Tracer, tracer)
        );
        const names = spans.map((span) => span.name);
        expect(names).toEqual(
          expect.arrayContaining([
            "Snowflake.make",
            "Snowflake.query",
            "Snowflake.stream",
            "Snowflake.transaction",
            "Snowflake.execute",
          ])
        );

        for (const span of spans) {
          expect(span.status).toHaveProperty("endTime");
          expect(
            JSON.stringify([span.name, [...span.attributes]])
          ).not.toContain(secret);
        }
      })
  );
  it.effect(
    "collects all Arrow batches and limits early consumers to their first batch",
    () =>
      Effect.gen(function* readMultipleBatches() {
        const f = fixture();
        f.result = new Table([
          ...tableFromArrays({ value: [1, 2] }).batches,
          ...tableFromArrays({ value: [3, 4] }).batches,
        ]);
        yield* Effect.scoped(
          Effect.gen(function* consumeBatches() {
            const db = yield* makeWithDriver(options);
            const result = yield* db.query("multi");
            expect([...(result.getChild("value") ?? [])]).toEqual([1, 2, 3, 4]);

            const batches = yield* db
              .stream("multi")
              .pipe(Stream.take(1), Stream.runCollect);

            expect(batches).toHaveLength(1);
            expect(batches[0]?.numRows).toBe(2);
          })
        ).pipe(Effect.provide(f.layer));
      })
  );

  it.effect(
    "closes a late statement acquisition before the owning connection",
    () =>
      Effect.gen(function* closeLateStatement() {
        const f = fixture();
        const gate = f.pause("statement.create");
        const owner = yield* Scope.make("parallel");

        const db = yield* makeWithDriver(options).pipe(
          Scope.provide(owner),
          Effect.provide(f.layer)
        );

        const running = yield* db
          .execute("late")
          .pipe(Effect.exit, Effect.forkChild);

        yield* Effect.promise(() => gate.entered);

        const closing = yield* Scope.close(owner, Exit.void).pipe(
          Effect.forkChild
        );

        yield* Effect.yieldNow;
        expect(f.events).not.toContain("connection.close");
        gate.release();
        yield* Fiber.join(closing);
        expect(Exit.isFailure(yield* Fiber.join(running))).toBe(true);
        expect(f.events).not.toContain("sql:late");
        expect(f.events.slice(-3)).toEqual([
          "statement.close",
          "connection.close",
          "database.close",
        ]);
      })
  );

  it.effect(
    "keeps native batch reads alive until settlement during owner shutdown",
    () =>
      Effect.gen(function* joinPendingBatchRead() {
        const f = fixture();
        const reading = Promise.withResolvers<boolean>();
        const release = Promise.withResolvers<boolean>();

        const source = async function* source() {
          reading.resolve(true);
          await release.promise;
          yield tableToIPC(f.result);
        };

        f.readerFactory = () => RecordBatchReader.from(source());
        const owner = yield* Scope.make("parallel");

        const db = yield* makeWithDriver(options).pipe(
          Scope.provide(owner),
          Effect.provide(f.layer)
        );

        const running = yield* db
          .stream("read")
          .pipe(Stream.runDrain, Effect.exit, Effect.forkChild);

        yield* Effect.promise(() => reading.promise);

        const closing = yield* Scope.close(owner, Exit.void).pipe(
          Effect.forkChild
        );

        yield* Effect.yieldNow;
        const closedEarly = f.events.includes("statement.close");
        release.resolve(true);
        yield* Fiber.join(closing);
        yield* Fiber.join(running);
        expect(closedEarly).toBe(false);
        expect(f.events.slice(-3)).toEqual([
          "statement.close",
          "connection.close",
          "database.close",
        ]);
      })
  );

  it.effect("preserves consumer failures and releases the stream permit", () =>
    Effect.gen(function* failDownstreamConsumer() {
      const f = fixture();
      yield* Effect.scoped(
        Effect.gen(function* reuseAfterConsumerFailure() {
          const db = yield* makeWithDriver(options);

          const failure = yield* db.stream("stream").pipe(
            Stream.runForEach(() => Effect.fail("consumer")),
            Effect.flip
          );

          expect(failure).toBe("consumer");
          expect(yield* db.execute("next")).toBe(3);
        })
      ).pipe(Effect.provide(f.layer));
    })
  );

  for (const failCleanup of [false, true]) {
    it.effect(
      `joins outstanding transaction work before ${failCleanup ? "rollback after cleanup failure" : "commit"}`,
      () =>
        Effect.gen(function* joinSessionWork() {
          const f = fixture();
          const gate = f.pause("query");

          if (failCleanup) {
            f.rejections.add("statement.close");
          }

          yield* Effect.scoped(
            Effect.gen(function* runSessionWork() {
              const db = yield* makeWithDriver(options);

              const transaction = yield* db
                .transaction((tx) =>
                  Effect.gen(function* leavePendingWork() {
                    yield* tx.query("pending").pipe(Effect.forkChild);
                    yield* Effect.promise(() => gate.entered);

                    return 42;
                  })
                )
                .pipe(Effect.exit, Effect.forkChild);

              yield* Effect.promise(() => gate.entered);
              yield* Effect.yieldNow;
              expect(f.events).not.toContain("commit");
              gate.release();
              const result = yield* Fiber.join(transaction);

              if (failCleanup) {
                expect(Exit.isFailure(result)).toBe(true);
                expect(f.events).not.toContain("commit");
                expect(f.events).toContain("rollback");
              } else {
                expect(result).toEqual(Exit.succeed(42));
                expect(f.events.indexOf("statement.close")).toBeLessThan(
                  f.events.indexOf("commit")
                );
              }
            })
          ).pipe(Effect.provide(f.layer));
        })
    );
  }
});
