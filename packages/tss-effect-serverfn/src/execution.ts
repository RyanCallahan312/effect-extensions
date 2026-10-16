import type { Effect, Scope } from "effect";
import type { HttpServerRequest } from "effect/http";

/**
 * Native middleware-context key shared by the compiler bridge and runtime owner.
 * This server-local capability must never be forwarded through `sendContext`.
 * @internal
 */
export const executionKey = "@rc312/tss-effect-serverfn/execution";

/**
 * Services supplied by the adapter in addition to the application's services.
 * The Scope covers decoding and business work. The HTTP request provides
 * metadata; Start has already consumed the RPC body.
 * @internal
 */
export type RequestServices = Scope.Scope | HttpServerRequest.HttpServerRequest;

/**
 * Request-local execution contract used by generated handlers.
 *
 * Phase notifications occur inside the running Effect immediately before each
 * stage. Calls to `run` are rejected after the enclosing native middleware ends.
 *
 * @template R - Services supplied by the application runtime.
 * @internal
 */
export interface ExecutionCapability<R> {
  readonly [executionKey]: {
    /** Run scoped work and await cleanup before resolving or rejecting the Promise. */
    readonly run: <A, E>(
      program: Effect.Effect<A, E, R | RequestServices>
    ) => Promise<A>;
    /** Classify subsequent failures as input-decoding failures. */
    readonly beginInput: () => void;
    /** Classify subsequent failures as handler-execution failures. */
    readonly beginExecution: () => void;
  };
}
