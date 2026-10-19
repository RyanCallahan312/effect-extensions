import { Context, Effect, flow, Layer, Schema } from "effect";
import { HttpClient } from "effect/http";

import { AwsImdsConfig } from "./config.ts";
import { failureDetails } from "./internal.ts";
import { AwsImdsMetadataError } from "./metadata-error.ts";
import { AwsImdsTokenError } from "./token-error.ts";
import { AwsImdsToken } from "./token.ts";
import { imdsTransport, withSessionToken } from "./transport.ts";

const NOT_FOUND = 404;

/**
 * Any failure produced by the IMDS services.
 *
 * @since 0.1.0
 */
type AwsImdsError = AwsImdsMetadataError | AwsImdsTokenError;

const metadataError = (path: string) => (cause: Error) =>
  new AwsImdsMetadataError({ ...failureDetails(cause), path });

// Token failures surface as themselves; everything else is about `path`.
const toImdsError = (path: string) => (cause: Error) =>
  cause instanceof AwsImdsTokenError ? cause : metadataError(path)(cause);

/**
 * Reads instance metadata through IMDSv2. Reads are not cached.
 *
 * `get(path)` returns the raw text at a path such as
 * `/latest/meta-data/instance-id`.
 *
 * @since 0.1.0
 */
class AwsImds extends Context.Service<
  AwsImds,
  {
    readonly get: (path: string) => Effect.Effect<string, AwsImdsError>;
  }
>()("@rc312/effect-aws-imds/AwsImds") {
  /** Reads through the `HttpClient` with tokens from `AwsImdsToken`. */
  static readonly layer: Layer.Layer<
    AwsImds,
    never,
    AwsImdsToken | HttpClient.HttpClient
  > = Layer.effect(
    AwsImds,
    Effect.gen(function* make() {
      const settings = yield* AwsImdsConfig;
      const token = yield* AwsImdsToken;

      const client = (yield* HttpClient.HttpClient).pipe(
        imdsTransport(settings),
        withSessionToken(token)
      );

      return AwsImds.of({
        get: (path) =>
          client.get(path).pipe(
            Effect.flatMap((response) => response.text),
            Effect.mapError(toImdsError(path)),
            Effect.withSpan("AwsImds.get", {
              attributes: { "aws.imds.path": path },
            })
          ),
      });
    })
  );
}

/** Decodes metadata text with `codec`, attributing failures to `path`. */
const decodeAt = <A, RD>(path: string, codec: Schema.Codec<A, string, RD>) =>
  flow(
    (text: string) => Schema.decodeEffect(codec)(text),
    Effect.mapError(metadataError(path))
  );

/**
 * Reads the raw text at a metadata path.
 *
 * @since 0.1.0
 */
const get = (path: string) => AwsImds.use((imds) => imds.get(path));

/**
 * Reads a metadata path and decodes its text with `codec`, for example
 * `Schema.fromJsonString(MySchema)` for a JSON document.
 *
 * @since 0.1.0
 */
const getSchema = <A, RD>(path: string, codec: Schema.Codec<A, string, RD>) =>
  get(path).pipe(Effect.flatMap(decodeAt(path, codec)));

const isNotFound = <E>(error: E) =>
  error instanceof AwsImdsMetadataError && error.status === NOT_FOUND;

/**
 * Turns a `404` from IMDS into `Option.none()` and a success into
 * `Option.some`. Every other failure is kept.
 *
 * @example
 * ```ts
 * const action = AwsImds.get("/latest/meta-data/spot/instance-action").pipe(
 *   AwsImds.optional
 * )
 * ```
 *
 * @since 0.1.0
 */
const optional = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  self.pipe(
    Effect.asSome,
    Effect.catchIf(isNotFound, () => Effect.succeedNone)
  );

export { AwsImds, decodeAt, get, getSchema, optional };

export type { AwsImdsError };
