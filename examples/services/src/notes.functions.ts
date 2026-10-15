import { Effect, flow, Schema } from "effect";

import { createEffectServerFn } from "./effect-server-fn.ts";
import { Notes } from "./notes.server.ts";

export const getNote = createEffectServerFn().handler(() =>
  Notes.pipe(Effect.flatMap((notes) => notes.read))
);

const RenameInput = Schema.Struct({
  id: Schema.NonEmptyString,
  title: Schema.NonEmptyString,
});

const saveNote = Effect.fn("Notes.save")((data: typeof RenameInput.Type) =>
  Notes.pipe(
    Effect.tap((notes) => notes.rename(data.id, data.title)),
    Effect.flatMap((notes) => notes.read),
    Effect.map((note) => ({ saved: true, title: note.title }))
  )
);

export const renameNote = createEffectServerFn({ method: "POST" })
  .validator(RenameInput)
  .handler(
    flow(({ data }: { data: typeof RenameInput.Type }) => data, saveNote)
  );

export const renameNoteIfPresent = createEffectServerFn({ method: "POST" })
  .validator(RenameInput)
  .handler(({ data }) =>
    saveNote(data).pipe(
      Effect.catchTag("NoteMissing", () =>
        Effect.succeed({ saved: false, title: null })
      )
    )
  );
