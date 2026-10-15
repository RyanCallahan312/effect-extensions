# Testing Effect Code

Read this when changing Effect-native tests.

## Default shape

- Use ordinary Bun/Vitest tests for pure functions.
- Where the package has `@effect/vitest`, use `it.effect` for Effect-returning
  tests; use `it.live` only when live runtime services are the behavior under
  test.
- Execute effects only at the test boundary. Build small doubles with `Service.of`
  and `Layer.succeed`, and provide the smallest layer graph.
- Create a fresh mutable Layer per test unless sharing state is intentional.
- Dispose a test-created `ManagedRuntime` in `finally`.

The upstream Effect repository's restrictions on `Effect.runSync` and Vitest
`expect` are not downstream policy. Follow this package's existing runner and
assertion conventions.

## Deterministic concurrency and time

Use `Deferred` for readiness/completion, `Queue` for test-controlled messages,
`Latch` for reusable gates, and `Ref` for observation. Do not add arbitrary real
sleeps to wait for a fiber.

Use `TestClock` for sleep, timeout, retry, repeat, and Schedule behavior. Fork
the sleeping operation, advance/set virtual time, then join it; yielding the
sleep before advancing blocks the test.

```ts
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"

export const virtualTimeTest = Effect.gen(function* () {
  const fiber = yield* Effect.sleep("1 minute").pipe(
    Effect.as("complete" as const),
    Effect.forkChild
  )

  yield* TestClock.adjust("1 minute")
  return yield* Fiber.join(fiber)
})
```

With an ordinary runner, provide `TestClock.layer()` together with the rest of
the test Layer graph at the test entrypoint.

## Stateful test services

When tests need both the production capability and control/inspection methods,
install one stateful implementation under two tags. Production code receives
only the production tag.

```ts
import { Context, Effect, Layer, Ref } from "effect"

class Notifier extends Context.Service<Notifier, {
  readonly send: (message: string) => Effect.Effect<void>
}>()("tss-effect-serverfn/example/Notifier") {}

class TestNotifier extends Context.Service<TestNotifier, {
  readonly send: (message: string) => Effect.Effect<void>
  readonly sentMessages: Effect.Effect<ReadonlyArray<string>>
}>()("tss-effect-serverfn/example/Notifier/Test") {}

export const NotifierTestLayer = Layer.effectContext(
  Effect.gen(function* () {
    const sent = yield* Ref.make<ReadonlyArray<string>>([])
    const service = TestNotifier.of({
      send: Effect.fn("Notifier.Test.send")(function* (message) {
        yield* Ref.update(sent, (messages) => [...messages, message])
      }),
      sentMessages: Ref.get(sent)
    })

    return Context.empty().pipe(
      Context.add(Notifier, service),
      Context.add(TestNotifier, service)
    )
  })
)
```

Keep test-only controls off the production service interface. A fresh Layer per
test gives each test an isolated `Ref`.

## Assert observable contracts

Assert success values; typed error tags and fields; finalization and interruption;
retry bounds and idempotency; resource disposal; and virtual-time transitions.
Schema tests decode unknown input and test encoding, not only trusted `.make`.

Use tests under `packages/tss-effect-serverfn/test/` for local boundary and
runner conventions. `@effect/vitest@4.0.5` is installed; its peer runner is
Vitest 5, not a beta-era Vitest version.
