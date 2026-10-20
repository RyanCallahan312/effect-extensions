import type { RecordBatch, Table } from "apache-arrow";
import { Config, Context, Effect, flow, pipe, Layer, Stream } from "effect";

import { layer as driverLayer } from "./adbc-driver.ts";
import * as Client from "./internal/client.ts";
import * as Connection from "./internal/connection.ts";
import { acquireOwner } from "./internal/lifecycle.ts";
import type {
  SnowflakeClient,
  SnowflakeOptions,
  SnowflakeSession,
} from "./models.ts";
import type { SnowflakeError } from "./snowflake-error.ts";

export type {
  SnowflakeClient,
  SnowflakeOptions,
  SnowflakeSession,
} from "./models.ts";

export { SnowflakeError } from "./snowflake-error.ts";

/**
 * Injected client service. Its layer owns one connection and captures its driver.
 * Reuse the same layer value when repositories should share that connection.
 * @since 0.1.0
 */
export class Snowflake extends Context.Service<
  Snowflake,
  {
    readonly query: SnowflakeSession["query"];
    readonly execute: SnowflakeSession["execute"];
    readonly stream: SnowflakeSession["stream"];
    readonly transaction: SnowflakeClient["transaction"];
    readonly withTransaction: SnowflakeClient["withTransaction"];
  }
>()("@rc312/effect-snowflake/Snowflake") {}

/**
 * Acquire a connected client through an injected `AdbcDriver` service.
 *
 * @param options Native Snowflake settings; construction performs no I/O.
 * @returns An Effect requiring `Scope` and `AdbcDriver`. The scope joins active
 * operations before closing connection and database, even under parallel teardown.
 * Failed acquisition immediately releases its partial resources and child scope.
 *
 * Custom loaders must normalize native errors to sanitized `SnowflakeError`s.
 * Native calls have no cancellation API: configure driver network/login timeouts
 * to bound shutdown. Prefer {@link make} when using the standard native manager.
 * @since 0.1.0
 */
export const makeWithDriver = Effect.fn("Snowflake.make")(
  flow(Connection.make, Effect.flatMap(Client.make), acquireOwner)
);

/**
 * Acquire a server-only Snowflake connection through the Apache Arrow ADBC manager.
 *
 * @param options Connection settings. The Snowflake shared-library driver must be
 * installed separately; `driver` defaults to `snowflake`.
 * @returns A lazy Effect requiring `Scope`. Its scope owns connection and database.
 * Driver loading and connection errors are sanitized `SnowflakeError`s. Native
 * calls settle before interruption releases resources; queries are never retried.
 *
 * @example
 * ```ts
 * import { make } from "@rc312/effect-snowflake";
 * import { Config, Effect } from "effect";
 *
 * const program = Effect.scoped(Effect.gen(function* () {
 *   const db = yield* make({
 *     account: yield* Config.String("SNOWFLAKE_ACCOUNT"),
 *     username: yield* Config.String("SNOWFLAKE_USERNAME"),
 *     password: yield* Config.Redacted("SNOWFLAKE_PASSWORD"),
 *   });
 *   return yield* db.query("select current_version() as VERSION");
 * }));
 * ```
 * @since 0.1.0
 */
export const make = Effect.fn("Snowflake.makeDefault")(
  (options: SnowflakeOptions) =>
    makeWithDriver(options).pipe(Effect.provide(driverLayer))
);

/**
 * Provide the service from an existing acquisition Effect, retaining its errors
 * and dependencies. The Layer owns any Scope required by the acquisition.
 * Useful for application-owned configuration, instrumentation, and test clients.
 * @since 0.1.0
 */
export const layerFrom = <E, R>(
  acquire: Effect.Effect<SnowflakeClient, E, R>
) => Layer.effect(Snowflake, acquire);

/**
 * Provide a scoped Snowflake service using an injected AdbcDriver.
 * Compose with `Layer.provide(AdbcDriver.layer)` at the application boundary.
 * @since 0.1.0
 */
export const layer = (options: SnowflakeOptions) =>
  layerFrom(makeWithDriver(options));

/**
 * Read Config values when the layer is built, then acquire its scoped client.
 * Accepts one Config or a record of Config fields; ConfigProvider stays caller-owned.
 * Requires the same explicit AdbcDriver dependency as {@link layer}.
 * @since 0.1.0
 */
export const layerConfig = (options: Config.Wrap<SnowflakeOptions>) =>
  Layer.unwrap(Config.unwrap(options).pipe(Effect.map(layer)));

/** Query the injected client, or the active transaction's scoped session. @since 0.1.0 */
export const query = (sql: string, parameters?: Table) =>
  pipe(
    Snowflake,
    Effect.flatMap((client) => client.query(sql, parameters))
  );

/** Execute DML/DDL on the injected client. @since 0.1.0 */
export const execute = (sql: string, parameters?: Table) =>
  pipe(
    Snowflake,
    Effect.flatMap((client) => client.execute(sql, parameters))
  );

/** Lazily stream batches from the injected client; the consumer owns its permit. @since 0.1.0 */
export const stream = (
  sql: string,
  parameters?: Table
): Stream.Stream<RecordBatch, SnowflakeError, Snowflake> =>
  Stream.unwrap(
    pipe(
      Snowflake,
      Effect.map((client) => client.stream(sql, parameters))
    )
  );

/**
 * Run an Effect in a transaction using the injected client. Pipe it around a
 * composed workflow; accessors and `yield* Snowflake` both resolve its session.
 * Nested transactions fail with operation `transaction.nested` (Snowflake has no
 * savepoints). Callback errors, defects, service requirements, and interruption
 * are preserved by the underlying transaction implementation.
 * @since 0.1.0
 */
export const withTransaction = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  pipe(
    Snowflake,
    Effect.flatMap((client) => client.withTransaction(self))
  );
