import { Effect, Exit, Semaphore } from "effect";

import type {
  SnowflakeClient,
  SnowflakeSession,
  SnowflakeTransactionOptions,
  SnowflakeTransactionOutcome,
} from "../models.ts";
import { SnowflakeOperation } from "../operations.ts";
import { failure } from "../snowflake-error.ts";
import type { Connection } from "./connection.ts";
import { asCleanup, owned } from "./lifecycle.ts";
import { call } from "./native.ts";
import * as Session from "./session.ts";

/** The callback owns its session; closing its scope expires escaped operations. */
const acquireSession = Effect.fnUntraced(function* acquireTransactionSession(
  connection: Connection
) {
  let active = true;
  const owner = yield* Effect.scope;
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      active = false;
    })
  );
  const lock = yield* Semaphore.make(1);

  return Session.make(
    connection,
    owner,
    lock,
    () => active && connection.isOpen()
  );
});

/** Serialize the whole transaction and finish native finalization before interruption. */
export const make = (
  connection: Connection,
  mutex: Semaphore.Semaphore
): SnowflakeClient["transaction"] => {
  const begin = Effect.suspend(() =>
    connection.isOpen()
      ? connection.setAutoCommit(false)
      : Effect.fail(failure(SnowflakeOperation.Closed)())
  );

  const nativeCommit = call(SnowflakeOperation.TransactionCommit, () =>
    connection.native.commit()
  );

  const nativeRollback = connection.cleanup(
    SnowflakeOperation.TransactionRollback,
    () => connection.native.rollback()
  );

  const restoreAutoCommit = Effect.suspend(() =>
    connection.isHealthy()
      ? connection.setAutoCommit(true).pipe(asCleanup)
      : Effect.void
  );

  const runBody = <A, E, R>(
    use: (session: SnowflakeSession) => Effect.Effect<A, E, R>
  ) => acquireSession(connection).pipe(Effect.flatMap(use), Effect.scoped);

  const transact = <A, E, R>(
    use: (session: SnowflakeSession) => Effect.Effect<A, E, R>,
    options?: SnowflakeTransactionOptions
  ) =>
    Effect.uninterruptibleMask((restore) => {
      let status: SnowflakeTransactionOutcome["status"] = "notStarted";

      const commit = Effect.suspend(() =>
        connection.isHealthy()
          ? nativeCommit.pipe(
              Effect.onExit((exit) =>
                Effect.sync(() => {
                  status = Exit.isSuccess(exit) ? "committed" : "unknown";
                })
              )
            )
          : Effect.fail(failure(SnowflakeOperation.TransactionInvalidated)())
      );

      const rollback = nativeRollback.pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            // A successful rollback cannot resolve an earlier failed commit.
            status =
              status === "unknown" || Exit.isFailure(exit)
                ? "unknown"
                : "rolledBack";
          })
        )
      );

      // The callback is interruptible and its scope closes before commit.
      const body = restore(runBody(use)).pipe(
        Effect.tap(() => commit),
        Effect.onExit((exit) =>
          Exit.isFailure(exit) ? rollback : Effect.void
        ),
        Effect.ensuring(restoreAutoCommit)
      );

      const attempt = begin.pipe(Effect.andThen(body));
      const onOutcome = options?.onOutcome;

      return onOutcome === undefined
        ? attempt
        : attempt.pipe(
            Effect.ensuring(
              Effect.suspend(() =>
                onOutcome({
                  connectionReusable: connection.isOpen(),
                  status,
                })
              )
            )
          );
    });

  return Effect.fn("Snowflake.transaction")(
    <A, E, R>(
      use: (session: SnowflakeSession) => Effect.Effect<A, E, R>,
      options?: SnowflakeTransactionOptions
    ) =>
      transact(use, options).pipe(mutex.withPermit, (self) =>
        owned(self, connection.owner, connection.isOpen)
      )
  );
};
