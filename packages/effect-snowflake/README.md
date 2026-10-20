# @rc312/effect-snowflake

An Effect 4 client for Snowflake through Apache Arrow ADBC. Queries return Arrow `Table`s, streams emit Arrow `RecordBatch`es, and parameters are Arrow tables. The adapter preserves Arrow values without coercing decimals, timestamps, binary values, or 64-bit integers into JavaScript numbers or JSON.

## Install

```sh
bun add @rc312/effect-snowflake effect apache-arrow@^21.1.0
```

Use Node.js 22.12 or newer. This is a server-only package with a native dependency. The package includes the JavaScript ADBC driver manager; install the Snowflake shared-library driver separately:

```sh
npm install -g @columnar-tech/dbc
dbc install snowflake
```

`make` defaults to the driver name `snowflake`. Set `driver` to an absolute path to a driver library or manifest when needed, or supply `manifestSearchPaths`. Importing this package does not load the native addon; acquisition loads it and reports loading failures as `SnowflakeError`.

See the [ADBC JavaScript guide](https://arrow.apache.org/adbc/current/javascript/quickstart.html) and [Snowflake ADBC driver documentation](https://adbc-drivers.org/drivers/snowflake/) for driver installation, platform support, and native options. The implementation targets driver manager 0.24.x and Arrow 21.x. Native Snowflake driver installation and account access are application deployment requirements.

## Services, Layers, and composition

Provide the native driver at the application boundary and share one client Layer across repositories:

```ts
import * as Snowflake from "@rc312/effect-snowflake";
import * as AdbcDriver from "@rc312/effect-snowflake/adbc-driver";
import { Config, Effect, Layer } from "effect";

const DatabaseLive = Snowflake.layerConfig({
  account: Config.String("SNOWFLAKE_ACCOUNT"),
  username: Config.String("SNOWFLAKE_USERNAME"),
  password: Config.Redacted("SNOWFLAKE_PASSWORD"),
  warehouse: Config.String("SNOWFLAKE_WAREHOUSE"),
}).pipe(Layer.provide(AdbcDriver.layer));

const program = Snowflake.query("select current_version() as VERSION").pipe(
  Snowflake.withTransaction,
  Effect.provide(DatabaseLive)
);
```

`layer(options)` requires `AdbcDriver`; `layerConfig(config)` reads a `Config` or a record of `Config` fields at acquisition. `layerFrom(acquire)` adapts an application-owned acquisition Effect and preserves its errors and dependencies. The Layer supplies Scope and owns the connection until the consuming program finishes. Reuse the same Layer value when several repository Layers should share one connection. Tests can provide another `AdbcDriver` or `Layer.succeed(Snowflake.Snowflake, client)`.

Use `yield* Snowflake.Snowflake` to capture the client in a repository, or compose the module's `query`, `execute`, and `stream` accessors directly. Client methods have no service requirements; accessors require `Snowflake.Snowflake`. `flow` is useful for a reusable input-to-Effect workflow; `pipe` attaches decoding, transaction scope, and provisioning to a particular Effect. See the [complete composition example](examples/composition.ts).

`Snowflake.withTransaction(effect)` uses the provided service. `client.withTransaction(effect)` uses that particular captured client. Both preserve the Effect's success, errors, and service requirements. A client resolves its current transaction session through a private fiber-local service, so repositories that captured it before the transaction still participate. Different clients and independently started fibers keep their own connection routing. Child fibers started within a transaction inherit its session and must finish before it exits. Nested transactions fail with `operation: "transaction.nested"`; Snowflake does not provide savepoints.

The implementation follows the constructor/Layer separation in [Effect's PostgreSQL adapter](https://github.com/Effect-TS/effect/blob/main/packages/sql/pg/src/PgClient.ts) and the per-client transaction service in [Effect SQL](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/sql/SqlClient.ts). Its transport contract remains Arrow tables and record batches; the core `SqlClient` interface uses row results and SQL-dialect compilation. Native acquisition, session execution, transaction handling, and scope ownership are separate modules here. The existing `make` and `makeWithDriver` factories remain available for callers that own scopes directly.

## Query and execute

```ts
import * as Snowflake from "@rc312/effect-snowflake";
import { tableFromArrays } from "apache-arrow";
import { Config, Effect } from "effect";

const program = Effect.scoped(
  Effect.gen(function* () {
    const db = yield* Snowflake.make({
      account: yield* Config.String("SNOWFLAKE_ACCOUNT"),
      username: yield* Config.String("SNOWFLAKE_USERNAME"),
      authenticator: "auth_jwt",
      privateKey: yield* Config.Redacted("SNOWFLAKE_PRIVATE_KEY"),
      warehouse: yield* Config.String("SNOWFLAKE_WAREHOUSE"),
    });

    const params = tableFromArrays({
      id: new BigInt64Array([9007199254740993n]),
    });
    const table = yield* db.query("select ?::number(38, 0) as ID", params);
    return table;
  })
);
```

Run `program` at your application's existing Effect runtime boundary. `make` is lazy until executed, and its enclosing Scope owns the connection and database. Use `Layer.effect` with an application service tag to share a scoped client. The adapter does not create an application runtime or retry queries.

`query(sql, parameters?)` collects the result into an Arrow table, including the schema of an empty result. `execute(sql, parameters?)` runs DDL/DML and returns the affected row count (`-1` means unknown). Each operation creates and closes a fresh statement. SQL is passed directly to the driver: use `?` placeholders and an Arrow table with columns in placeholder order. Values are never interpolated into SQL. Provide explicit Arrow types when inference would be ambiguous.

ADBC authentication names differ from the Snowflake JavaScript SDK: `auth_snowflake`, `auth_jwt`, `auth_oauth`, `auth_ext_browser`, `auth_okta`, `auth_mfa`, `auth_pat`, and `auth_wif`. Set `password`, `token`, `privateKey`, and `privateKeyPass` with `Redacted` values or `Config.Redacted`. `privateKey` is an inline PKCS#8 PEM; `privateKeyPath` is a plain filesystem path.

Pass additional native options through `databaseOptions`; every value must be `Redacted`, including credential-bearing connection URIs. Explicit named fields override entries in `databaseOptions`. For example:

```ts
import { Redacted } from "effect";

const databaseOptions = {
  "adbc.snowflake.sql.client_option.login_timeout": Redacted.make("30s"),
  "adbc.snowflake.sql.client_option.request_timeout": Redacted.make("60s"),
  "adbc.snowflake.sql.client_option.client_timeout": Redacted.make("30s"),
};
```

## Streaming

```ts
import { Stream } from "effect";

// Inside the Scope that owns db:
const firstBatch = db
  .stream("select * from EVENTS")
  .pipe(Stream.take(1), Stream.runCollect);
```

Streams acquire resources only when consumed. Batches are pulled on demand; there is no adapter-owned prefetch buffer. Native driver prefetch settings still apply. Early termination, errors, and interruption release the Arrow reader before closing its statement. A stream reserves the connection until its consumer releases it. Finish consuming it before starting another operation on the same connection from within that consumer.

Connection operations are serialized, including streamed queries. Use separately scoped clients when parallel connections are required.

## Transactions

```ts
// Inside the Scope that owns db:
const insert = db.transaction((tx) =>
  Effect.gen(function* () {
    yield* tx.execute(
      "insert into EVENTS (ID) values (?)",
      tableFromArrays({ id: [1] })
    );
    yield* tx.execute(
      "insert into EVENTS (ID) values (?)",
      tableFromArrays({ id: [2] })
    );
  })
);
```

Transactions reserve the connection, disable autocommit, and serialize work on the supplied session. Use `tx` inside the callback and await its work. Returning from the callback closes its child scope and expires the session before commit. Typed failures, defects, and interruption trigger rollback. Failed commits also attempt rollback. Successful completion or rollback restores autocommit.

Failed rollback or failed autocommit restoration invalidates the client; no further operation is accepted. Autocommit is never re-enabled after a failed rollback, because doing so could commit pending changes. Cleanup failures are preserved as defects alongside the original failure. Acquire a new client after invalidation.

Captured client methods automatically use the active transaction session on the current fiber. Transactions do not nest; nesting fails with operation `transaction.nested`. Snowflake DDL implicitly commits: use the transaction helper for DML/query work and create tables before the transaction. A transport failure during commit can leave its remote outcome ambiguous; the adapter does not retry it.

## Lifetime, interruption, and errors

The database, connection, statements, and readers have explicit scoped ownership. The client owns a private sequential scope even when its parent scope finalizes in parallel. Scope closure interrupts and joins active operations before closing the connection and database. Failed acquisition closes and detaches its child scope immediately. Client and transaction-session reuse after closure fails.

ADBC JavaScript 0.24 has no cancellation method or `AbortSignal` support. Native acquisition, execution, and batch reads are therefore awaited uninterruptibly before their resources can be released. An Effect interruption or timeout can wait for an in-flight native call to settle. Configure driver login, request, and network timeouts to bound those waits. The adapter cannot guarantee an immediate remote cancellation or a bounded shutdown if native calls never settle.

`SnowflakeError` exposes a safe `operation` and generic `message`. Raw driver messages, SQL, binds, connection options, and native error causes are excluded. Public operations have tracing spans without sensitive query attributes. Driver logging is configured by the application and is outside this adapter's error sanitization.

For a custom loader or deterministic test, use `makeWithDriver` with the `AdbcDriver` service from `@rc312/effect-snowflake/adbc-driver`. This structural boundary replaces only native resources; Arrow processing and Effect ownership remain real. `make` supplies the default native loader automatically.

## Runnable examples and live E2E tests

The [examples guide](examples/README.md) includes environment setup and complete Node entrypoints for Arrow parameter binding, full and early stream consumption, and transactions. The live suite imports those same scenarios and additionally checks empty-result schemas and closed-client reuse.

```sh
bun run --cwd packages/effect-snowflake example:check
bun run --cwd packages/effect-snowflake example:query
bun run --cwd packages/effect-snowflake example:stream
bun run --cwd packages/effect-snowflake example:transaction
bun run --cwd packages/effect-snowflake example:composition
# After configuring credentials and setting SNOWFLAKE_E2E=1:
bun run --cwd packages/effect-snowflake test:e2e
```

The examples read the package-local `.env` at the Node entrypoint. The configuration check validates settings without connecting. Live tests are skipped unless explicitly enabled; they use independent sessions and a temporary table, and require a reachable Snowflake account, a warehouse, and appropriate schema privileges.

## Development

From the workspace root:

```sh
bun run --cwd packages/effect-snowflake build
bun run --cwd packages/effect-snowflake typecheck
bun run --cwd packages/effect-snowflake test
bun run --cwd packages/effect-snowflake test:coverage
bun run lint
```

Unit tests use real Arrow IPC and controlled native resources for precision, acquisition and reader failures, serialized work, combined cleanup causes, transaction interruption, scope retirement, and tracing redaction. The examples and E2E sources are included in typechecking. Coverage reports are written under the package's ignored `coverage/` directory; the live suite runs separately from ordinary unit tests.

The lifecycle ownership helpers were adapted from the provided `effect-extensions-copy/src/waddler/snowflake.ts` reference implementation.
