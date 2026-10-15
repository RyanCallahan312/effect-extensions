# Streams

Read this whenever implementation uses `Stream`. A `Stream<A, E, R>` is lazy and
pull-based: a `run*` destructor starts acquisition, demand, and finalization.
Keep data streaming until the consumer boundary; do not collect just to use array
helpers. Use [scheduling](./scheduling.md) for a repeated effect with no emitted
values.

## Sources and transforms

| Need | API |
|---|---|
| Effect, iterable, async iterable | `fromEffect`, `fromIterable`, `fromAsyncIterable` |
| Polling or ticks | `fromEffectSchedule`, `fromSchedule` |
| Paginated pull API | `paginate` |
| Callback/event boundary | `callback` |
| Queue or PubSub | `fromQueue`, `fromPubSub` |

Map foreign failures to domain errors at the source and keep reader/socket opening
lazy. `paginate` fetches only on downstream demand; terminate with
`Option.none()` and reject non-advancing cursors that could loop forever.

- `map` / `filter`: pure work.
- `mapEffect`: one effectful result per input.
- `flatMap`: zero or more streamed outputs per input.
- `decodeText`, `splitLines`, and `pipeThroughChannel`: incremental body parsing.
- `mapError`, `catchTag`, and `catch`: typed stream error handling.

Finite `concurrency` is opt-in. `mapEffect` preserves input order unless
`unordered: true`; concurrent `flatMap` emits as inner streams complete. Do not
use `"unbounded"` for remote calls or user-controlled input.

## Backpressure, fan-out, and lifecycle

Natural pull demand is backpressure. `Stream.buffer` decouples rates but does not
increase end-to-end throughput: choose finite capacity and default `"suspend"`
for lossless work; use `"dropping"` or `"sliding"` only when loss is product
semantics. Unbounded buffers risk memory exhaustion.

Use scoped `broadcast` or `share` when one cold upstream must execute once for
multiple consumers. Select replay, capacity, and overflow policy deliberately;
never return a scope-owned subscription after its Scope closes.

Callback producers must register and unregister in `Effect.acquireRelease` and
choose a bounded `bufferSize`. Wrapping a push source does not make it safely
pull-based. Long-lived consumers belong in their owning Layer and run with
`Effect.forkScoped`.

## Consume at the boundary

| Goal | Destructor |
|---|---|
| Per-value effects | `runForEach` |
| Drain | `runDrain` |
| Reduce | `runFold` / `runFoldEffect` |
| Known small finite result | `runCollect` |
| Reusable consumer protocol | `run` with `Sink` |

Bound a potentially infinite stream with `take`, `takeWhile`, `takeUntil`, a
timeout, or equivalent before `runCollect`. Handle typed failures before exposing
native `ReadableStream` / async-iterable boundaries, where `E` becomes rejected
reads or thrown iteration errors.

For a useful stream tracing boundary, attach definition-site `Stream.withSpan`
covering its full lazy pipeline. Do not use `Effect.withSpan`
as a substitute or defer the Stream span to the caller.

`catchCauseIf` is for an explicit stream-supervision boundary only. Item-level
expected failures use typed recovery; defects and interruption remain visible to
the owner unless its supervision policy says otherwise.

Read installed `effect/ai-docs/src/03_stream/` for source and consumer examples.
