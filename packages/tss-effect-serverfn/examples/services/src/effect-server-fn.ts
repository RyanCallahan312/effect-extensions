import {
  createEffectMiddleware,
  createEffectServerFn as base,
} from "@rc312/tss-effect-serverfn";
import { createServerOnlyFn } from "@tanstack/react-start";

export const createEffectServerFn = base().middleware([
  createEffectMiddleware({
    fallbackFailure: { code: "INTERNAL", message: "Something went wrong" },
    resolve: createServerOnlyFn(async () => {
      const { runtime } = await import("./runtime.server.ts");
      const { NoteMissing } = await import("./errors.ts");

      return {
        publicError: NoteMissing,
        runPromiseExit: runtime.runPromiseExit,
      };
    }),
  }),
]);
