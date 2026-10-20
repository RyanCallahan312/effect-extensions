# Snowflake ADBC examples

These are Node.js programs that import the built `@rc312/effect-snowflake` public API. They use the same configuration and scenario functions as the [live E2E suite](../e2e/snowflake.test.ts).

## Setup

From the repository root, install dependencies and the native Snowflake driver:

```sh
bun install
npm install -g @columnar-tech/dbc
dbc install snowflake
cp packages/effect-snowflake/examples/.env.example packages/effect-snowflake/.env
```

Edit `packages/effect-snowflake/.env` for a development account, warehouse, database, and schema. The template uses JWT authentication and a private-key file path. For inline keys, remove `SNOWFLAKE_PRIVATE_KEY_PATH` and set `SNOWFLAKE_PRIVATE_KEY` to a PKCS#8 PEM. `SNOWFLAKE_PRIVATE_KEY_PASS` supplies an encrypted inline key's passphrase. For password authentication, set `SNOWFLAKE_AUTHENTICATOR=auth_snowflake` and `SNOWFLAKE_PASSWORD`; for OAuth use `auth_oauth` and `SNOWFLAKE_TOKEN`.

The examples need Node.js 22.12+ and Bun for workspace build scripts. The Node entrypoints load the package-local `.env` using `--env-file-if-exists`; exported environment variables take precedence. Real `.env` files are ignored by Git. Do not commit credentials. Secrets are loaded through `Config.Redacted`, and the configuration check never prints their values.

If manifest discovery is unavailable, set `SNOWFLAKE_ADBC_DRIVER` to the absolute path of an installed driver library or manifest. The shared configuration sets native login and network timeouts to 30 seconds and request retries to 60 seconds. These bound individual native operations; they are not an overall scenario deadline.

## Run

All commands below run from the repository root and build the library and examples before starting Node:

```sh
# Check environment configuration without loading the native addon or connecting.
bun run --cwd packages/effect-snowflake example:check

# Bind int64, text, boolean, and a typed null; decode one Arrow row.
bun run --cwd packages/effect-snowflake example:query

# Drain a stream, stop another after one nonempty batch, and reuse the connection.
bun run --cwd packages/effect-snowflake example:stream

# Commit one insert and roll another back using a session-temporary table.
bun run --cwd packages/effect-snowflake example:transaction

# Compose a service accessor, Arrow binding, decoding, and a transaction with flow.
bun run --cwd packages/effect-snowflake example:composition
```

The query example casts the int64 result to VARCHAR before decoding it, preserving the exact value `9007199254740993`. It uses explicit Arrow types and places parameter columns in SQL placeholder order. Values containing SQL punctuation remain bind values.

The streaming example counts 1,000 generated rows and then consumes one nonempty batch from a 100,000-row result. Batch size is driver-controlled, so the first batch may contain the entire result. It finishes that consumer before executing the follow-up query on the same connection.

The transaction example creates `EFFECT_SNOWFLAKE_EXAMPLE` as a temporary table before either transaction, because Snowflake DDL implicitly commits. It commits ID 1, rolls back ID 2 with a typed failure, reads back only ID 1, and drops the table in a finalizer. It requires permission to create temporary tables in the configured schema. Each run uses its own session, and no application table is modified. Warehouse queries can incur Snowflake usage charges.

The application boundary in `run.ts` provides a shared Snowflake service Layer and an explicit native driver Layer. It captures configuration once, keeps the connection alive for the whole program, prints only the result, and exits unsuccessfully if acquisition, execution, decoding, or cleanup fails. `composition.ts` uses `flow` and `Snowflake.withTransaction`; `scenarios.ts` also demonstrates the captured client's `withTransaction` combinator. ADBC JS has no native cancellation API; interruption waits for in-flight native work to settle before releasing its resources.

## Live E2E checks

Set `SNOWFLAKE_E2E=1` in the package-local `.env` or exported environment, then run:

```sh
bun run --cwd packages/effect-snowflake test:e2e
```

The suite checks the actual native Snowflake path for parameter precision, full and early stream consumption, connection reuse, committed and rolled-back data, empty-result schema, and retained-client rejection after scope closure. Every case acquires its own connection. The temporary table is scoped to its session and dropped explicitly.

Without `SNOWFLAKE_E2E=1`, the suite reports its live cases as skipped. When enabled, missing configuration, missing drivers, authentication failures, and incorrect results fail the suite. Tests have a two-minute harness timeout, but the adapter still must await a non-cancellable native operation during cleanup; a hung native driver can outlast the harness timeout. These checks are separate from the ordinary credential-free unit tests.

## Test and inspect coverage

```sh
bun run --cwd packages/effect-snowflake typecheck
bun run --cwd packages/effect-snowflake test:cli
bun run --cwd packages/effect-snowflake test:coverage
```

The ordinary test command also runs compiled Node entrypoints as subprocesses, checking configuration validation, sanitized native errors, exit codes, and E2E opt-in behavior without credentials.

Coverage enforces at least 95% lines, statements, and functions, and 90% branches for the library sources. The coverage command writes a terminal summary, `coverage/coverage-summary.json`, and `coverage/index.html`. Unit tests use real Arrow IPC and controlled native-resource implementations with deterministic Promise and Effect gates. They cover asynchronous driver failures, scope retirement, delayed native acquisition and reads, combined failure causes, reader teardown, transaction rollback, configuration, and tracing redaction.
