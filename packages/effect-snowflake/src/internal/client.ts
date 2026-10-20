import { Context, Effect, Exit, Option, Semaphore, Stream } from "effect";

import type { SnowflakeClient, SnowflakeSession } from "../models.ts";
import { failure } from "../snowflake-error.ts";
import type { Connection } from "./connection.ts";
import { asCleanup, owned } from "./lifecycle.ts";
import { call } from "./native.ts";
import * as Session from "./session.ts";

/** A callback owns a sequential child scope; native commit follows its teardown. */
const makeTransaction = (
  connection: Connection,
  mutex: Semaphore.Semaphore
): SnowflakeClient["transaction"] =>
  Effect.fn("Snowflake.transaction")(
    <A, E, R>(use: (tx: SnowflakeSession) => Effect.Effect<A, E, R>) =>
      owned(
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* runTransaction() {
            if (!connection.isOpen()) {
              return yield* failure("closed")();
            }

            yield* connection.setAutoCommit(false);

            const run = Effect.scoped(
              Effect.gen(function* runTransactionBody() {
                let active = true;
                const owner = yield* Effect.scope;
                yield* Effect.addFinalizer(() =>
                  Effect.sync(() => {
                    active = false;
                  })
                );
                const lock = yield* Semaphore.make(1);

                return yield* use(
                  Session.make(
                    connection,
                    owner,
                    lock,
                    () => active && connection.isOpen()
                  )
                );
              })
            ).pipe(
              Effect.tap(() =>
                call("transaction.commit", () => connection.native.commit())
              )
            );

            return yield* restore(run).pipe(
              Effect.onExit((exit) =>
                Exit.isFailure(exit)
                  ? connection.cleanup("transaction.rollback", () =>
                      connection.native.rollback()
                    )
                  : Effect.void
              ),
              Effect.ensuring(
                Effect.suspend(() =>
                  connection.isHealthy()
                    ? connection.setAutoCommit(true).pipe(asCleanup)
                    : Effect.void
                )
              )
            );
          })
        ).pipe(mutex.withPermit),
        connection.owner,
        connection.isOpen
      )
  );

// Each client needs its own fiber-local session key, as in Effect SqlClient.
// A transaction on one client must never route another client's queries.
let nextClientId = 0;

/** Capture the connection; client methods have no dependency requirements. */
export const make = Effect.fnUntraced(function* makeClient(
  connection: Connection
): Effect.fn.Return<SnowflakeClient> {
  const lock = yield* Semaphore.make(1);

  const direct = Session.make(
    connection,
    connection.owner,
    lock,
    connection.isOpen
  );

  const transactionSession = Context.Service<SnowflakeSession>(
    `@rc312/effect-snowflake/Transaction/${(nextClientId += 1)}`
  );

  const currentSession = Effect.serviceOption(transactionSession).pipe(
    Effect.map(Option.getOrElse(() => direct))
  );

  const runTransaction = makeTransaction(connection, lock);

  const transaction: SnowflakeClient["transaction"] = <A, E, R>(
    use: (session: SnowflakeSession) => Effect.Effect<A, E, R>
  ) =>
    Effect.serviceOption(transactionSession).pipe(
      Effect.flatMap((current) => {
        if (Option.isSome(current)) {
          return Effect.fail(failure("transaction.nested")());
        }

        return runTransaction((session) =>
          Effect.provideService(use(session), transactionSession, session)
        );
      })
    );

  return {
    execute: (sql, parameters) =>
      currentSession.pipe(
        Effect.flatMap((session) => session.execute(sql, parameters))
      ),
    query: (sql, parameters) =>
      currentSession.pipe(
        Effect.flatMap((session) => session.query(sql, parameters))
      ),
    stream: (sql, parameters) =>
      Stream.unwrap(
        currentSession.pipe(
          Effect.map((session) => session.stream(sql, parameters))
        )
      ),
    transaction,
    withTransaction: (self) => transaction(() => self),
  };
});
