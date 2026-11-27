import type { Scope } from "effect";
import { Effect, flow } from "effect";

import { AdbcDriver } from "../adbc-driver.ts";
import type { Connection as NativeConnection } from "../adbc-driver.ts";
import type { SnowflakeOptions } from "../models.ts";
import { SnowflakeOperation } from "../operations.ts";
import type { SnowflakeOperationLabel } from "../operations.ts";
import { failure } from "../snowflake-error.ts";
import type { SnowflakeError } from "../snowflake-error.ts";
import { configuration } from "./configuration.ts";
import { asCleanup } from "./lifecycle.ts";
import { call } from "./native.ts";

/** One native connection and the lifetime shared by all of its sessions. */
export interface Connection {
  readonly native: NativeConnection;
  readonly owner: Scope.Scope;
  readonly isOpen: () => boolean;
  readonly isHealthy: () => boolean;
  readonly cleanup: <A>(
    operation: SnowflakeOperationLabel,
    run: () => Promise<A>
  ) => Effect.Effect<A>;
  readonly setAutoCommit: (
    enabled: boolean
  ) => Effect.Effect<void, SnowflakeError>;
}

/** Called inside the client's private sequential scope. Dependencies are captured once. */
export const make = Effect.fnUntraced(function* acquireConnection(
  options: SnowflakeOptions,
  isOwnerOpen: () => boolean
) {
  const driver = yield* AdbcDriver;
  const owner = yield* Effect.scope;

  const config = yield* Effect.try({
    catch: failure(SnowflakeOperation.Options),
    try: () => configuration(options),
  });

  let healthy = true;

  const invalidate = Effect.sync(() => {
    healthy = false;
  });

  const finalize = flow(
    Effect.tapError(() => invalidate),
    asCleanup
  );

  const cleanup: Connection["cleanup"] = (operation, run) =>
    call(operation, run).pipe(finalize);

  const database = yield* Effect.acquireRelease(
    driver.open(config),
    (resource) =>
      cleanup(SnowflakeOperation.DatabaseClose, () => resource.close())
  );

  const native = yield* Effect.acquireRelease(
    call(SnowflakeOperation.Connect, () => database.connect()),
    (resource) =>
      cleanup(SnowflakeOperation.ConnectionClose, () => resource.close())
  );

  return {
    cleanup,
    isHealthy: () => healthy,
    isOpen: () => isOwnerOpen() && healthy,
    native,
    owner,
    setAutoCommit: (enabled: boolean) =>
      Effect.try({
        catch: failure(SnowflakeOperation.TransactionAutoCommit),
        try: () => native.setAutoCommit(enabled),
      }).pipe(Effect.tapError(() => invalidate)),
  } satisfies Connection;
});
