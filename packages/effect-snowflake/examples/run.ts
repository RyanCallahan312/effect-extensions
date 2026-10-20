import { layerFrom, makeWithDriver, Snowflake } from "@rc312/effect-snowflake";
import type { SnowflakeClient } from "@rc312/effect-snowflake";
import { layer as nativeDriver } from "@rc312/effect-snowflake/adbc-driver";
import { Effect, Layer, pipe } from "effect";

import { optionsFromEnv } from "./options.ts";

// The application chooses configuration and the native loader once. The Layer
// owns the connection until the entire program, including finalizers, finishes.
const live = layerFrom(
  optionsFromEnv().pipe(Effect.flatMap(makeWithDriver))
).pipe(Layer.provide(nativeDriver));

/** Runtime boundary for service-based example programs. */
export const runProgram = async <A, E>(
  program: Effect.Effect<A, E, Snowflake>
) => {
  try {
    const result = await Effect.runPromise(program.pipe(Effect.provide(live)));
    console.dir(result, { depth: null });
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
};

/** The scoped client factory API composes with the same application layer. */
export const runExample = <A, E>(
  use: (client: SnowflakeClient) => Effect.Effect<A, E>
) => runProgram(pipe(Snowflake, Effect.flatMap(use)));
