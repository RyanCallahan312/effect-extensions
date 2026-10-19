/**
 * Effect-native client for the AWS EC2 Instance Metadata Service (IMDS).
 *
 * The client speaks IMDSv2 only. Session tokens are fetched with `PUT
 * /latest/api/token`, cached for slightly less than their TTL, and refreshed
 * once when IMDS answers `401`. Every attempt has its own timeout, and transient
 * failures are retried with jittered exponential backoff.
 *
 * The instance identity document is decoded against `IdentityDocument` and
 * memoized after the first success. Failures are never cached, so a caller can
 * try again later.
 *
 * Outside EC2 (local development, or a container beyond the IMDS hop limit)
 * operations fail with a typed `AwsImdsError` rather than returning `undefined`.
 * Apply `Effect.option` at the call site when the value is genuinely optional.
 * With the defaults, an endpoint that never answers fails after about 3.2
 * seconds (three 1 second attempts plus backoff); a refused connection fails
 * within a fraction of a second.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import * as AwsImds from "@rc312/effect-aws-imds"
 *
 * const program = Effect.gen(function* () {
 *   const document = yield* AwsImds.identityDocument
 *   const instanceType = yield* AwsImds.get("/latest/meta-data/instance-type")
 *   return { region: document.region, instanceType }
 * })
 *
 * const runnable = program.pipe(Effect.provide(AwsImds.layerFetch))
 * ```
 *
 * @since 0.1.0
 */
export {
  AwsImds,
  type AwsImdsError,
  get,
  getSchema,
  optional,
} from "./aws-imds.ts";

export {
  AwsImdsConfig,
  type AwsImdsOptions,
  type AwsImdsSettings,
  retryPolicy,
} from "./config.ts";

export { IdentityDocument } from "./identity-document.ts";

export { identityDocument, InstanceIdentity } from "./instance-identity.ts";

export { clearCache, layer, layerFetch } from "./layer.ts";

export { AwsImdsToken } from "./token.ts";

export { imdsTransport, withSessionToken } from "./transport.ts";

export { AwsImdsMetadataError } from "./metadata-error.ts";

export { AwsImdsTokenError } from "./token-error.ts";
