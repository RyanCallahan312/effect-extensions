import { Schema } from "effect";

/**
 * Sanitized native failure with an operation label and a generic message.
 * Raw native messages, SQL, bind values, credentials, and original causes are
 * intentionally excluded. Operation failures use the typed error channel;
 * cleanup failures are promoted to defects while preserving the original Cause.
 * @since 0.1.0
 */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory.
export class SnowflakeError extends Schema.TaggedError<
  SnowflakeError,
  { readonly brand: unique symbol }
>()("SnowflakeError", { message: Schema.String, operation: Schema.String }) {}

export const failure = (operation: string) => () =>
  new SnowflakeError({ message: `Snowflake ${operation} failed`, operation });
