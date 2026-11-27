# @rc312/effect-aws-imds

## 0.2.1

### Patch Changes

- 56e4c81: Raise the minimum supported Effect version to 4.1.7 and update Effect's Vitest integration to 4.1.7.

## 0.2.0

### Minor Changes

- Upgrade Effect support to 4.1.2 and require Node.js 22.19 or newer to match Effect's runtime requirements.

  Effect 4.1 promotes typed failures to defects when combined with cleanup defects.

## 0.1.0

### Minor Changes

- 58115e3: Add an Effect-native IMDSv2 client composed from replaceable `AwsImdsConfig`, `AwsImdsToken`, `AwsImds`, and `InstanceIdentity` layers, with cached and redacted session tokens, per-attempt timeouts, `Schedule`-based transient retries, typed failures, and `getSchema` and `optional` combinators.
