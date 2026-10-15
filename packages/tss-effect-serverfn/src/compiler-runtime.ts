import { Effect, Predicate, Schema } from "effect";

import { executionKey } from "./execution.ts";
import type { ExecutionCapability } from "./execution.ts";

/**
 * Nominal token carrying input decoding across native middleware validation.
 * The class identity prevents arbitrary user data from impersonating a decoder.
 */
class PendingInput {
  readonly decode: Effect.Effect<unknown, Schema.SchemaError, unknown>;

  constructor(decode: Effect.Effect<unknown, Schema.SchemaError, unknown>) {
    this.decode = decode;
  }
}

/**
 * Adapt a raw Effect Schema into a deferred validator for generated Start code.
 *
 * Constructing the validator or applying it to input does not run decoding.
 * {@link effectHandler} executes the stored decoder in the same runtime and
 * Scope as business work, so service requirements and finalizers are preserved.
 *
 * @param schema - Endpoint Schema evaluated at the original declaration site.
 * @returns A native validator that wraps raw input in a pending decoder.
 * @internal
 */
export const prepareInput =
  <S extends Schema.Constraint>(schema: S) =>
  <A>(value: A) =>
    new PendingInput(
      Effect.suspend(() => Schema.decodeUnknownEffect(schema)(value))
    );

/**
 * Adapt an Effect-returning callback into Start's Promise-based provider handler.
 *
 * Pending input is decoded first and written back to the native context. Phase
 * transitions let the boundary distinguish input errors from business failures.
 * Callback construction is suspended so synchronous throws become defects.
 *
 * @param handler - The original application handler retained by compiler lowering.
 * @returns A provider callback that delegates execution to the request capability.
 * @throws {Error} If execution middleware has not supplied a valid capability.
 * @internal
 */
export const effectHandler =
  <C extends { data: unknown; context: ExecutionCapability<never> }, A, E, R>(
    handler: (context: C) => Effect.Effect<A, E, R>
  ) =>
  (context: C): Promise<A> => {
    const execution = context.context[executionKey];

    if (!execution || !Predicate.isFunction(execution.run)) {
      throw new Error("Effect server functions require createEffectMiddleware");
    }

    const program = Effect.gen(function* executeProgram() {
      if (context.data instanceof PendingInput) {
        execution.beginInput();
        // Update the native context so post-handler middleware also sees decoded data.
        context.data = yield* context.data.decode;
      }

      execution.beginExecution();

      return yield* Effect.suspend(() => handler(context));
    });

    // SAFETY: The configured builder checks handler and decoder services; lowering erases that shared environment at this single execution edge.
    return execution.run(
      program as Effect.Effect<A, E | Schema.SchemaError, never>
    );
  };
