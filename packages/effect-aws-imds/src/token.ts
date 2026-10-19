import {
  Cache,
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  Redacted,
  Schema,
} from "effect";
import { HttpClient } from "effect/http";

import { AwsImdsConfig } from "./config.ts";
import { cacheOnSuccess, failureDetails } from "./internal.ts";
import { AwsImdsTokenError } from "./token-error.ts";
import { imdsTransport, TOKEN_HEADER } from "./transport.ts";

const TOKEN_PATH = "/latest/api/token";
const TOKEN_TTL_HEADER = "x-aws-ec2-metadata-token-ttl-seconds";
const MIN_TTL_SECONDS = 1;
const MAX_TTL_SECONDS = 21_600;
const REFRESH_MARGIN = Duration.seconds(30);

const decodeToken = Schema.decodeEffect(
  Schema.NonEmptyString.annotate({ description: "IMDSv2 session token" })
);

const ttlSeconds = (ttl: Duration.Duration) =>
  Math.min(
    MAX_TTL_SECONDS,
    Math.max(MIN_TTL_SECONDS, Math.floor(Duration.toSeconds(ttl)))
  );

// Refresh 30 seconds early, or halfway through a short-lived token.
const refreshAfter = (ttl: Duration.Duration) =>
  Duration.max(
    Duration.subtract(ttl, REFRESH_MARGIN),
    Duration.divideUnsafe(ttl, 2)
  );

const toTokenError = (cause: Error) =>
  new AwsImdsTokenError(failureDetails(cause));

/**
 * IMDSv2 session tokens.
 *
 * - `get` returns the cached token, requesting one with `PUT /latest/api/token`
 *   when none is cached or the cached one is close to expiry.
 * - `invalidate(token)` discards `token` if it is still the cached one, so
 *   concurrent reads that were all rejected trigger a single refresh.
 * - `clear` discards the cached token unconditionally.
 *
 * Provide your own implementation with `Layer.succeed` to use a fixed token.
 *
 * @since 0.1.0
 */
class AwsImdsToken extends Context.Service<
  AwsImdsToken,
  {
    readonly get: Effect.Effect<Redacted.Redacted<string>, AwsImdsTokenError>;
    readonly invalidate: (
      rejected: Redacted.Redacted<string>
    ) => Effect.Effect<void>;
    readonly clear: Effect.Effect<void>;
  }
>()("@rc312/effect-aws-imds/AwsImdsToken") {
  /** Requests tokens through the `HttpClient`, configured by `AwsImdsConfig`. */
  static readonly layer: Layer.Layer<
    AwsImdsToken,
    never,
    HttpClient.HttpClient
  > = Layer.effect(
    AwsImdsToken,
    Effect.gen(function* make() {
      const settings = yield* AwsImdsConfig;
      const seconds = ttlSeconds(settings.tokenTtl);

      const client = (yield* HttpClient.HttpClient).pipe(
        imdsTransport(settings)
      );

      const fetchToken = client
        .put(TOKEN_PATH, { headers: { [TOKEN_TTL_HEADER]: String(seconds) } })
        .pipe(
          Effect.flatMap((response) => response.text),
          Effect.flatMap((text) => decodeToken(text)),
          Effect.map((token) => Redacted.make(token, { label: TOKEN_HEADER })),
          Effect.mapError(toTokenError),
          Effect.withSpan("AwsImdsToken.fetch")
        );

      const tokens = yield* Cache.makeWith(() => fetchToken, {
        capacity: 1,
        timeToLive: cacheOnSuccess(refreshAfter(Duration.seconds(seconds))),
      });

      const current = Cache.get(tokens, TOKEN_PATH);
      const clear = Cache.invalidate(tokens, TOKEN_PATH);

      return AwsImdsToken.of({
        clear,
        get: current,
        invalidate: (rejected) =>
          Cache.getSuccess(tokens, TOKEN_PATH).pipe(
            Effect.flatMap((cached) =>
              Option.contains(cached, rejected) ? clear : Effect.void
            )
          ),
      });
    })
  );
}

export { AwsImdsToken };
