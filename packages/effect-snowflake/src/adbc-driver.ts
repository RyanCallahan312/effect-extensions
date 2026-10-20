import type {
  AdbcConnection,
  AdbcStatement,
  AdbcDatabase,
  ConnectOptions,
} from "@apache-arrow/adbc-driver-manager";
import { Context, Effect, Layer } from "effect";

import { failure } from "./snowflake-error.ts";
import type { SnowflakeError } from "./snowflake-error.ts";

/**
 * Minimal native database resource owned by a scoped client.
 * Implementations must await acquisition/cleanup rather than detach native work.
 * @since 0.1.0
 */
export interface Database {
  /** Open a connection; the adapter owns it after this Promise resolves. */
  readonly connect: () => Promise<Connection>;
  /** Release database resources after all owned connections have closed. */
  readonly close: AdbcDatabase["close"];
}

/**
 * Native statement operations used by the adapter. Each query receives a fresh
 * instance. A returned reader is released before `close` is invoked.
 * @since 0.1.0
 */
export type Statement = Pick<
  AdbcStatement,
  "setSqlQuery" | "bind" | "executeQuery" | "executeUpdate" | "close"
>;

/**
 * Native connection boundary. Methods are called under an exclusive permit;
 * `createStatement` must return a fresh statement for each call.
 * @since 0.1.0
 */
export type Connection = Pick<
  AdbcConnection,
  "setAutoCommit" | "commit" | "rollback" | "close"
> & { readonly createStatement: () => Promise<Statement> };

/**
 * Loader service required by `makeWithDriver` for alternate native loading or
 * controlled tests. `open` must map native failures to sanitized Snowflake errors.
 * Use {@link layer} for the standard Apache Arrow implementation.
 * @since 0.1.0
 */
export class AdbcDriver extends Context.Service<
  AdbcDriver,
  {
    /** Construct the database; the client owns and closes a successful result. */
    readonly open: (
      options: ConnectOptions
    ) => Effect.Effect<Database, SnowflakeError>;
  }
>()("@rc312/effect-snowflake/AdbcDriver") {}

/**
 * Standard loader layer. Importing it does not load the native addon; `open` does.
 * Addon import failures use operation `driver.load`; database construction failures
 * use `database.open`. Raw native messages and causes are excluded from both.
 * @since 0.1.0
 */
export const layer = Layer.succeed(
  AdbcDriver,
  AdbcDriver.of({
    open: Effect.fn("Snowflake.AdbcDriver.open")(
      function* openDatabase(options) {
        const { AdbcDatabase } = yield* Effect.tryPromise({
          catch: failure("driver.load"),
          try: () => import("@apache-arrow/adbc-driver-manager"),
        });

        return yield* Effect.try({
          catch: failure("database.open"),
          try: () => new AdbcDatabase(options),
        });
      }
    ),
  })
);
