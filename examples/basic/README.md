# Basic

An Effect server function with raw Schema input, a Promise client, and no application services.

From the repository root:

```sh
bun install
bun run build
bun run --cwd examples/basic dev
```

Open http://localhost:3000. The initial greeting is server-rendered. Submit a name and a positive numeric string: the piped Schema converts the string into a number and checks it before the handler runs. An invalid count, including `0`, produces a safe `Invalid input` message.

Use **Composition** to compare equivalent endpoints:

| Choice | Demonstrates |
| --- | --- |
| `Effect.gen` | Sequential `yield*` composition |
| `pipe + flatMap + map` | Standalone `pipe`, instance `.pipe`, dependent Effects, and pure mapping |
| `flow + Effect.all` | A composed handler function and bounded concurrent record collection |
| `Effect.fn` | A named, traced function passed directly to `.handler`, with a result combinator |
| `Do + bind + let` | Sequential Effect bindings and pure fields |

See the [composition guide](../../packages/tss-effect-serverfn/docs/composition.md) for copyable snippets and when to use each operator.

- **Check browser utilities** composes native `createClientOnlyFn` and `createIsomorphicFn` with Effect in a browser event handler.
- **Server redirect** uses an Effect failure containing Start's native redirect, handled by `useServerFn`.
- **About / Greeting** demonstrate client navigation and a server-function loader.

Start reading at:

1. [`vite.config.ts`](vite.config.ts) — plugin order.
2. [`src/effect-server-fn.ts`](src/effect-server-fn.ts) — one shared execution configuration.
3. [`src/greeting.functions.ts`](src/greeting.functions.ts) — raw Schema and Effect endpoint.
4. [`src/routes/index.tsx`](src/routes/index.tsx) — SSR loader and browser calls.

`bun run --cwd examples/basic preview` serves the production build on the same port.
