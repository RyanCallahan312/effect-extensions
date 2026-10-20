import { it } from "@effect/vitest";
import {
  RecordBatchReader,
  Table,
  tableFromArrays,
  tableToIPC,
} from "apache-arrow";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Redacted,
  Scope,
  Stream,
} from "effect";
import { describe, expect } from "vitest";

import { make, makeWithDriver, SnowflakeError } from "../src/index.ts";
import type { SnowflakeClient, SnowflakeSession } from "../src/index.ts";
import { fixture, options, secret } from "./fixture.ts";

describe("Snowflake ADBC client", () => {
  it.effect("acquires lazily and closes connection before database", () =>
    Effect.gen(function* testAcquiresLazilyAndClosesConnectionBefore() {
      const f = fixture();
      const acquire = makeWithDriver(options);
      expect(f.events).toEqual([]);
      yield* Effect.scoped(acquire).pipe(Effect.provide(f.layer));
      expect(f.events).toEqual([
        "open",
        "connect",
        "connection.close",
        "database.close",
      ]);
      expect(f.input).toEqual({
        databaseOptions: {
          "adbc.snowflake.sql.account": "org-account",
          username: "user",
        },
        driver: "snowflake",
      });
    })
  );

  it.effect("maps redacted authentication and advanced ADBC options", () =>
    Effect.gen(function* testMapsRedactedAuthenticationAndAdvancedAdbc() {
      const f = fixture();
      yield* Effect.scoped(
        makeWithDriver({
          ...options,
          authenticator: "auth_jwt",
          database: "DB",
          databaseOptions: {
            "adbc.snowflake.sql.client_option.login_timeout":
              Redacted.make("30s"),
          },
          driver: "/driver/path",
          manifestSearchPaths: ["/manifests"],
          password: Redacted.make("password"),
          privateKey: Redacted.make("pem"),
          privateKeyPass: Redacted.make("passphrase"),
          role: "ROLE",
          schema: "PUBLIC",
          token: Redacted.make("token"),
          warehouse: "WH",
        })
      ).pipe(Effect.provide(f.layer));
      expect(f.input).toEqual({
        databaseOptions: {
          "adbc.snowflake.sql.account": "org-account",
          "adbc.snowflake.sql.auth_type": "auth_jwt",
          "adbc.snowflake.sql.client_option.auth_token": "token",
          "adbc.snowflake.sql.client_option.jwt_private_key_pkcs8_password":
            "passphrase",
          "adbc.snowflake.sql.client_option.jwt_private_key_pkcs8_value": "pem",
          "adbc.snowflake.sql.client_option.login_timeout": "30s",
          "adbc.snowflake.sql.db": "DB",
          "adbc.snowflake.sql.role": "ROLE",
          "adbc.snowflake.sql.schema": "PUBLIC",
          "adbc.snowflake.sql.warehouse": "WH",
          password: "password",
          username: "user",
        },
        driver: "/driver/path",
        manifestSearchPaths: ["/manifests"],
      });
    })
  );

  it.effect("closes the database when connect fails and sanitizes errors", () =>
    Effect.gen(function* testClosesTheDatabaseWhenConnectFails() {
      const f = fixture();
      f.failures.add("connect");

      const error = yield* Effect.scoped(makeWithDriver(options)).pipe(
        Effect.provide(f.layer),
        Effect.flip
      );

      expect(error).toBeInstanceOf(SnowflakeError);
      expect(error.operation).toBe("connect");
      expect(JSON.stringify(error)).not.toContain(secret);
      expect(f.events).toEqual(["open", "connect", "database.close"]);
    })
  );

  it.effect(
    "retains Arrow int64 precision and binds the original Arrow table",
    () =>
      Effect.gen(function* testRetainsArrowIntPrecisionAndBinds() {
        const f = fixture();

        const parameters = tableFromArrays({
          value: new BigInt64Array([9_007_199_254_740_993n]),
        });

        yield* Effect.scoped(
          Effect.gen(
            function* testRetainsArrowIntPrecisionAndBindsWithClient() {
              const db = yield* makeWithDriver(options);
              const table = yield* db.query("select ?", parameters);
              expect(table.getChild("id")?.get(0)).toBe(9_007_199_254_740_993n);
              expect(f.bound).toBe(parameters);
              expect(
                yield* db.execute("insert into items values (?)", parameters)
              ).toBe(3);
            }
          )
        ).pipe(Effect.provide(f.layer));
        expect(
          f.events.filter((event) => event === "statement.close")
        ).toHaveLength(2);
      })
  );

  it.effect("retains schema when a query returns no rows", () =>
    Effect.gen(function* testRetainsSchemaWhenAQueryReturns() {
      const f = fixture();
      const data = tableFromArrays({ id: [1], name: ["a"] });
      f.result = new Table(data.schema, []);
      yield* Effect.scoped(
        Effect.gen(function* testRetainsSchemaWhenAQueryReturnsWithClient() {
          const db = yield* makeWithDriver(options);
          const table = yield* db.query("empty");
          expect(table.numRows).toBe(0);
          expect(table.schema.fields.map((field) => field.name)).toEqual([
            "id",
            "name",
          ]);
        })
      ).pipe(Effect.provide(f.layer));
    })
  );

  it.effect("streams Arrow batches lazily and releases early consumers", () =>
    Effect.gen(function* testStreamsArrowBatchesLazilyAndReleases() {
      const f = fixture();
      yield* Effect.scoped(
        Effect.gen(
          function* testStreamsArrowBatchesLazilyAndReleasesWithClient() {
            const db = yield* makeWithDriver(options);
            const stream = db.stream("select");
            expect(f.events).toEqual(["open", "connect"]);

            const batches = yield* stream.pipe(
              Stream.take(1),
              Stream.runCollect
            );

            expect(batches[0]?.getChild("id")?.get(0)).toBe(
              9_007_199_254_740_993n
            );
            expect(f.events.at(-1)).toBe("statement.close");
            expect(yield* db.execute("next")).toBe(3);
          }
        )
      ).pipe(Effect.provide(f.layer));
    })
  );

  for (const operation of [
    "statement.create",
    "sql:select",
    "bind",
    "query",
    "execute",
  ]) {
    it.effect(
      `normalizes ${operation} failures and closes acquired statements`,
      () =>
        Effect.gen(
          function* testNormalizesOperationFailuresAndClosesAcquired() {
            const f = fixture();
            f.failures.add(operation);
            yield* Effect.scoped(
              Effect.gen(
                function* testNormalizesOperationFailuresAndClosesAcquiredWithClient() {
                  const db = yield* makeWithDriver(options);

                  const error = yield* operation === "execute"
                    ? db.execute("select").pipe(Effect.flip)
                    : db
                        .query("select", tableFromArrays({ x: [1] }))
                        .pipe(Effect.flip);

                  expect(error).toBeInstanceOf(SnowflakeError);
                  expect(JSON.stringify(error)).not.toContain(secret);

                  if (operation !== "statement.create") {
                    expect(f.events.at(-1)).toBe("statement.close");
                  }

                  expect(
                    yield* db.execute("reusable").pipe(Effect.exit)
                  ).toBeDefined();
                }
              )
            ).pipe(Effect.provide(f.layer));
          }
        )
    );
  }

  it.effect("rejects client and stream reuse after scope closure", () =>
    Effect.gen(function* testRejectsClientAndStreamReuseAfter() {
      const f = fixture();

      const db = yield* Effect.scoped(makeWithDriver(options)).pipe(
        Effect.provide(f.layer)
      );

      expect((yield* db.query("closed").pipe(Effect.flip)).operation).toBe(
        "closed"
      );
      expect(
        (yield* db.stream("closed").pipe(Stream.runCollect, Effect.flip))
          .operation
      ).toBe("closed");
      expect(f.events).toEqual([
        "open",
        "connect",
        "connection.close",
        "database.close",
      ]);
    })
  );

  it.effect("commits successful callbacks and expires their sessions", () =>
    Effect.gen(function* testCommitsSuccessfulCallbacksAndExpiresTheir() {
      const f = fixture();
      let saved: SnowflakeSession | undefined;
      yield* Effect.scoped(
        Effect.gen(
          function* testCommitsSuccessfulCallbacksAndExpiresTheirWithClient() {
            const db = yield* makeWithDriver(options);

            const value = yield* db.transaction((tx) => {
              saved = tx;

              return tx.execute("insert");
            });

            expect(value).toBe(3);
            expect(f.events).toContain("commit");
            expect(f.events).not.toContain("rollback");

            if (saved === undefined) {
              return yield* Effect.die("Missing transaction session");
            }

            expect(
              (yield* saved.execute("expired").pipe(Effect.flip)).operation
            ).toBe("closed");
            expect(yield* db.execute("next")).toBe(3);
          }
        )
      ).pipe(Effect.provide(f.layer));
      expect(f.events.indexOf("statement.close")).toBeLessThan(
        f.events.indexOf("commit")
      );
      expect(f.events.indexOf("commit")).toBeLessThan(
        f.events.indexOf("autocommit:true")
      );
    })
  );

  it.effect(
    "rolls back typed failures and defects without replacing them",
    () =>
      Effect.gen(function* testRollsBackTypedFailuresAndDefects() {
        for (const abort of [Effect.fail("abort"), Effect.die("defect")]) {
          const f = fixture();
          yield* Effect.scoped(
            Effect.gen(
              function* testRollsBackTypedFailuresAndDefectsWithClient() {
                const db = yield* makeWithDriver(options);

                const exit = yield* db
                  .transaction(() => abort)
                  .pipe(Effect.exit);

                expect(Exit.isFailure(exit)).toBe(true);
                expect(f.events).toEqual([
                  "open",
                  "connect",
                  "autocommit:false",
                  "rollback",
                  "autocommit:true",
                ]);
              }
            )
          ).pipe(Effect.provide(f.layer));
        }
      })
  );

  it.effect("rolls back after a failed commit", () =>
    Effect.gen(function* testRollsBackAfterAFailedCommit() {
      const f = fixture();
      f.failures.add("commit");
      yield* Effect.scoped(
        Effect.gen(function* testRollsBackAfterAFailedCommitWithClient() {
          const db = yield* makeWithDriver(options);

          const error = yield* db
            .transaction(() => Effect.succeed(42))
            .pipe(Effect.flip);

          expect(error.operation).toBe("transaction.commit");
          expect(f.events.slice(-3)).toEqual([
            "commit",
            "rollback",
            "autocommit:true",
          ]);
        })
      ).pipe(Effect.provide(f.layer));
    })
  );

  it.effect("invalidates failed rollback without enabling autocommit", () =>
    Effect.gen(
      function* testInvalidatesFailedRollbackWithoutEnablingAutocommit() {
        const f = fixture();
        f.failures.add("rollback");
        yield* Effect.scoped(
          Effect.gen(
            function* testInvalidatesFailedRollbackWithoutEnablingAutocommitWithClient() {
              const db = yield* makeWithDriver(options);

              const exit = yield* db
                .transaction(() => Effect.fail("abort"))
                .pipe(Effect.exit);

              expect(Exit.isFailure(exit)).toBe(true);

              if (Exit.isFailure(exit)) {
                expect(Cause.hasDies(exit.cause)).toBe(true);
                expect(Cause.hasFails(exit.cause)).toBe(true);
              }

              expect(f.events).not.toContain("autocommit:true");
              expect(
                (yield* db.execute("unsafe").pipe(Effect.flip)).operation
              ).toBe("closed");
            }
          )
        ).pipe(Effect.provide(f.layer));
      }
    )
  );

  it.effect(
    "waits for an interrupted native query before reusing the connection",
    () =>
      Effect.gen(function* testWaitsForAnInterruptedNativeQuery() {
        const f = fixture();
        const gate = Promise.withResolvers<boolean>();
        f.queryGate = gate.promise;
        yield* Effect.scoped(
          Effect.gen(
            function* testWaitsForAnInterruptedNativeQueryWithClient() {
              const db = yield* makeWithDriver(options);
              const first = yield* db.query("blocked").pipe(Effect.forkChild);
              yield* Effect.promise(() => f.started.promise);

              const stop = yield* Fiber.interrupt(first).pipe(Effect.forkChild);

              const next = yield* db.execute("next").pipe(Effect.forkChild);
              yield* Effect.yieldNow;
              expect(f.events).not.toContain("statement.close");
              expect(f.events).not.toContain("sql:next");
              gate.resolve(true);
              yield* Fiber.join(stop);
              expect(yield* Fiber.join(next)).toBe(3);
              expect(f.events.indexOf("statement.close")).toBeLessThan(
                f.events.indexOf("sql:next")
              );
            }
          )
        ).pipe(Effect.provide(f.layer));
      })
  );

  it.effect(
    "joins in-flight queries before closing a parallel parent scope",
    () =>
      Effect.gen(function* testJoinsInFlightQueriesBeforeClosing() {
        const f = fixture();
        const gate = Promise.withResolvers<boolean>();
        f.queryGate = gate.promise;
        const scope = yield* Scope.make("parallel");

        const db = yield* makeWithDriver(options).pipe(
          Scope.provide(scope),
          Effect.provide(f.layer)
        );

        const pending = yield* db.query("blocked").pipe(Effect.forkChild);
        yield* Effect.promise(() => f.started.promise);

        const closing = yield* Scope.close(scope, Exit.void).pipe(
          Effect.forkChild
        );

        yield* Effect.yieldNow;
        expect(f.events).not.toContain("connection.close");
        gate.resolve(true);
        yield* Fiber.join(closing);
        yield* Fiber.await(pending);
        expect(f.events.slice(-3)).toEqual([
          "statement.close",
          "connection.close",
          "database.close",
        ]);
      })
  );

  it.effect("surfaces cleanup failures and invalidates the connection", () =>
    Effect.gen(function* testSurfacesCleanupFailuresAndInvalidatesThe() {
      const f = fixture();
      f.failures.add("statement.close");
      yield* Effect.scoped(
        Effect.gen(
          function* testSurfacesCleanupFailuresAndInvalidatesTheWithClient() {
            const db = yield* makeWithDriver(options);
            const exit = yield* db.execute("insert").pipe(Effect.exit);
            expect(Exit.isFailure(exit)).toBe(true);
            expect(
              (yield* db.execute("unsafe").pipe(Effect.flip)).operation
            ).toBe("closed");
          }
        )
      ).pipe(Effect.provide(f.layer));
    })
  );

  it.effect(
    "loads the real native manager and sanitizes missing-driver failures",
    () =>
      Effect.gen(function* testLoadsTheRealNativeManagerAnd() {
        const error = yield* Effect.scoped(
          make({ ...options, driver: "/nonexistent/effect-snowflake-driver" })
        ).pipe(Effect.flip);

        expect(error.operation).toBe("database.open");
        expect(error.message).toBe("Snowflake database.open failed");
      })
  );
  it.effect(
    "releases streamed readers before statements on early termination",
    () =>
      Effect.gen(function* testReleasesStreamedReadersBeforeStatementsOn() {
        const f = fixture();
        const data = tableFromArrays({ id: [1, 2] });
        const bytes = tableToIPC(data);

        const source = async function* source() {
          try {
            yield bytes.subarray(0, -8);
          } finally {
            f.events.push("reader.close");
          }
        };

        f.readerFactory = () => RecordBatchReader.from(source());
        yield* Effect.scoped(
          Effect.gen(function* consumeFirstBatch() {
            const db = yield* makeWithDriver(options);
            yield* db.stream("stream").pipe(Stream.take(1), Stream.runDrain);
            expect(f.events.slice(-2)).toEqual([
              "reader.close",
              "statement.close",
            ]);
            yield* db.execute("next");
          })
        ).pipe(Effect.provide(f.layer));
      })
  );

  it.effect("fails on streamed read errors and closes its statement", () =>
    Effect.gen(function* testFailsOnStreamedReadErrorsAnd() {
      const f = fixture();
      const bytes = tableToIPC(tableFromArrays({ id: [1] }));

      const brokenSource = async function* brokenSource() {
        yield bytes.subarray(0, -8);
        throw new Error(secret);
      };

      f.readerFactory = () => RecordBatchReader.from(brokenSource());
      yield* Effect.scoped(
        Effect.gen(function* consumeBrokenStream() {
          const db = yield* makeWithDriver(options);

          const error = yield* db
            .stream("stream")
            .pipe(Stream.runDrain, Effect.flip);

          expect(error.operation).toBe("stream.read");
          expect(JSON.stringify(error)).not.toContain(secret);
          expect(f.events.at(-1)).toBe("statement.close");
          yield* db.execute("next");
        })
      ).pipe(Effect.provide(f.layer));
    })
  );

  it.effect(
    "holds the connection while the stream consumer processes a batch",
    () =>
      Effect.gen(function* testHoldsTheConnectionWhileTheStream() {
        const f = fixture();
        const consuming = yield* Deferred.make<boolean>();
        const release = yield* Deferred.make<boolean>();
        yield* Effect.scoped(
          Effect.gen(function* runConcurrentConsumer() {
            const db = yield* makeWithDriver(options);

            const stream = yield* db.stream("stream").pipe(
              Stream.runForEach(() =>
                Deferred.succeed(consuming, true).pipe(
                  Effect.andThen(Deferred.await(release))
                )
              ),
              Effect.forkChild
            );

            yield* Deferred.await(consuming);
            const next = yield* db.execute("next").pipe(Effect.forkChild);
            yield* Effect.yieldNow;
            expect(f.events).not.toContain("sql:next");
            yield* Deferred.succeed(release, true);
            yield* Fiber.join(stream);
            yield* Fiber.join(next);
            expect(f.events.indexOf("statement.close")).toBeLessThan(
              f.events.indexOf("sql:next")
            );
          })
        ).pipe(Effect.provide(f.layer));
      })
  );

  it.effect(
    "owner shutdown releases a stream paused in its downstream consumer",
    () =>
      Effect.gen(function* testOwnerShutdownReleasesAStreamPaused() {
        const f = fixture();
        const consuming = yield* Deferred.make<boolean>();
        const scope = yield* Scope.make("parallel");

        const db = yield* makeWithDriver(options).pipe(
          Scope.provide(scope),
          Effect.provide(f.layer)
        );

        const pending = yield* db.stream("stream").pipe(
          Stream.runForEach(() =>
            Deferred.succeed(consuming, true).pipe(Effect.andThen(Effect.never))
          ),
          Effect.forkChild
        );

        yield* Deferred.await(consuming);
        yield* Scope.close(scope, Exit.void);
        expect(f.events.slice(-3)).toEqual([
          "statement.close",
          "connection.close",
          "database.close",
        ]);
        yield* Fiber.interrupt(pending);
      })
  );

  it.effect(
    "rolls back an interrupted transaction before accepting another operation",
    () =>
      Effect.gen(function* testRollsBackAnInterruptedTransactionBefore() {
        const f = fixture();
        const entered = yield* Deferred.make<boolean>();
        yield* Effect.scoped(
          Effect.gen(function* interruptTransaction() {
            const db = yield* makeWithDriver(options);

            const tx = yield* db
              .transaction(() =>
                Deferred.succeed(entered, true).pipe(
                  Effect.andThen(Effect.never)
                )
              )
              .pipe(Effect.forkChild);

            yield* Deferred.await(entered);
            yield* Fiber.interrupt(tx);
            expect(f.events.slice(-2)).toEqual(["rollback", "autocommit:true"]);
            yield* db.execute("next");
          })
        ).pipe(Effect.provide(f.layer));
      })
  );

  it.effect("serializes concurrent transaction session statements", () =>
    Effect.gen(
      function* testSerializesConcurrentTransactionSessionStatements() {
        const f = fixture();
        const gate = Promise.withResolvers<boolean>();
        f.queryGate = gate.promise;
        yield* Effect.scoped(
          Effect.gen(function* useConcurrentTransaction() {
            const db = yield* makeWithDriver(options);
            yield* db.transaction((tx) =>
              Effect.gen(function* useSession() {
                const first = yield* tx.query("blocked").pipe(Effect.forkChild);
                yield* Effect.promise(() => f.started.promise);
                const second = yield* tx.execute("next").pipe(Effect.forkChild);
                yield* Effect.yieldNow;
                expect(f.events).not.toContain("sql:next");
                gate.resolve(true);
                yield* Fiber.join(first);
                yield* Fiber.join(second);
              })
            );
            expect(f.events).toContain("commit");
          })
        ).pipe(Effect.provide(f.layer));
      }
    )
  );

  for (const failed of ["autocommit:false", "autocommit:true"]) {
    it.effect(`invalidates the client after failed ${failed}`, () =>
      Effect.gen(function* testInvalidatesTheClientAfterFailedFailed() {
        const f = fixture();
        f.failures.add(failed);
        yield* Effect.scoped(
          Effect.gen(function* failAutocommit() {
            const db = yield* makeWithDriver(options);

            const exit = yield* db
              .transaction(() => Effect.succeed(1))
              .pipe(Effect.exit);

            expect(Exit.isFailure(exit)).toBe(true);
            expect(
              (yield* db.execute("unsafe").pipe(Effect.flip)).operation
            ).toBe("closed");
          })
        ).pipe(Effect.provide(f.layer));
      })
    );
  }

  it.effect("attempts database close even when connection close fails", () =>
    Effect.gen(function* testAttemptsDatabaseCloseEvenWhenConnection() {
      const f = fixture();
      f.failures.add("connection.close");

      const exit = yield* Effect.scoped(makeWithDriver(options)).pipe(
        Effect.provide(f.layer),
        Effect.exit
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(f.events.slice(-2)).toEqual([
        "connection.close",
        "database.close",
      ]);
    })
  );
});

// Assignment checks preserve public success/error/Scope and callback environment inference.
const infer = <A, E, R>(
  client: SnowflakeClient,
  use: Effect.Effect<A, E, R>
) => {
  const scoped: Effect.Effect<SnowflakeClient, SnowflakeError, Scope.Scope> =
    make(options);

  const transaction: Effect.Effect<A, E | SnowflakeError, R> =
    client.transaction(() => use);

  const query: Effect.Effect<Table, SnowflakeError> = client.query("select");

  const tx: Effect.Effect<number, SnowflakeError | "abort"> =
    client.transaction(() => Effect.fail("abort" as const));

  return { query, scoped, transaction, tx };
};

void infer;
