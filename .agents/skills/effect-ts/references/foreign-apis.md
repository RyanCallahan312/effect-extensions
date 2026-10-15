# Foreign API Adapters

Use this only when adapting synchronous, Promise, callback, event, stream, or
async-iterable APIs into Effect. Keep the adapter small: translate failure,
cancellation, and lifetime once, then keep the feature Effect-native.

## Choose the Boundary Adapter

| Foreign API | Use |
|---|---|
| Cannot throw | `Effect.sync` |
| May throw synchronously | `Effect.try({ try, catch })` |
| Returns a Promise or may throw before returning one | `Effect.tryPromise({ try, catch })` |
| Reports one callback result | `Effect.callback` |
| Reports many values | `Stream.callback` |

Map every unknown cause immediately into a domain error, normally a local
`Data.TaggedError`. Use `Schema.TaggedError` instead when the adapter error
is serialized across an HTTP, RPC, workflow, persistence, or other boundary.

```ts
import { Data, Effect } from "effect"

class RequestError extends Data.TaggedError("RequestError")<{
  readonly url: string
  readonly cause: unknown
}> {}

declare const request: (url: string, signal: unknown) => Promise<unknown>

export const response = Effect.tryPromise({
  try: (signal) => request("https://example.test", signal),
  catch: (cause) => new RequestError({
    url: "https://example.test",
    cause
  })
})
```

Prefer `tryPromise` for foreign
Promises, even if an API claims it cannot reject. Pass its supplied `AbortSignal`
to cancellation-aware APIs. Do not wrap an Effect-native API or yieldable query
builder.

## Callbacks, Events, and Streams

Use `Effect.callback` for a single completion and return the foreign cancellation
finalizer when one exists. Use `Stream.callback` for repeated values; acquire the
listener in stream scope and remove it when that scope closes. Do not let a
listener, timer, or subscription outlive its Effect scope.

Use `Stream.fromAsyncIterable` for async iterables. For Node, Bun, and Web native
streams, use an installed, compatible platform adapter. Translate foreign errors at this edge
instead of exposing `unknown` downstream.
