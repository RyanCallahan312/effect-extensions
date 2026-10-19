import { Context, Effect, Layer, Ref } from "effect";

import { NoteMissing } from "./errors.ts";

export class Notes extends Context.Service<
  Notes,
  {
    readonly read: Effect.Effect<{
      readonly id: string;
      readonly title: string;
    }>;
    readonly rename: (
      id: string,
      title: string
    ) => Effect.Effect<void, NoteMissing>;
  }
>()("example/Notes") {
  static readonly layer = Layer.effect(
    Notes,
    Effect.gen(function* notes() {
      const title = yield* Ref.make("First note");

      return Notes.of({
        read: Ref.get(title).pipe(
          Effect.map((value) => ({ id: "1", title: value }))
        ),
        rename: Effect.fn("Notes.rename")(function* rename(
          id: string,
          value: string
        ) {
          if (id !== "1") {
            return yield* new NoteMissing({ message: "Note does not exist" });
          }

          if (value === "crash") {
            return yield* Effect.die(new Error("services-private-diagnostic"));
          }

          yield* Ref.set(title, value);
        }),
      });
    })
  );
}
