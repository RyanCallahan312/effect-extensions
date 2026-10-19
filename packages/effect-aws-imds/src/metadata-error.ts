import { Schema } from "effect";

/**
 * Failure to read or decode the metadata at `path`.
 *
 * `status` is the HTTP status when IMDS answered with a non-2xx response, for
 * example `404` for a path that does not exist on this instance. Transport,
 * timeout, and decoding failures have no `status`. The underlying request is
 * not retained because its headers carry the session token.
 *
 * @since 0.1.0
 */
// oxlint-disable-next-line unicorn/throw-new-error -- TaggedError is a class factory.
export class AwsImdsMetadataError extends Schema.TaggedError<
  AwsImdsMetadataError,
  { readonly brand: unique symbol }
>()("AwsImdsMetadataError", {
  message: Schema.String,
  path: Schema.String,
  status: Schema.optional(Schema.Int),
}) {}
