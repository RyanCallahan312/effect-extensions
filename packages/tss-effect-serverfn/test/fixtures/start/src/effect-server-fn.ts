import { createServerOnlyFn } from "@tanstack/react-start";
import { Effect } from "effect";
import {
  createEffectMiddleware,
  createEffectServerFn as base,
} from "tss-effect-serverfn";

export const createEffectServerFn = base().middleware([
  createEffectMiddleware({
    fallbackFailure: { code: "INTERNAL", message: "Internal error" },
    resolve: createServerOnlyFn(() => ({
      runPromiseExit: Effect.runPromiseExit,
    })),
  }),
]);
