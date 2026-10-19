import { Duration, Exit } from "effect";
import { HttpClientError } from "effect/http";

// Keep only the message and status: client errors retain the request headers.
const failureDetails = (cause: Error) => {
  const status = HttpClientError.isHttpClientError(cause)
    ? cause.response?.status
    : undefined;

  return status === undefined
    ? { message: cause.message }
    : { message: cause.message, status };
};

// `Effect.cachedWithTTL` would also cache failures; IMDS failures are transient.
const cacheOnSuccess =
  (ttl: Duration.Duration) =>
  <A, E>(exit: Exit.Exit<A, E>) =>
    Exit.isSuccess(exit) ? ttl : Duration.zero;

export { cacheOnSuccess, failureDetails };
