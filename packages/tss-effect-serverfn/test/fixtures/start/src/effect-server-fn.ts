import {
  createEffectMiddleware,
  createEffectServerFn as base,
} from "@rc312/tss-effect-serverfn";
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
