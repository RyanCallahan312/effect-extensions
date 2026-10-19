---
"@rc312/effect-aws-imds": minor
---

Add an Effect-native IMDSv2 client composed from replaceable `AwsImdsConfig`, `AwsImdsToken`, `AwsImds`, and `InstanceIdentity` layers, with cached and redacted session tokens, per-attempt timeouts, `Schedule`-based transient retries, typed failures, and `getSchema` and `optional` combinators.
