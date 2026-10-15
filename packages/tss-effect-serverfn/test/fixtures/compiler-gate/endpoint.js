import { Effect, Schema } from "effect";

import { createEffectServerFn } from "./factory.js";
import { Notes } from "./runtime.server.ts";

export const renameNote = createEffectServerFn({ method: "POST" })
  .validator(
    Schema.Struct({ id: Schema.NonEmptyString, title: Schema.NonEmptyString })
  )
  .handler(({ data }) =>
    Effect.gen(function* rename() {
      const notes = yield* Notes;

      return yield* notes.rename(data.id, data.title);
    }).pipe(Effect.annotateLogs({ action: "rename", feature: "notes" }))
  );
