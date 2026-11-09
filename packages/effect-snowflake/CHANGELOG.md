# @rc312/effect-snowflake

## 0.2.0

### Minor Changes

- Upgrade Effect support to 4.1.2 and require Node.js 22.19 or newer to match Effect's runtime requirements.

  Effect 4.1 promotes typed failures to defects when combined with cleanup defects. Snowflake transaction failures retain both the original error and the cleanup error in the combined Cause.

## 0.1.0

### Minor Changes

- fc1d925: Add an Effect 4 Snowflake client using Apache Arrow ADBC, with scoped resources, Arrow parameter binding, batch streaming, serialized operations, and transactions.
