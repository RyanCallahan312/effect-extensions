# Caching and Memoization

Read this for keyed TTL caches, repeated expensive values, concurrent request
deduplication, or request batching.

Use `Cache` instead of a `Map` plus timestamp, prune loop, and in-flight map when
keyed memoization fits. `Cache.make({ capacity, lookup, timeToLive })` has a
fixed TTL; `Cache.makeWith(lookup, { capacity, timeToLive(exit, key) })` chooses
TTL from each lookup `Exit`. Both require a finite `capacity` and cache failures
as well as successes unless the TTL says otherwise.

Concurrent `Cache.get` calls for one missing key share one lookup. Construct the
cache once in its owning Layer or Scope: a per-call cache has no useful hits.
Use `Cache.invalidate`, `Cache.refresh`, and `Cache.has` for explicit staleness.
Use `Effect.cached` or `Effect.cachedWithTTL` for one unkeyed value.

```ts
import { Cache, Duration, Effect, Exit } from "effect"

declare const resolveUncached: (key: string) => Effect.Effect<{
  readonly value: string
  readonly cacheable: boolean
}>

const makeResolver = Effect.gen(function* () {
  const cache = yield* Cache.makeWith(resolveUncached, {
    capacity: 300,
    timeToLive: (exit) =>
      Exit.isSuccess(exit) && exit.value.cacheable
        ? "10 minutes"
        : Duration.zero
  })
  return (key: string) => Cache.get(cache, key)
})
```

Choose failure TTLs by semantics: zero TTL for transient failures or degraded
fallbacks; short negative TTL only for stable failures such as not found. Keep
scoped client/resource acquisition out of a lookup—acquire it once in the owning
Layer. `Cache` stores values, not resource lifecycle cleanup.

For many distinct keys, use `Effect.request` with a `RequestResolver` only when
the backend has a genuine batch endpoint. A per-item REST API normally needs
bounded `Effect.forEach`, optionally through a Cache; a resolver that loops over
single-item calls is not batching.
