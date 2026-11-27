# @rc312/effect-snowflake

## 0.3.0

### Minor Changes

- Export `SnowflakeOperation` for the built-in error labels. Existing values and custom driver labels are still supported.

  Add an optional `onOutcome` observer to `transaction` and `withTransaction`. It reports the driver's acknowledgments, ambiguous outcomes, and whether the connection can be reused after finalization. A caller can observe a confirmed commit even if its transaction Effect was interrupted.

  Interrupted queries finish the current Arrow read, then close the reader without reading more batches.

## 0.2.0

### Minor Changes

- Upgrade Effect support to 4.1.2 and require Node.js 22.19 or newer to match Effect's runtime requirements.

  Effect 4.1 promotes typed failures to defects when combined with cleanup defects. Snowflake transaction failures retain both the original error and the cleanup error in the combined Cause.

## 0.1.0

### Minor Changes

- fc1d925: Add an Effect 4 Snowflake client using Apache Arrow ADBC, with scoped resources, Arrow parameter binding, batch streaming, serialized operations, and transactions.
