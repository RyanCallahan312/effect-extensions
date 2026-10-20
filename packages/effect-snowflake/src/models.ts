import type { RecordBatch, Table } from "apache-arrow";
import type { Effect, Redacted, Stream } from "effect";

import type { SnowflakeError } from "./snowflake-error.ts";

/**
 * Snowflake ADBC connection settings. Named fields override `databaseOptions`.
 * Credentials are revealed only while constructing the native database options.
 * @since 0.1.0
 */
export interface SnowflakeOptions {
  /** Snowflake account identifier, for example `myorg-myaccount`. */
  readonly account: string;
  /** Login user. Some native authentication methods obtain identity elsewhere. */
  readonly username?: string;
  /** Login password, wrapped in `Redacted`. */
  readonly password?: Redacted.Redacted<string>;
  /** Default database for unqualified SQL names. */
  readonly database?: string;
  /** Default schema within the selected database. */
  readonly schema?: string;
  /** Compute warehouse used to execute queries. */
  readonly warehouse?: string;
  /** Snowflake role to activate for the session. */
  readonly role?: string;
  /** ADBC authentication name; the driver defaults to `auth_snowflake`. These differ from SDK authenticator names. */
  readonly authenticator?:
    | "auth_snowflake"
    | "auth_oauth"
    | "auth_ext_browser"
    | "auth_okta"
    | "auth_jwt"
    | "auth_mfa"
    | "auth_pat"
    | "auth_wif";
  /** Redacted authentication token, passed as the native `auth_token` option. */
  readonly token?: Redacted.Redacted<string>;
  /** Redacted inline PKCS#8 PEM used with `auth_jwt`. */
  readonly privateKey?: Redacted.Redacted<string>;
  /** Redacted passphrase for an encrypted inline PKCS#8 PEM. */
  readonly privateKeyPass?: Redacted.Redacted<string>;
  /** Path to a native-driver-supported private-key file; not inline PEM. */
  readonly privateKeyPath?: string;
  /** Driver name or absolute library/manifest path. Defaults to snowflake. */
  readonly driver?: string;
  /** Additional driver manifest directories, searched before standard locations. */
  readonly manifestSearchPaths?: readonly string[];
  /** Advanced native options. Redact every value, including connection URIs. */
  readonly databaseOptions?: Readonly<
    Record<string, Redacted.Redacted<string>>
  >;
}

/**
 * Serialized operations on a single connection. A transaction session expires
 * when its callback exits. Fully consume a stream before reusing that session.
 * @since 0.1.0
 */
export interface SnowflakeSession {
  /**
   * Collect a result into an Arrow table, preserving its schema for empty results.
   * @param sql Trusted SQL text with `?` placeholders; values are never interpolated.
   * @param parameters Arrow columns in placeholder order, normally one parameter row.
   * @returns A lazy Effect that owns a fresh statement and reader until collection ends.
   * Native errors become `SnowflakeError`; cleanup failures remain defects.
   */
  readonly query: (
    sql: string,
    parameters?: Table
  ) => Effect.Effect<Table, SnowflakeError>;
  /**
   * Execute DDL or DML using a fresh, scoped statement.
   * @param sql Trusted SQL text with optional `?` placeholders.
   * @param parameters Arrow columns in placeholder order.
   * @returns The affected row count, or `-1` when the native driver cannot report it.
   * Snowflake DDL may implicitly commit; execute it outside transaction callbacks.
   */
  readonly execute: (
    sql: string,
    parameters?: Table
  ) => Effect.Effect<number, SnowflakeError>;
  /**
   * Pull Arrow record batches lazily without collecting the full result.
   * @param sql Trusted SQL text with optional `?` placeholders.
   * @param parameters Arrow columns in placeholder order.
   * @returns A stream that holds the connection until consumption and cleanup finish.
   * Early termination releases the reader before its statement. In-flight native
   * reads settle before interruption completes; ADBC JS provides no cancellation.
   */
  readonly stream: (
    sql: string,
    parameters?: Table
  ) => Stream.Stream<RecordBatch, SnowflakeError>;
}

/**
 * A scoped connection with exclusive transaction callbacks.
 * @since 0.1.0
 */
export interface SnowflakeClient extends SnowflakeSession {
  /**
   * Run an Effect inside this client's transaction. Composes with `pipe` and
   * preserves its success, errors, and environment. Captured repositories and
   * client methods automatically use the active session on this fiber.
   */
  readonly withTransaction: <A, E, R>(
    self: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E | SnowflakeError, R>;

  /**
   * Disable autocommit, run `use`, and commit its success or roll back its failure.
   * @param use Callback using the supplied session; await all work before returning.
   * @returns The callback value, preserving its error and service requirements.
   * Defects and interruption also roll back. Failed commits attempt rollback.
   * Failed rollback or autocommit restoration invalidates the client, and cleanup
   * defects accompany the original failure. Captured client methods resolve the
   * active transaction session. Nested transactions fail with `transaction.nested`.
   */
  readonly transaction: <A, E, R>(
    use: (session: SnowflakeSession) => Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E | SnowflakeError, R>;
}
