# Services, Layers, and Modules

Use this for capability seams, service tags, layer implementations, runtime
wiring, and reusable Effect operations. Target installed Effect 4.0.5; verify
unfamiliar APIs in the installed Context and Layer sources.

## Define a Domain-Named Service

Introduce `Context.Service` only for a real capability seam. Keep its shape
inline, give it a package-qualified identifier, and return implementations with
`Service.of`. Capture implementation dependencies while building the layer so
service methods expose `R = never` to consumers.

```ts
import { Context, Effect, Layer } from "effect"

class UserRepository extends Context.Service<UserRepository, {
  readonly find: (id: string) => Effect.Effect<{ readonly id: string }>
}>()("tss-effect-serverfn/example/UserRepository") {
  static readonly layer = Layer.succeed(
    UserRepository,
    UserRepository.of({
      find: Effect.fn("UserRepository.find")(function* (id) {
        return { id }
      })
    })
  )
}
```

Name service classes after the domain capability. Follow the package's relative
`.ts` imports rather than self-referential module namespaces or incidental barrel
imports. Do not add `export * as Domain from "./domain.js"`, TypeScript
`namespace` declarations, or a barrel that re-imports its own leaf; use direct,
intentional named exports instead.

Use named `Effect.fn` values with hierarchical names such as
`"UserRepository.find"` for useful tracing boundaries; use `Effect.fnUntraced`
for library glue without a tracing boundary. Put the operation's meaning in its
generator; attach retry, timeout, logging, tracing, and provisioning policy to a
specific invocation unless it is intrinsic to every call.

## Build and Compose Layers

Choose the constructor that matches acquisition:

| Need | Layer API |
|---|---|
| Existing implementation | `Layer.succeed` |
| Lazy synchronous construction | `Layer.sync` |
| Effectful or scoped construction | `Layer.effect` |
| Lifecycle work with no service | `Layer.effectDiscard` |
| Config or discovery selects a layer | `Layer.unwrap` |

Use `Layer.provide` to satisfy and hide dependencies, `Layer.provideMerge` only
when they must remain available, and `Layer.mergeAll` for independent peers.
Compose a named, topologically ordered runtime layer near the entrypoint and
provide it once. Reuse the same layer value when its scoped resource must be
shared.

Fork long-lived streams, listeners, workers, and loops into layer scope with
`Effect.forkScoped`; layer acquisition must complete. Use
`Effect.acquireRelease` for a reusable scoped resource and
`Effect.acquireUseRelease` for one local bracket.

```ts
import { Context, Effect, Layer } from "effect"

class Database extends Context.Service<Database, {
  readonly query: (sql: string) => Effect.Effect<ReadonlyArray<unknown>>
}>()("tss-effect-serverfn/example/Database") {}

declare const openDatabase: Effect.Effect<Database["Service"]>
declare const closeDatabase: (
  database: Database["Service"]
) => Effect.Effect<void>

export const DatabaseLive = Layer.effect(
  Database,
  Effect.acquireRelease(openDatabase, closeDatabase)
)
```

`Layer.effect` supplies the Scope required by `acquireRelease`. The database
stays open for that Layer instance and closes on normal shutdown, failure, or
interruption. Do not wrap this acquisition in `Effect.scoped` before returning
the Layer, which would close the resource before consumers can use it.

For framework runtime ownership, read
`packages/tss-effect-serverfn/src/effect-runner-middleware.ts`: callers supply
the runner rather than the library constructing application services or Layers.
