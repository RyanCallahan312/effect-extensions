# Runtime and Observability

Read this only for process entrypoints, framework interop, shutdown, or
telemetry. Effects run at boundaries, never from domain logic or services.

## Choose

- Use `BunRuntime.runMain(program)` for a Bun process program only when a
  compatible `@effect/platform-bun` package is installed (it is not currently).
- Use `BunRuntime.runMain(Layer.launch(AppLive))` for a long-running Layer
  application whose scope should live for the process.
- Use one `ManagedRuntime.make(AppLive)` for repeated framework callbacks;
  execute requests through it and dispose it during framework shutdown.
- Use a matching runtime runner only at a small Promise, callback, test, script,
  or framework boundary. `runSync` is only valid for a guaranteed-synchronous
  Effect.

## Rules

- Build and provide Layers near the runtime boundary. Reuse one Layer value when
  its scoped resources must be shared; dispose the `ManagedRuntime` that owns
  them.
- Inside Effect operations use `Config`, `Clock` / `DateTime`, `Random`, the
  platform `Crypto` service, and `HttpClient`, not environment, clock, timer,
  UUID, randomness, or fetch globals.
- Name useful Effect tracing boundaries with `Effect.fn("Domain.operation")`
  and stream tracing boundaries with `Stream.withSpan("Domain.stream")`.
  Prefer `Effect.fnUntraced` for library glue that should not add tracing.
- Annotate spans and logs with stable, bounded domain identifiers. Redact
  credentials, tokens, personal data, and unbounded request or response bodies.

## Do not

- Do not call a runtime runner from a service implementation, generator, or
  reusable domain operation.
- Do not create one `ManagedRuntime` per request or neglect its shutdown
  disposal.
- Do not impose application tracing or runtime ownership on library consumers.

Use `effect/observability` for built-in Otlp modules. `@effect/opentelemetry`
is not installed here; do not assume its exporter Layers are available. Verify
existing application setup before introducing a second telemetry pipeline.

Pinned starting points:

- `packages/tss-effect-serverfn/node_modules/effect/src/ManagedRuntime.ts`
- `packages/tss-effect-serverfn/node_modules/effect/src/observability/`
- `packages/tss-effect-serverfn/src/boundary.server.ts` (framework execution)
