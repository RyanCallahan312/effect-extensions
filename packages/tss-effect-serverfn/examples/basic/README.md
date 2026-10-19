# Basic

An Effect server function with raw Schema input, a Promise client, and no application services.

From the repository root:

```sh
bun install
bun run build
bun run --cwd packages/tss-effect-serverfn/examples/basic dev
```

Open http://localhost:3000. The initial greeting is server-rendered. Submit a name and a positive numeric string: the piped Schema converts the string into a number and checks it before the handler runs. An invalid count, including `0`, produces a safe `Invalid input` message.

The **Try a scenario** buttons fill and immediately submit a valid greeting, a non-numeric count, a zero count, or an empty name using the selected composition. **Latest request** shows pending/success/failure state, a snapshot of the submitted input, and the actual returned value or public error as formatted JSON. Validation errors include `code: "INVALID_INPUT"`; private Schema diagnostics are not exposed. The last successful greeting is kept separately and clearly labeled.

Use **Composition** to compare equivalent endpoints:

| Choice | Demonstrates |
| --- | --- |
| `Effect.gen` | Sequential `yield*` composition |
| `pipe + flatMap + map` | Standalone `pipe`, instance `.pipe`, dependent Effects, and pure mapping |
| `flow + Effect.all` | A composed handler function and bounded concurrent record collection |
| `Effect.fn` | A named, traced function passed directly to `.handler`, with a result combinator |
| `Do + bind + let` | Sequential Effect bindings and pure fields |

See the [composition guide](../../docs/composition.md) for copyable snippets and when to use each operator.

- **Check browser utilities** composes native `createClientOnlyFn` and `createIsomorphicFn` with Effect in a browser event handler.
- **Server redirect** uses an Effect failure containing Start's native redirect, handled by `useServerFn`.
- **About / Greeting** demonstrate client navigation and a server-function loader.

Start reading at:

1. [`vite.config.ts`](vite.config.ts) — plugin order.
2. [`src/effect-server-fn.ts`](src/effect-server-fn.ts) — one shared execution configuration.
3. [`src/greeting.functions.ts`](src/greeting.functions.ts) — raw Schema and Effect endpoint.
4. [`src/routes/index.tsx`](src/routes/index.tsx) — SSR loader and browser calls.

`bun run --cwd packages/tss-effect-serverfn/examples/basic preview` serves the production build on the same port.
