import {
  createEffectServerFn as base,
  createEffectMiddleware,
} from "@rc312/tss-effect-serverfn";
import { createMiddleware, createServerOnlyFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";

import { Notes } from "./notes.server";

const createEffectServerFn = base().middleware([
  createEffectMiddleware({
    fallbackFailure: { code: "INTERNAL", message: "Internal error" },
    resolve: createServerOnlyFn(async () => {
      const { runtime, PublicError } = await import("./notes.server");

      return {
        publicError: PublicError,
        runPromiseExit: runtime.runPromiseExit,
      };
    }),
  }),
  createMiddleware({ type: "function" })
    .validator((data) => {
      if (data.id === "native-invalid") {
        throw new Error("private native validation");
      }

      return data;
    })
    .server(({ next }) => next({ context: { userId: "trusted" } })),
]);

export const renameNote = createEffectServerFn({ method: "POST" })
  .validator(
    Schema.Struct({ id: Schema.NonEmptyString, title: Schema.NonEmptyString })
  )
  .handler(({ data, context }) =>
    Effect.gen(function* rename() {
      if (context.userId !== "trusted") {
        return yield* Effect.die("missing native context");
      }

      const notes = yield* Notes;

      return yield* notes.rename(data.id, data.title);
    }).pipe(Effect.annotateLogs({ action: "rename", feature: "notes" }))
  );
