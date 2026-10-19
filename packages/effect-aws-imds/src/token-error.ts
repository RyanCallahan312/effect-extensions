import { Schema } from "effect";

/**
 * Failure to obtain an IMDSv2 session token.
 *
 * `status` is the HTTP status when IMDS answered the token request with a
 * non-2xx response. Transport, timeout, and decoding failures have no `status`.
 *
 * @since 0.1.0
 */
// oxlint-disable-next-line unicorn/throw-new-error -- TaggedError is a class factory.
export class AwsImdsTokenError extends Schema.TaggedError<
  AwsImdsTokenError,
  { readonly brand: unique symbol }
>()("AwsImdsTokenError", {
  message: Schema.String,
  status: Schema.optional(Schema.Int),
}) {}
