import { createServerOnlyFn } from "@tanstack/react-start";
import {
  createEffectServerFn as base,
  createEffectMiddleware,
} from "tss-effect-serverfn";

export const createEffectServerFn = base().middleware([
  createEffectMiddleware({
    fallbackFailure: { code: "INTERNAL" },
    resolve: createServerOnlyFn(async () => {
      const { runtime } = await import("./runtime.server.ts");

      return { runPromiseExit: runtime.runPromiseExit };
    }),
  }),
]);
