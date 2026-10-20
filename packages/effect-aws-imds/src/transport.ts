import { Effect, Redacted } from "effect";
import {
  Headers,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
} from "effect/http";

import type { AwsImdsSettings } from "./config.ts";
import type { AwsImdsToken } from "./token.ts";

const TOKEN_HEADER = "x-aws-ec2-metadata-token";
const UNAUTHORIZED = 401;

// Redacts the session token from client spans that capture request headers.
const redactTokenHeader = Effect.updateService(
  Headers.CurrentRedactedNames,
  (names) => [...names, TOKEN_HEADER]
);

/**
 * IMDS transport policy for any `HttpClient`: the endpoint as base URL, a
 * timeout on each attempt including its text body, non-2xx statuses as errors,
 * and transient retries on `settings.retrySchedule`.
 *
 * @since 0.1.0
 */
const imdsTransport =
  (settings: AwsImdsSettings) =>
  <E, R>(client: HttpClient.HttpClient.With<E, R>) =>
    client.pipe(
      HttpClient.mapRequest(HttpClientRequest.prependUrl(settings.endpoint)),
      HttpClient.filterStatusOk,
      // HTTP responses memoize their text, so callers can read it again after
      // the complete download has succeeded within the attempt's deadline.
      HttpClient.tap((response) => response.text),
      HttpClient.transformResponse(Effect.timeout(settings.attemptTimeout)),
      HttpClient.retryTransient({
        schedule: settings.retrySchedule,
        // Reading the text body can fail after headers have already arrived.
        // Schema/JSON decoding happens outside this transport policy.
        while: (error) =>
          HttpClientError.isHttpClientError(error) &&
          error.reason instanceof HttpClientError.DecodeError,
      })
    );

const isUnauthorized = <E>(error: E) =>
  HttpClientError.isHttpClientError(error) &&
  error.response?.status === UNAUTHORIZED;

/**
 * Wraps a client so every request carries a session token. The token is
 * resolved before the request, outside its timeout and transient retries; a
 * `401` invalidates that token and the request runs once more with a new one.
 *
 * Apply it after `imdsTransport`: the transport's timeout and retries then
 * cover each metadata request, while time spent obtaining the token does not
 * count against them.
 *
 * @since 0.1.0
 */
const withSessionToken =
  (token: AwsImdsToken["Service"]) =>
  <E, R>(client: HttpClient.HttpClient.With<E, R>) => {
    const attempt = (request: HttpClientRequest.HttpClientRequest) =>
      token.get.pipe(
        Effect.flatMap((sessionToken) =>
          client
            .execute(
              HttpClientRequest.setHeader(
                request,
                TOKEN_HEADER,
                Redacted.value(sessionToken)
              )
            )
            .pipe(
              redactTokenHeader,
              Effect.tapError((failure) =>
                isUnauthorized(failure)
                  ? token.invalidate(sessionToken)
                  : Effect.void
              )
            )
        )
      );

    return HttpClient.makeWith(
      (request: Effect.Effect<HttpClientRequest.HttpClientRequest>) =>
        request.pipe(
          Effect.flatMap((prepared) =>
            attempt(prepared).pipe(
              Effect.retry({ times: 1, while: isUnauthorized })
            )
          )
        ),
      Effect.succeed
    );
  };

export { imdsTransport, TOKEN_HEADER, withSessionToken };
