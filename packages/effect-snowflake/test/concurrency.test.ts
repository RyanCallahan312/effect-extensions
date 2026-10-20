import { it } from "@effect/vitest";
import { RecordBatchReader, tableToIPC } from "apache-arrow";
import { Cause, Deferred, Effect, Exit, Fiber, Scope, Stream } from "effect";
import { describe, expect } from "vitest";

import { makeWithDriver, SnowflakeError } from "../src/index.ts";
import { fixture, options, secret } from "./fixture.ts";

describe("Snowflake ownership races", () => {
  it.effect(
    "joins connection acquisition before owner shutdown releases the database",
    () =>
      Effect.gen(function* closeDuringConnect() {
        const f = fixture();
        const gate = f.pause("connect");
        const owner = yield* Scope.make("parallel");

        const acquiring = yield* makeWithDriver(options).pipe(
          Scope.provide(owner),
          Effect.provide(f.layer),
          Effect.exit,
          Effect.forkChild
        );

        yield* Effect.promise(() => gate.entered);

        const closing = yield* Scope.close(owner, Exit.void).pipe(
          Effect.exit,
          Effect.forkChild
        );

        yield* Effect.yieldNow;
        const closedEarly = f.events.includes("database.close");
        gate.release();
        yield* Fiber.join(closing);
        const acquired = yield* Fiber.join(acquiring);
        expect(closedEarly).toBe(false);
        expect(Exit.isFailure(acquired)).toBe(true);
        expect(f.events.slice(-2)).toEqual([
          "connection.close",
          "database.close",
        ]);
      })
  );

  it.effect(
    "sanitizes stream iterator cleanup failures and invalidates the connection",
    () =>
      Effect.gen(function* sanitizeIteratorCleanup() {
        const f = fixture();
        f.readerFactory = () => {
          const reader = RecordBatchReader.from(tableToIPC(f.result));
          const iterator = reader[Symbol.asyncIterator]();
          iterator.return = () => Promise.reject(new Error(secret));
          reader[Symbol.asyncIterator] = () => iterator;
          reader.cancel = () => Promise.reject(new Error(secret));

          return reader;
        };

        yield* Effect.scoped(
          Effect.gen(function* consumeFailingReader() {
            const db = yield* makeWithDriver(options);

            const exit = yield* db
              .stream("stream")
              .pipe(Stream.take(1), Stream.runDrain, Effect.exit);

            if (Exit.isSuccess(exit)) {
              return yield* Effect.die("Expected cleanup defect");
            }

            const defects = exit.cause.reasons
              .filter(Cause.isDieReason)
              .map((reason) => reason.defect);

            expect(defects).toEqual([expect.any(SnowflakeError)]);
            expect(JSON.stringify(defects)).not.toContain(secret);
            expect(
              (yield* db.execute("unsafe").pipe(Effect.flip)).operation
            ).toBe("closed");
          })
        ).pipe(Effect.provide(f.layer));
      })
  );
  it.effect(
    "rolls back when a composed workflow recovers a cleanup defect",
    () =>
      Effect.gen(function* rejectUnhealthyCommit() {
        const f = fixture();
        f.rejections.add("statement.close");
        yield* Effect.scoped(
          Effect.gen(function* recoverInsideTransaction() {
            const db = yield* makeWithDriver(options);

            const exit = yield* db.execute("insert").pipe(
              Effect.catchCause(() => Effect.succeed(42)),
              db.withTransaction,
              Effect.exit
            );

            expect(Exit.isFailure(exit)).toBe(true);

            if (Exit.isFailure(exit)) {
              expect(
                exit.cause.reasons
                  .filter(Cause.isFailReason)
                  .map((reason) => reason.error.operation)
              ).toEqual(["transaction.invalidated"]);
            }

            expect(f.events).not.toContain("commit");
            expect(f.events).toContain("rollback");
            expect(f.events).not.toContain("autocommit:true");
          })
        ).pipe(Effect.provide(f.layer));
      })
  );

  it.effect(
    "does not roll back a successful commit when interruption arrives during commit",
    () =>
      Effect.gen(function* interruptCommit() {
        const f = fixture();
        const gate = f.pause("commit");
        yield* Effect.scoped(
          Effect.gen(function* finishCommitBeforeReuse() {
            const db = yield* makeWithDriver(options);

            const transaction = yield* db
              .execute("insert")
              .pipe(db.withTransaction, Effect.forkChild);

            yield* Effect.promise(() => gate.entered);

            const stopping = yield* Fiber.interrupt(transaction).pipe(
              Effect.forkChild
            );

            const queued = yield* db
              .execute("after commit")
              .pipe(Effect.forkChild);

            yield* Effect.yieldNow;
            const reusedEarly = f.events.includes("sql:after commit");
            gate.release();
            yield* Fiber.join(stopping);
            yield* Fiber.join(queued);
            const exit = yield* Fiber.await(transaction);
            expect(
              Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)
            ).toBe(true);
            expect(reusedEarly).toBe(false);
            expect(f.events).not.toContain("rollback");
            expect(f.events.indexOf("autocommit:true")).toBeLessThan(
              f.events.indexOf("sql:after commit")
            );
          })
        ).pipe(Effect.provide(f.layer));
      })
  );

  it.effect("joins acquisition cleanup when it overlaps owner shutdown", () =>
    Effect.gen(function* joinFailedAcquisitionCleanup() {
      const f = fixture();
      f.rejections.add("connect");
      const gate = f.pause("database.close");
      const owner = yield* Scope.make("parallel");

      const acquiring = yield* makeWithDriver(options).pipe(
        Scope.provide(owner),
        Effect.provide(f.layer),
        Effect.exit,
        Effect.forkChild
      );

      yield* Effect.promise(() => gate.entered);

      const closing = yield* Scope.close(owner, Exit.void).pipe(
        Effect.forkChild
      );

      yield* Effect.yieldNow;
      const finishedEarly = closing.pollUnsafe() !== undefined;
      gate.release();
      yield* Fiber.join(closing);
      expect(Exit.isFailure(yield* Fiber.join(acquiring))).toBe(true);
      expect(finishedEarly).toBe(false);
      expect(
        f.events.filter((event) => event === "database.close")
      ).toHaveLength(1);
    })
  );

  it.effect(
    "does not acquire native resources when the owner has already closed",
    () =>
      Effect.gen(function* rejectClosedOwner() {
        const f = fixture();
        const owner = yield* Scope.make();
        yield* Scope.close(owner, Exit.void);

        const exit = yield* makeWithDriver(options).pipe(
          Scope.provide(owner),
          Effect.provide(f.layer),
          Effect.exit
        );

        expect(Exit.isFailure(exit)).toBe(true);
        expect(f.events).toEqual([]);
      })
  );

  it.effect(
    "joins a later native batch read before canceling its reader and releasing its statement",
    () =>
      Effect.gen(function* closeDuringBatchRead() {
        const f = fixture();
        const reading = Promise.withResolvers<boolean>();
        const release = Promise.withResolvers<boolean>();
        let reads = 0;

        const chunks = async function* chunks() {
          yield tableToIPC(f.result);
        };

        f.readerFactory = async () => {
          const reader = await RecordBatchReader.from(chunks());
          const next = reader.next.bind(reader);
          const cancel = reader.cancel.bind(reader);
          reader.next = async () => {
            reads += 1;

            if (reads === 2) {
              reading.resolve(true);
              await release.promise;
            }

            return next();
          };

          reader.cancel = async () => {
            f.events.push("reader.close");
            await cancel();
          };

          return reader;
        };

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

        const closedEarly =
          f.events.includes("reader.close") ||
          f.events.includes("statement.close");

        release.resolve(true);
        yield* Fiber.join(closing);
        yield* Fiber.join(running);
        expect(closedEarly).toBe(false);
        expect(f.events.slice(-4)).toEqual([
          "reader.close",
          "statement.close",
          "connection.close",
          "database.close",
        ]);
      })
  );

  it.effect(
    "pulls no extra batch while a downstream consumer holds the current one",
    () =>
      Effect.gen(function* respectBatchDemand() {
        const f = fixture();
        const consuming = yield* Deferred.make<boolean>();
        const release = yield* Deferred.make<boolean>();
        let reads = 0;
        f.readerFactory = () => {
          const reader = RecordBatchReader.from(tableToIPC(f.result));
          const next = reader.next.bind(reader);
          reader.next = () => {
            reads += 1;

            return next();
          };

          return reader;
        };

        yield* Effect.scoped(
          Effect.gen(function* consumeOneBatch() {
            const db = yield* makeWithDriver(options);

            const running = yield* db.stream("demand").pipe(
              Stream.runForEach(() =>
                Deferred.succeed(consuming, true).pipe(
                  Effect.andThen(Deferred.await(release))
                )
              ),
              Effect.forkChild
            );

            yield* Deferred.await(consuming);
            expect(reads).toBe(1);
            yield* Deferred.succeed(release, true);
            yield* Fiber.join(running);
            expect(reads).toBe(2);
          })
        ).pipe(Effect.provide(f.layer));
      })
  );
});
