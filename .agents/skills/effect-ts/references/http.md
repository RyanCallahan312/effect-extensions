# HTTP Clients

Read this only for outgoing HTTP from Effect code. Use `effect/http`; verify
imports and Layer requirements against installed 4.0.5 source.

## Choose

- Use `HttpClient` for Effect application and provider boundaries. Construct an
  immutable request, attach headers/auth, execute it, classify its status, then
  decode the body with Schema.
- Use `HttpClientRequest` transforms for reusable base URL, auth, and request
  policy; use a named `Effect.fn` for a provider-specific operation.
- Use `HttpClientResponse.schemaJson` or `schemaNoBody` when their response
  shape matches the boundary. Use `HttpIncomingMessage.schemaBodyJson` when only
  the JSON body should be decoded. Decode unknown bodies exactly once.
- Use `HttpClient.filterStatusOk` or `HttpClientResponse.filterStatusOk` only
  when non-2xx means failure for this operation. Classify provider-specific
  statuses explicitly otherwise.
- Use `HttpClient.retryTransient` for an idempotent request with its standard
  transient policy. Use operation-level retry when idempotency or retryability
  depends on a typed provider error.
- Use `HttpClient.withRateLimiter` when provider rate-limit headers should pace
  the whole client; provide its required `RateLimiter` as runtime wiring.

## Rules

- Keep request construction, auth, execution, status classification, decoding,
  typed-error translation, and retry policy in the adapter boundary. Do not
  hold a database transaction across a network call.
- Preserve transport, HTTP-status, and decode failures until the feature
  boundary deliberately maps them to domain errors.
- Redact authorization headers, cookies, credentials, sensitive query values,
  and unbounded provider bodies from logs and span attributes.
- Give exported adapter operations a hierarchical `Effect.fn` name.

## Do not

- Do not call global `fetch` inside an Effect operation. Use the `HttpClient`
  service so transport failures, cancellation, and test doubles remain typed.
- Do not retry non-idempotent writes without an explicit provider-supported
  idempotency key and classified transient failure policy.
- Do not decode a success schema before deciding whether the response status is
  a success for the operation.

Pinned starting points:

- `packages/tss-effect-serverfn/node_modules/effect/src/http/HttpClient.ts`
- `packages/tss-effect-serverfn/node_modules/effect/src/http/HttpClientRequest.ts`
- `packages/tss-effect-serverfn/node_modules/effect/src/http/HttpClientResponse.ts`
- `packages/tss-effect-serverfn/node_modules/effect/src/http/HttpClientError.ts`
