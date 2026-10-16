import {
  createEffectServerFn as base,
  createEffectMiddleware,
} from "@rc312/tss-effect-serverfn";
import { createServerOnlyFn } from "@tanstack/react-start";

export const createEffectServerFn = base().middleware([
  createEffectMiddleware({
    fallbackFailure: { code: "INTERNAL" },
    resolve: createServerOnlyFn(async () => {
      const { runtime } = await import("./runtime.server.ts");

      return { runPromiseExit: runtime.runPromiseExit };
    }),
  }),
]);
