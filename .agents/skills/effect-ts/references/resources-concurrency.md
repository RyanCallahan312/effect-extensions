# Resources and Concurrency

Read this when using `Scope`, resource acquisition, fibers, synchronization,
transactional state, or concurrent collections. Read [scheduling](./scheduling.md)
for retry, repeat, and time policy.

## Ownership

- `Effect.acquireRelease` creates a reusable scoped resource; its finalizer runs
  when the owning Scope closes.
- `Effect.acquireUseRelease` is the local acquire/use/release bracket.
- `Effect.scoped` closes a local Scope when its effect completes.
- `Layer.effect` acquires a service for the Layer lifetime.
- `Layer.effectDiscard` with `Effect.forkScoped` owns lifecycle work without a
  service.

Use `Effect.ensuring` for unconditional follow-up, not as the default resource
constructor. Readers, subscriptions, sockets, and child fibers must have an
explicit owner; normal completion, failure, interruption, and early termination
must all release them.

## Fibers and synchronization

- `forkChild` is interrupted with its parent but is not automatically joined.
- `forkScoped` is interrupted when its Scope closes; prefer it for owned
  background work.
- `forkDetach` deliberately outlives its parent; use only with an explicit
  supervisor.

Join or otherwise observe a fallible fiber when its result matters. Starting a
fiber does not prove it reached meaningful work: coordinate startup and test
ordering with `Deferred`, `Queue`, `Latch`, or another explicit signal, never a
sleep.

## Bounded parallelism

`Effect.all` and `Effect.forEach` are sequential by default. Select a finite
numeric `concurrency` from connection, memory, and remote-rate limits;
`"unbounded"` needs a demonstrated bound elsewhere. `zip` / `zipWith` use
`{ concurrent: true }`, not a numeric concurrency option.

- Fail fast: default `Effect.all`.
- Preserve independent outcomes: `Effect.all(..., { mode: "result" })`.
- Separate outcomes: `Effect.partition`.
- Accumulate validation failures: `Effect.validate`.

Do not fork-and-forget a fallible operation unless a named supervision boundary
reports its failures. Recover expected errors with `catchTag`, `catch`, or
`catchIf`; reserve `catchCauseIf` for a true supervision boundary that must
inspect defects or interruption. Do not turn interruption into a successful
worker pass.

## State and time

Use `Ref` for process-local atomic state. Use transactional collections and
`Effect.tx` when several in-memory changes must commit atomically. Neither is
durable across process loss: persist checkpoints and leases.

Use `Clock` for now/sleeping and `DateTime` for domain timestamps. Global
`Date`, `Date.now`, and timers bypass `TestClock` and make tests nondeterministic.
