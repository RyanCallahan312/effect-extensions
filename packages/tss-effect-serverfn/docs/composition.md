# Composing Effect handlers

Handlers can return any native Effect. `Effect.gen`, `pipe`, `.pipe`, `flow`, `Effect.fn`, and do notation all use the same configured runtime, decoded input, and request Scope.

Start with the [configured factory](../README.md#quick-start). Try the examples in the [basic app](https://github.com/RyanCallahan312/effect-extensions/tree/main/packages/tss-effect-serverfn/examples/basic): its **Composition** selector runs five equivalent server functions through real RPCs.

## Choose a composition style

| API | Use it for |
| --- | --- |
| `Effect.gen` | Sequential steps with `yield*`, local variables, and branching |
| `pipe(value, ...steps)` / `value.pipe(...steps)` | Passing a value through transformations; both forms are equivalent for Effects |
| `flow(...steps)` | Building a reusable function that composes steps left to right |
| `Effect.fn("name")(body, ...steps)` | A reusable Effect-returning function with a tracing span and optional result combinators |
| `Effect.map` | Transforming a success value with a pure function |
| `Effect.flatMap` | Running a dependent Effect and using its result |
| `Effect.tap` | Awaiting a dependent Effect while retaining the original success value |
| `Effect.as` | Replacing a successful result with a constant |
| `Effect.all` | Combining independent Effects into a tuple or record; concurrency is explicit |
| `Effect.Do`, `bind`, `let` | Building up named results: `bind` runs Effects, `let` adds pure values |
| `Effect.catchTag` | Recovering from one tagged business failure |

`pipe` and `flow` apply ordinary functions; they do not execute the Effects those functions construct. Keep side effects inside Effect constructors such as `Effect.sync`.

## Pipe a Schema, then pipe the decoded value

Here is a complete endpoint module using the configured factory:

```ts
// src/greeting.functions.ts
import { Effect, flow, pipe, Schema } from "effect";

import { createEffectServerFn } from "./effect-server-fn";

const Input = Schema.Struct({
  count: Schema.FiniteFromString.pipe(Schema.check(Schema.isGreaterThan(0))),
  name: Schema.NonEmptyString,
});

const greeting = (name: string) => Effect.succeed(`Hello, ${name}!`);
const environment = () => Effect.succeed("server");

export const getPipedGreeting = createEffectServerFn({ method: "GET" })
  .validator(Input)
  .handler(({ data }) =>
    pipe(
      greeting(data.name),
      Effect.flatMap((message) =>
        environment().pipe(
          Effect.map((value) => ({
            count: data.count,
            environment: value,
            message,
          }))
        )
      ),
      Effect.withSpan("Greeting.pipe")
    )
  );
```

The browser sends `{ count: "41", name: "Ada" }`. The handler receives a **number** for `data.count`; the positive-number check runs after decoding. A count of `"0"` or an invalid numeric string rejects with `INVALID_INPUT` before the handler runs.

The runnable app uses Start's native environment helpers for `greeting` and `environment`; their returned Effects compose in exactly the same way.

## Pass `flow` directly to `.handler`

Add this to the same module:

```ts
const greetTogether = (data: typeof Input.Type) =>
  Effect.all(
    {
      count: Effect.succeed(data.count),
      environment: environment(),
      message: greeting(data.name),
    },
    { concurrency: 2 }
  );

export const getFlowGreeting = createEffectServerFn({ method: "GET" })
  .validator(Input)
  .handler(
    flow(
      ({ data }: { data: typeof Input.Type }) => data,
      greetTogether,
      Effect.withSpan("Greeting.flow")
    )
  );
```

Annotating the first function with `typeof Input.Type` gives a separately composed function its decoded input type. The client's input is still inferred from the Schema's encoded type. Error and required-service types continue through the composition.

`Effect.all` preserves the record's keys and bounds concurrency here to two. Use `flatMap`, `tap`, or `yield*` when one operation must finish before another starts, such as saving before reading updated state.

## Pass `Effect.fn` directly to `.handler`

The same module can also export:

```ts
export const getFnGreeting = createEffectServerFn({ method: "GET" })
  .validator(Input)
  .handler(
    Effect.fn("Greeting.fn")(
      function* greet({ data }: { data: typeof Input.Type }) {
        return {
          count: data.count,
          environment: yield* environment(),
          message: yield* greeting(data.name),
        };
      },
      Effect.annotateLogs({ feature: "greeting" })
    )
  );
```

`Effect.fn` accepts a generator or an Effect-returning callback. Supply its result combinators as additional arguments, as above. When calling an existing Effect-returning function, pipe the returned Effect: `greetTogether(data).pipe(Effect.withSpan("Greeting.request"))`.

## Build a record with do notation

Another export in the same module:

```ts
export const getDoGreeting = createEffectServerFn({ method: "GET" })
  .validator(Input)
  .handler(({ data }) =>
    Effect.Do.pipe(
      Effect.bind("message", () => greeting(data.name)),
      Effect.bind("environment", () => environment()),
      Effect.let("count", () => data.count)
    )
  );
```

Each step retains earlier fields. A later `bind` or `let` callback can use those fields. Use `Effect.map` at the end if you want to project a different response shape.

## Pipe service work and recover a business error

The [services app](https://github.com/RyanCallahan312/effect-extensions/tree/main/packages/tss-effect-serverfn/examples/services) provides `Notes` through its application-owned `ManagedRuntime`. Its `notes.functions.ts` composes the service directly:

```ts
import { Effect, flow, Schema } from "effect";

import { createEffectServerFn } from "./effect-server-fn";
import { Notes } from "./notes.server";

const RenameInput = Schema.Struct({
  id: Schema.NonEmptyString,
  title: Schema.NonEmptyString,
});

const saveNote = Effect.fn("Notes.save")((data: typeof RenameInput.Type) =>
  Notes.pipe(
    Effect.tap((notes) => notes.rename(data.id, data.title)),
    Effect.flatMap((notes) => notes.read),
    Effect.map((note) => ({ saved: true, title: note.title }))
  )
);

export const renameNote = createEffectServerFn({ method: "POST" })
  .validator(RenameInput)
  .handler(
    flow(({ data }: { data: typeof RenameInput.Type }) => data, saveNote)
  );

export const renameNoteIfPresent = createEffectServerFn({ method: "POST" })
  .validator(RenameInput)
  .handler(({ data }) =>
    saveNote(data).pipe(
      Effect.catchTag("NoteMissing", () =>
        Effect.succeed({ saved: false, title: null })
      )
    )
  );
```

`tap` awaits the mutation and retains the `Notes` service, so `flatMap` can read the saved title. A failed mutation skips that read. `catchTag` implements an explicit policy: a missing note is a successful skip. In the app, enable **Recover missing notes with catchTag** and submit ID `missing` to try it.

Without recovery, `NoteMissing` reaches the configured public-error boundary. With recovery, it leaves the Effect error channel and becomes a normal successful RPC result. Defects still use the safe fallback. Endpoint Schema failures happen before this handler and cannot be caught by its pipeline.

## Execution stays at the boundary

- Keep the static `createEffectServerFn(...).validator(...).handler(...)` declaration so Start can extract it. Compose the Schema and handler freely inside that declaration.
- Return the final Effect from the handler. The configured middleware runs it once; the client keeps Start's Promise API.
- `Effect.ensuring` finalizers and request-scoped `Effect.acquireRelease` cleanup are awaited before the handler Promise settles. Piping does not change Scope ownership.
- Compose internal Effect operations such as `saveNote` for reuse between endpoints. An exported server function is a framework/RPC boundary, not an Effect-returning domain function.

The browser suite exercises every style in dev and production preview. Type tests check encoded/decoded inputs, success values, typed recovery, and required services; boundary tests check lazy construction, `tap`, `as`, `ensuring`, and scoped cleanup on success and recovery.
