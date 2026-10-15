import { Context, Effect, Layer, ManagedRuntime } from "effect";

export class Notes extends Context.Service<
  Notes,
  {
    readonly rename: (id: string, title: string) => Effect.Effect<string>;
  }
>()("gate/Notes") {}

export const runtime = ManagedRuntime.make(
  Layer.succeed(
    Notes,
    Notes.of({
      rename: (id, title) => Effect.succeed(`${id}:${title}`),
    })
  )
);
