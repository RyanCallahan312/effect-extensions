import { createMiddleware, createStart } from "@tanstack/react-start";
import { Effect } from "effect";
import { expectTypeOf } from "vitest";

import {
  createEffectMiddleware,
  createEffectServerFn,
} from "../../src/index.ts";

const auth = createMiddleware({ type: "function" }).server(({ next }) =>
  next({ context: { principal: "user" } })
);

const boundary = createEffectMiddleware({
  fallbackFailure: { code: "INTERNAL" },
  resolve: () => ({ runPromiseExit: Effect.runPromiseExit }),
});

const start = createStart(() => ({ functionMiddleware: [boundary, auth] }));

declare module "@tanstack/react-start" {
  interface Register {
    config: Awaited<ReturnType<typeof start.getOptions>>;
  }
}

// Compile-only: native handler calls require Start's compiler at runtime.
export const endpoint = () =>
  createEffectServerFn().handler(({ context }) => {
    expectTypeOf(context.principal).toEqualTypeOf<string>();

    return Effect.succeed(context.principal);
  });

expectTypeOf<ReturnType<ReturnType<typeof endpoint>>>().toEqualTypeOf<
  Promise<string>
>();
