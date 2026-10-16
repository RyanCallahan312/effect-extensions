# Usage reference

Start with the [quick start](../README.md#quick-start). The options below build on its shared `src/effect-server-fn.ts` factory.

For `pipe`, `flow`, `Effect.fn`, do notation, service composition, and typed recovery, see the [composition examples](composition.md).

## Application services

Build one `ManagedRuntime` from your application's Layer. Here is a complete small example:

```ts
// src/runtime.server.ts
import { Context, Effect, Layer, ManagedRuntime } from "effect";

export class Messages extends Context.Service<
  Messages,
  { readonly greet: (name: string) => Effect.Effect<string> }
>()("app/Messages") {}

export const runtime = ManagedRuntime.make(
  Layer.succeed(Messages, {
    greet: (name) => Effect.succeed(`Hello, ${name}!`),
  })
);
```

Replace the quick start's `resolve` option with:

```ts
resolve: createServerOnlyFn(async () => {
  const { runtime } = await import("./runtime.server");
  return { runPromiseExit: runtime.runPromiseExit };
}),
```

Your endpoints can now use those services directly:

```ts
// src/greeting.functions.ts
import { Effect, Schema } from "effect";

import { createEffectServerFn } from "./effect-server-fn";
import { Messages } from "./runtime.server";

export const getGreeting = createEffectServerFn({ method: "GET" })
  .validator(Schema.Struct({ name: Schema.NonEmptyString }))
  .handler(({ data }) =>
    Effect.gen(function* greet() {
      const messages = yield* Messages;
      return { message: yield* messages.greet(data.name) };
    })
  );
```

The compiler removes the handler and its private imports from browser output. Missing handler, decoder, encoder, or reporter services produce type errors.

Reuse the runtime across requests. Your application owns `runtime.dispose()` at shutdown and when replacing the runtime during HMR. The adapter owns each request's Scope.

For Vite HMR, add this to `runtime.server.ts`:

```ts
if (import.meta.hot) {
  import.meta.hot.dispose(() => runtime.dispose());
}
```

In production, await `runtime.dispose()` in your server host's shutdown hook after draining active requests. The shutdown hook depends on your deployment adapter.

## Start function utilities

All four of Start's public `create…Fn` utilities work with this integration. Import `createServerOnlyFn`, `createClientOnlyFn`, and `createIsomorphicFn` directly from `@tanstack/react-start`. Their generic signatures already preserve Effect success, error, and service types.

```ts
// src/environment.ts
import {
  createClientOnlyFn,
  createIsomorphicFn,
  createServerOnlyFn,
} from "@tanstack/react-start";
import { Config, Effect } from "effect";

export const readRegion = createServerOnlyFn(() => Config.string("APP_REGION"));

export const readBrowserLanguage = createClientOnlyFn(() =>
  Effect.sync(() => navigator.language)
);

export const readLanguage = createIsomorphicFn()
  .server(() => Effect.succeed("en"))
  .client(readBrowserLanguage);
```

Set `APP_REGION` in your server environment, then compose the utilities in an endpoint using the configured factory:

```ts
// src/details.functions.ts
import { Effect } from "effect";

import { createEffectServerFn } from "./effect-server-fn";
import { readLanguage, readRegion } from "./environment";

export const getDetails = createEffectServerFn().handler(() =>
  Effect.gen(function* details() {
    return {
      region: yield* readRegion(),
      language: yield* readLanguage(),
    };
  })
);
```

Start selects the implementation at build time and removes the other environment's implementation and unused imports. Both `.server(...).client(...)` and `.client(...).server(...)` work.

### Execution rules

- **Effect RPC handlers:** `createEffectServerFn` runs the returned Effect in the configured runtime and request Scope. Utilities composed with `yield*` share that execution, cancellation, and cleanup.
- **Environment utilities:** calling a helper creates an Effect; it does not run it. Compose it with other Effects, or execute it with your application runtime at a loader/event-handler boundary. These helpers do not perform RPC or create a request Scope.
- **Wrong environment:** `createServerOnlyFn` and `createClientOnlyFn` throw synchronously when called on the wrong side, before returning an Effect. Calling them inside `Effect.gen` turns that throw into a defect.
- **Missing isomorphic branch:** Start returns `undefined` in that environment. Supply both branches when callers will `yield*` the result; use `() => Effect.void` for an intentionally empty branch.
- **Types:** isomorphic implementations share argument types and retain a union of their return types, including Effect errors and required services. Supply the inferred services when executing the result.
- **Ordinary RPC handlers:** native `createServerFn` retains Start's normal value/Promise API. Use the configured `createEffectServerFn` when returning an Effect from an RPC handler.

## Middleware and request services

Add native middleware to the configured factory or individual endpoints:

```ts
createEffectServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(Input)
  .handler(({ data, context }) => program(data, context.user));
```

Here `authMiddleware`, `Input`, and `program` are application code. Install `createEffectMiddleware` before auth and native validators so it can sanitize their unexpected failures. Provision request-specific Effect services explicitly with `Effect.provideService` in the handler.

Native global function middleware via `createStart` is also supported; register its config with TanStack's `Register` interface for context inference.

The adapter supplies:

- `Scope.Scope` for input decoding and business execution.
- `HttpServerRequest.HttpServerRequest` from `effect/http`, backed by the actual Start request. Use it for metadata; Start has already consumed the RPC body.

## Execution and cancellation

1. Native middleware runs in its usual order.
2. The endpoint Schema decodes once with `Schema.decodeUnknownEffect` in the application runtime.
3. The handler's Effect executes in that same request Scope.
4. Finalizers finish before native middleware unwinds. Post-handler middleware sees decoded data.

Async and serviceful schemas retain Effect's defect and interruption semantics. Native middleware validator exceptions receive the safe fallback; ordinary endpoint schema failures receive the fixed `INVALID_INPUT` response.

Request abort interrupts Effect work and waits for finalizers. Pass `Effect.tryPromise`'s signal to cancellation-aware foreign APIs. Arbitrary preparation/configuration Promises cannot be forcibly cancelled; an aborted request does not start subsequent Effect work.

Scope closes before the adapted handler Promise settles. Self-contained Responses work, but resources acquired in the handler cannot escape in a streaming body or deferred value. The adapter does not dispose your application runtime.

Native `method`, `strict`, FormData POST constraints, and success serialization apply. Use `Schema.encodeEffect` inside the handler when success values need transformation.

## Public errors

Without a `publicError` schema, business failures use `fallbackFailure`. To expose selected failures, define an ordinary native error:

```ts
// src/errors.ts
import { Schema } from "effect";

export class NameUnavailable extends Schema.TaggedError<NameUnavailable>()(
  "NameUnavailable",
  { message: Schema.String }
) {}
```

Configure the shared factory's resolver:

```ts
resolve: createServerOnlyFn(async () => {
  const { runtime } = await import("./runtime.server");
  const { NameUnavailable } = await import("./errors");
  return {
    runPromiseExit: runtime.runPromiseExit,
    publicError: NameUnavailable,
  };
}),
```

Fail in application code with `yield* new NameUnavailable({ message: "Choose another name" })`. The Promise client rejects with the encoded record, containing `_tag` and `message`. For several error types, configure a native `Schema.Union`.

Only a single typed business failure accepted by the public schema is exposed. Encoding uses `Schema.encodeUnknownEffect`, supports application services, and strips undeclared fields. Every declared field is approved for disclosure. Keep `fallbackFailure` a trusted serializable record available before application loading.

Defects, mixed Causes, runtime/configuration failures, encoder faults, and cleanup defects use the fallback. Original Causes remain server-local. Public records use Start's built-in serializable types; custom registered serializers remain available for successful results.

A record's `statusCode` field does not set HTTP status. Use Start's native response utilities for that policy. For native control flow, return a successful `Response` or use `Effect.fail(redirect(...))`, `Effect.fail(notFound())`, or `Effect.fail(response)`. Defects containing these values remain defects.

## Reporting and observability

Use native log/span annotations, `Effect.fn`, and `Effect.withSpan`. The adapter creates one operation span that ends with the original scoped outcome. Cause annotations preserve trace information; annotations are not copied into a custom attribute accumulator.

The default reporting action is `ErrorReporter.report` in the application environment. Install reporters with native `ErrorReporter.layer`. Native identity deduplication, severity, attributes, and `ErrorReporter.ignore` apply. Public visibility does not imply reporting suppression. Control flow, ordinary invalid input, and pure interruption are excluded.

Optional fields returned by `resolve`:

| Option | Meaning |
| --- | --- |
| `publicError` | Schema approving and encoding public business failures |
| `reportFailure(report)` | Effect-valued replacement for the default reporting action |
| `reportTimeout` | Native `Duration.Input`; defaults to `"5 seconds"` for the override |

An override is awaited after request-scope cleanup, with application services and request metadata. Its faults/timeouts cannot replace the business rejection. Use `Effect.tryPromise` and its signal for foreign reporters. Compose `ErrorReporter.report` explicitly if the override should also invoke native reporters. ErrorReporter and the HTTP request APIs are unstable in Effect 4.0.5.

For outer framework reporting, `@rc312/tss-effect-serverfn/server` exports:

- `getServerFnFailureCause(error)` — original server-local diagnostic Cause.
- `getServerFnFailureDisposition(error)` — `{ capture, handled }`, or `undefined` for unrelated errors. Outer capture hooks should skip handled errors. Ownership does not imply guaranteed delivery.
- `acceptServerFnErrorEvent(error)` — suppresses ignored failures and repeated event acceptance by rejection identity. Use in an event delivery hook, including delivery initiated by the boundary.

If no reporter is installed or reporting fails, ownership stays with the native framework. Unrelated errors on the same request remain reportable.

## Compiler support

The Vite plugin adapts Schemas and Effects; TanStack owns extraction, RPC IDs, manifests, and transport. Supported declarations use static method chains, const aliases, namespace imports, and transparent configured-factory exports/re-exports.

Export configured builders directly. Dynamic wrapper factories, computed method calls, and mutable factory bindings are unsupported. Put `.validator(schema)` on endpoints rather than using a validated builder as middleware. `/compiler-runtime` is an internal generated-code entry point.

Clients keep Start's native Promise API. Use `useServerFn` for component redirect/not-found handling. Remote rejections are not typed as the handler's Effect error channel.
