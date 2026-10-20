import { Effect, Exit, Semaphore } from "effect";

import type { SnowflakeClient, SnowflakeSession } from "../models.ts";
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
      : Effect.fail(failure("closed")())
  );

  const commit = Effect.suspend(() =>
    connection.isHealthy()
      ? call("transaction.commit", () => connection.native.commit())
      : Effect.fail(failure("transaction.invalidated")())
  );

  const rollback = connection.cleanup("transaction.rollback", () =>
    connection.native.rollback()
  );

  const restoreAutoCommit = Effect.suspend(() =>
    connection.isHealthy()
      ? connection.setAutoCommit(true).pipe(asCleanup)
      : Effect.void
  );

  const rollbackOnFailure = (exit: Exit.Exit<unknown, unknown>) =>
    Exit.isFailure(exit) ? rollback : Effect.void;

  const complete = <A, E, R>(self: Effect.Effect<A, E, R>) =>
    self.pipe(
      Effect.tap(() => commit),
      Effect.onExit((exit) => rollbackOnFailure(exit)),
      Effect.ensuring(restoreAutoCommit)
    );

  const runBody = <A, E, R>(
    use: (session: SnowflakeSession) => Effect.Effect<A, E, R>
  ) => acquireSession(connection).pipe(Effect.flatMap(use), Effect.scoped);

  const transact = <A, E, R>(
    use: (session: SnowflakeSession) => Effect.Effect<A, E, R>
  ) =>
    Effect.uninterruptibleMask((restore) => {
      // Only the callback is interruptible; its scope closes before commit.
      const body = restore(runBody(use));

      return begin.pipe(Effect.andThen(complete(body)));
    });

  return Effect.fn("Snowflake.transaction")(
    <A, E, R>(use: (session: SnowflakeSession) => Effect.Effect<A, E, R>) =>
      transact(use).pipe(mutex.withPermit, (self) =>
        owned(self, connection.owner, connection.isOpen)
      )
  );
};
