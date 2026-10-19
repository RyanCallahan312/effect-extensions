# @rc312/tss-effect-serverfn

Write TanStack Start server functions with **Effect Schemas and Effect handlers**. Call them with Start's normal Promise API.

## Quick start

In an existing **TanStack React Start** app using **Effect 4**:

```sh
bun add @rc312/tss-effect-serverfn 'effect@^4.0.5'
```

### 1. Register the Vite plugin

Add `effectServerFns()` **before** `tanstackStart()` in your existing config. Keep your other plugins and your usual Vite dev/build commands.

```ts
import { effectServerFns } from "@rc312/tss-effect-serverfn/vite";
// vite.config.ts
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [effectServerFns(), tanstackStart()],
});
```

### 2. Configure a shared factory

Create this file once. `createEffectMiddleware` runs your Effects and catches failures. This starter needs no application services and returns a safe fallback for unexpected failures.

```ts
import {
  createEffectMiddleware,
  createEffectServerFn as base,
} from "@rc312/tss-effect-serverfn";
// src/effect-server-fn.ts
import { createServerOnlyFn } from "@tanstack/react-start";
import { Effect } from "effect";

export const createEffectServerFn = base().middleware([
  createEffectMiddleware({
    fallbackFailure: { code: "INTERNAL", message: "Internal error" },
    resolve: createServerOnlyFn(() => ({
      runPromiseExit: Effect.runPromiseExit,
    })),
  }),
]);
```

Already have a `ManagedRuntime`? Use its `runPromiseExit` here; see [application services](docs/usage.md#application-services).

### 3. Write a server function

Import the **configured factory from your app**, pass the Schema directly, and return an Effect.

```ts
// src/greeting.functions.ts
import { Effect, Schema } from "effect";

import { createEffectServerFn } from "./effect-server-fn";

export const getGreeting = createEffectServerFn({ method: "GET" })
  .validator(Schema.Struct({ name: Schema.NonEmptyString }))
  .handler(({ data }) =>
    Effect.gen(function* greet() {
      yield* Effect.logInfo("Greeting requested");
      return { message: `Hello, ${data.name}!` };
    }).pipe(Effect.annotateLogs({ feature: "greeting" }))
  );
```

### 4. Call it

Call the function from a loader, component event handler, or another server function:

```ts
import { getGreeting } from "./greeting.functions";

const greeting = await getGreeting({ data: { name: "Ada" } });
// { message: "Hello, Ada!" }
```

That's the setup. The plugin handles compilation; the middleware handles execution, request cancellation, cleanup, and safe failures.

## Everyday usage

| You want to… | Use |
| --- | --- |
| Accept and transform input | `.validator(schema)`; callers pass `Encoded`, handlers receive `Type` |
| Use application services | Supply `runtime.runPromiseExit` in the shared factory |
| Add authentication/context | Native `.middleware([authMiddleware])`; read `context` in the handler |
| Acquire request resources | `Effect.acquireRelease` or `Effect.forkScoped`; Scope is provided |
| Return an approved business error | Native Schema error + a `publicError` schema in `resolve` |
| Add logs or traces | Native Effect annotations, `Effect.fn`, and `Effect.withSpan` |
| Handle router redirects/not-found in components | TanStack's `useServerFn` |

Invalid schema input rejects with `{ code: "INVALID_INPUT", message: "Invalid input" }` and HTTP 400. Other unapproved failures reject with your `fallbackFailure`. Detailed Causes stay on the server.

**Common setup mistakes:**

- Place `effectServerFns()` before `tanstackStart()`, then restart the dev server after changing Vite config.
- Import your configured factory in endpoints. The package's bare factory needs `createEffectMiddleware`, configured locally as above or through Start's global function middleware.
- Export configured builders directly, as in step 2. Keep factory calls and method names static so the compiler can find them.
- Keep runtime initialization and private configuration inside the `createServerOnlyFn` resolver.

## Other Start function utilities

Use Start's native helpers directly from `@tanstack/react-start`:

| Utility | Effect support |
| --- | --- |
| `createServerFn` | Use `createEffectServerFn` for raw Schemas and automatically executed Effect handlers. Ordinary native server functions also work alongside it. |
| `createServerOnlyFn` | Preserves an Effect-returning function; calling it on the client throws. |
| `createClientOnlyFn` | Preserves an Effect-returning function; calling it on the server throws. |
| `createIsomorphicFn` | Selects an Effect-returning `.server()` or `.client()` implementation. |

The three environment helpers return lazy Effects for composition. Use `yield*` inside your Effect handler; the handler's runtime executes them. [Examples and execution details →](docs/usage.md#start-function-utilities)

## More

- [Composition examples: pipe, flow, Effect.fn, and combinators](docs/composition.md)
- [Runnable basic and service examples](https://github.com/RyanCallahan312/effect-extensions/tree/main/packages/tss-effect-serverfn/examples)
- [Application services, errors, reporting, and execution details](docs/usage.md)
- [Workspace development](docs/development.md)

Tested with Effect 4.0.5, React Start 1.169.2, and Vite 8.3.4. Supported peer ranges are in `package.json`.
