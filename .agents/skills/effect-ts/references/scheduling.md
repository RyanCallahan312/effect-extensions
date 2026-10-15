# Scheduling and Retry

Read this for retries, repeats, polling, backoff, jitter, timeouts, or recurring
workers. Use `Schedule` rather than a hand-written sleep loop.

## Core rules

- `Effect.retry` retries typed failures; defects and interruption are not retry
  candidates.
- `Effect.repeat` repeats successes; an unhandled failure stops repetition.
- The effect runs once before a schedule step. `Schedule.recurs(3)` permits three
  retries/repetitions after that initial run.
- `spaced` delays after work completes; `fixed` aligns work to a cadence.
- Use `exponential` or `fibonacci` for backoff and `jittered` to prevent retry
  storms.
- `Effect.retry` accepts options, a `Schedule`, or a schedule builder; prefer a
  composed `Schedule` when policy must be reused or extended. Options are sugar.
- Bound a delay schedule with `Schedule.upTo({ times: n })`.
- Combine schedules with `Schedule.max([...])` (all must continue, slowest delay)
  or `Schedule.min([...])` (any may continue, fastest delay).

Retry only transient, idempotent operations. Keep permanent validation,
authorization, and not-found errors out of the retryable error union or select
them with `while`. Exhaustion remains a failure unless a boundary has a truthful
fallback.

```ts
import { Effect, Schedule } from "effect"

declare const request: Effect.Effect<string, { readonly retryable: boolean }>

const policy = Schedule.exponential("100 millis").pipe(
  Schedule.jittered,
  Schedule.upTo({ times: 4 })
)

const resilientRequest = request.pipe(
  Effect.retry({ while: (error) => error.retryable, schedule: policy })
)
```

When a provider supplies a retry delay, read it from schedule metadata and wait
for the greater of provider delay and local backoff:

```ts
import { Duration, Effect, Schedule } from "effect"

type RateLimited = { readonly retryAfterMs?: number }

const backoff = Schedule.exponential("200 millis").pipe(
  Schedule.jittered,
  Schedule.upTo({ times: 5 })
)

export const providerRetry = backoff.pipe(
  Schedule.setInputType<RateLimited>(),
  Schedule.modifyDelay(({ input: error, duration: delay }) =>
    Effect.succeed(
      error.retryAfterMs === undefined
        ? delay
        : Duration.max(delay, Duration.millis(error.retryAfterMs))
    )
  )
)
```

## Workers and supervision

For an expected failed pass that the worker may skip, log it and recover in the
typed channel before repeating. For a batch, isolate only expected item failures
when skipping or later retry is product policy.

Use `catchCauseIf` only at a named supervision boundary whose policy deliberately
inspects full causes (including defects and interruption). Never use it merely to
keep a loop alive, and never convert interruption into a successful pass.

Use `Effect.timeout` for a real deadline and `Effect.delay` for deferred start.
Use `Clock`/`Effect.sleep`, not global timers; test schedules with `TestClock`.

For rate-limit-aware or composed schedules, inspect
installed `effect/ai-docs/src/06_schedule/10_schedules.ts` and `src/Schedule.ts`
before adding policy.
