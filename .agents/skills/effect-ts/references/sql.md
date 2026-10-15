# Effect SQL and Drizzle

Read this only for `effect/sql`, `@effect/sql-pg`, or Effect-native
Drizzle. Inspect installed source before using an unfamiliar API. No SQL driver
or Drizzle package is currently installed in this repository.

## Choose

- Put driver and pool wiring behind an application-owned service, not inside
  this server-function integration library.
- Use yieldable Effect-native Drizzle builders only if a compatible integration
  is installed; do not assume ordinary Drizzle builders are Effect-native.
- Use `SqlClient.SqlClient` for driver-agnostic raw SQL. Tagged-template values
  are parameters; use `sql("identifier")` only for an escaped identifier.
- Use `SqlSchema.findAll`, `findOne`, or `findOneOption` when raw driver rows
  need runtime Schema decoding. A SQL result generic is not runtime validation.
- Use `sql.withTransaction` for one domain operation spanning statements, after
  confirming its driver support and retry semantics.

## Rules

- Map `SqlError` and Effect Drizzle errors to typed domain errors at the
  repository boundary; retain the original cause only as safe diagnostics.
- Retry only classified, retryable failures where the whole transaction is safe
  to repeat. Design external writes and messages for idempotency instead.
- Let the Layer own pool acquisition and teardown. Keep connection URLs and
  passwords `Redacted` / `Config.Redacted`.
- Use parameterization by default. `sql.unsafe` and `sql.literal` require
  trusted, non-user-controlled SQL text.

## Do not

- Do not wrap Effect-native Drizzle builders in `Promise`, `tryPromise`, or an
  ambient database client.
- Do not assume driver or Drizzle Layer constructors without checking their
  own installed version and public exports.
- Do not treat compile-time row types as a trust boundary.

Pinned starting points:

- `packages/tss-effect-serverfn/node_modules/effect/src/sql/SqlClient.ts`
- `packages/tss-effect-serverfn/node_modules/effect/src/sql/SqlSchema.ts`
- `packages/tss-effect-serverfn/node_modules/effect/src/sql/SqlError.ts`
- The installed driver package's `src/` and `package.json`, when added.
