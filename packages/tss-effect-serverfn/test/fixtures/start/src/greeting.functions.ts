import { Effect, Schema } from "effect";

import { createEffectServerFn } from "./effect-server-fn.ts";

export const getGreeting = createEffectServerFn({ method: "GET" })
  .validator(Schema.Struct({ name: Schema.NonEmptyString }))
  .handler(({ data }) =>
    Effect.gen(function* greet() {
      yield* Effect.logInfo("Greeting requested");

      return { message: `Hello, ${data.name}!` };
    }).pipe(Effect.annotateLogs({ feature: "greeting" }))
  );
