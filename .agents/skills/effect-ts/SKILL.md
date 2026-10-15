---
name: effect-ts
description: Write and review Effect 4 code using Schema, Effect, Context.Service, Layer, Config, Schedule, Cache, Stream, HTTP, SQL, workflows, clusters, testing, and runtime boundaries. Use for Effect-native TypeScript and TanStack Start integration in this repository. Targets installed effect@4.0.5.
---

# Effect v4

Use installed Effect 4 patterns and this repository's conventions.
Established package guidance still takes precedence unless the task changes it.

Adapted from Kit Langton's MIT-licensed `kitlangton/skills` Effect skill at
commit `30dee8607214c893dd89f6eee65c669ef3dce8c9`.

## Source Rule

Before guessing about an unfamiliar or unstable API, read in this order:

1. The nearest `AGENTS.md` and package-local guidance.
2. [Installed version and API changes](./references/installed-version.md).
3. `packages/tss-effect-serverfn/node_modules/effect/AGENTS.md` and its linked
   `ai-docs/src/` examples.
4. Source and declarations in that installed package (`src/` and `dist/`).

The lockfile and installed package currently resolve `effect@4.0.5`; the peer
range is `^4.0.5`, not an exact pin. Recheck both before changing version-sensitive
code. Prefer installed source over public docs or upstream main. Do not reuse
beta APIs or assume optional `@effect/*` integrations are installed.

## Branch Chooser

Read only the references matching the task. Read every matching branch when a
change crosses concerns.

| Task | Reference |
|---|---|
| Version checks, beta-to-stable API names, package exports | [Installed Version](./references/installed-version.md) |
| Schemas, brands, variants, errors, codecs, recursion, evolution | [Schema](./references/schema-advanced.md) |
| Services, Layers, module surfaces, `Effect.fn`, scoped workers | [Services and Layers](./references/services-layers.md) |
| Environment or runtime configuration, `ConfigProvider` | [Config](./references/config.md) |
| Retry, repeat, polling, backoff, jitter, timeout policy | [Scheduling](./references/scheduling.md) |
| TTL caches, memoization, concurrent dedupe, request batching | [Caching](./references/caching.md) |
| Scope, resources, fibers, synchronization, bounded concurrency | [Resources and Concurrency](./references/resources-concurrency.md) |
| Streams, event sources, pagination, backpressure, consumers | [Streams](./references/streams.md) |
| Promises, callbacks, events, async iterables, native streams | [Foreign APIs](./references/foreign-apis.md) |
| Effect tests, virtual time, service doubles, synchronization | [Testing](./references/testing.md) |
| Effect SQL, Postgres, or Effect-native Drizzle | [SQL](./references/sql.md) |
| Outgoing HTTP and provider adapters | [HTTP](./references/http.md) |
| Bun entrypoints, `ManagedRuntime`, shutdown, telemetry | [Runtime and Observability](./references/runtime-observability.md) |
| Durable workflows and activities | [Workflows](./references/workflows.md) |
| Entities, sharding, cluster transport and storage | [Clustering](./references/clustering.md) |
| AI, RPC, HTTP API, OpenAPI, other unstable modules | [Specialized Modules](./references/specialized.md) |

## Core Defaults

- Compose inline workflows with `Effect.gen`.
- Define reusable Effect operations with `Effect.fn("Domain.operation")` when
  tracing is useful. Use `Effect.fnUntraced` for library glue or hot paths that
  should not introduce a tracing boundary.
- Put domain decisions in generators; attach timeout, retry, tracing,
  provisioning, and interruption policy with combinators.
- For reusable policy, prefer a canonical pipeable value; treat options objects
  as convenience syntax that normalizes to it rather than as the policy algebra.
- Introduce `Context.Service` for a real capability seam. Capture dependencies
  while building its implementation so public methods require `R = never`.
- Build and provide Layers near the runtime boundary; run Effects only at
  application, framework, script, or test edges.
- Decode unknown input once at ingress and pass validated values inward.
- Do not inspect `_tag` directly at runtime. Use generated tagged-union
  predicates and exhaustive matchers, or Effect's domain-specific helpers.
- Keep expected failures in `E`. Preserve defects and interruption unless a
  named supervision boundary has a truthful policy for them.
- Make resource, Scope, and fiber ownership explicit.

## Quick Selection

| Need | Default |
|---|---|
| Ordinary record | `Schema.Struct` plus a same-name inferred interface/type |
| Scalar identity | Checked schema, then `Schema.brand` |
| Nominal plain object | `Schema.Opaque` |
| Methods, custom construction, inheritance | Exceptional `Schema.Class` |
| Internal decision algebra | `Data.TaggedEnum` and exhaustive `$match` |
| Serialized tagged value | `Schema.TaggedStruct` / `Schema.TaggedUnion` |
| Tagged-union membership | `Data.taggedEnum(...).$is` / `Schema.TaggedUnion(...).isAnyOf` |
| Tagged-union branching | Generated `$match` / `.match`, or `Match.tag` with `Match.exhaustive` |
| Expected boundary failure | `Schema.TaggedError` |
| Strictly local failure | `Data.TaggedError` |
| Unknown payload | `Schema.decodeUnknownEffect` |
| Trusted construction | `schema.make` |
| Fallible Effect construction | `schema.makeEffect` |
| Existing value | `Effect.succeed` |
| Non-throwing synchronous work | `Effect.sync` |
| Throwing synchronous API | `Effect.try` |
| Promise API | `Effect.tryPromise` with immediate error normalization |
| One callback result | `Effect.callback` |
| Many time-ordered values | `Stream` |
| Runtime settings | `Config`, installed with `ConfigProvider` at a boundary |
| Retry or polling policy | `Schedule` |
| Keyed TTL lookup dedupe | `Cache` |
| One memoized Effect | `Effect.cached` / `cachedWithTTL` |

## Repository Rules

- Follow the package's existing relative `.ts` imports and intentional public
  exports. Do not introduce `#` aliases or incidental barrels.
- Add definition-site `Stream.withSpan` when the stream is a useful tracing boundary.
- Inside Effect operations, use services instead of ambient globals:
  `Config` instead of `process.env`, `HttpClient` instead of global `fetch`,
  `Clock` / `DateTime` instead of global time, and Effect sleep/delay instead of
  global timers.
- Use `Random` only for non-security-sensitive randomness. Use the
  platform-provided `Crypto` service for secure bytes, UUIDs, digests, and
  tokens.
- Prefer adapting foreign Promises with
  `Effect.tryPromise`, including its `AbortSignal` when supported.
- Yield Effect-native Drizzle builders directly. Do not wrap them in Promise
  adapters.
- Use result types and typed errors for expected control flow. Do not throw from
  Effect-native domain code.
- Do not compare, switch on, destructure, persist, or perform collection lookup
  with `_tag` directly. Follow the tagged-union guidance in the Schema reference.

## Boundary Rules

- Keep HTTP/framework handlers thin: decode, read context, call a service, and
  translate typed outcomes.
- Keep network/provider calls outside authoritative database transactions.
- Retry only classified transient failures and only with proven idempotency.
- Keep exhausted failures visible unless the current boundary has a real
  fallback.
- Treat persisted and remote schemas as compatibility contracts.
- Do not claim exactly-once external effects from workflow, activity, cluster,
  queue, or persistence semantics; design idempotency and reconciliation.

## Do Not

- Do not silence Effect typing with `as any`, non-null assertions, or unchecked
  casts.
- Do not use `Schema.Class` as the default record model.
- Do not use cause-level recovery when typed-error recovery is sufficient.
- Do not convert interruption into an ordinary success or failure.
- Do not use `Layer.mergeAll` or `provideMerge` as blind compile fixes.
- Do not hide required credentials, persistence, transport, or authority behind
  defaulted references.
- Do not add sleeps to tests when `Deferred`, `Queue`, `Latch`, `Ref`, or
  `TestClock` can synchronize deterministically.
- Do not hand-roll TTL/in-flight caches when `Cache` fits.

## Validate Skill Changes

Run these from the repository root after editing this skill:

```sh
bun .agents/skills/effect-ts/scripts/check-links.ts
bun .agents/skills/effect-ts/scripts/verify-apis.ts
bun .agents/skills/effect-ts/scripts/typecheck-examples.ts
bun test ./.agents/skills/effect-ts/scripts/scripts.test.ts
```
