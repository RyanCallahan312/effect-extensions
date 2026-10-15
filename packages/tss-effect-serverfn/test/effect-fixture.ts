import { createMiddleware } from "@tanstack/react-start";
import type { Effect, ManagedRuntime } from "effect";

import { effectHandler } from "../src/compiler-runtime.ts";
import { createEffectMiddleware } from "../src/effect-middleware.ts";
import type { EffectConfiguration } from "../src/effect-middleware.ts";
import type { ExecutionCapability, RequestServices } from "../src/execution.ts";
import { execute } from "./tanstack-start-fixture.ts";

export const fallback = { code: "INTERNAL", message: "Internal error" };

export const runProgram = <A, E, R, RuntimeError, P extends object>(
  runtime: ManagedRuntime.ManagedRuntime<R, RuntimeError>,
  program: Effect.Effect<A, E, R | RequestServices>,
  configuration: Omit<
    EffectConfiguration<R, RuntimeError, P>,
    "runPromiseExit"
  > = {},
  request: Request = new Request("http://localhost")
) => {
  const boundary = createEffectMiddleware({
    fallbackFailure: fallback,
    resolve: () => ({
      runPromiseExit: runtime.runPromiseExit,
      ...configuration,
    }),
  });

  const handler = effectHandler(
    (_context: { data: unknown; context: ExecutionCapability<R> }) => program
  );

  const leaf = createMiddleware({ type: "function" })
    .middleware([boundary])
    .server(async (context) => {
      const result = await handler(context);

      return { ...(await context.next()), result };
    });

  return execute([boundary, leaf], request);
};
