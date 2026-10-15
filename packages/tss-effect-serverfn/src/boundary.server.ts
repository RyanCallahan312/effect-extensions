import type { Method } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { Cause, Effect, Exit, Predicate } from "effect";
import { HttpServerRequest } from "effect/http";

import type {
  EffectConfiguration,
  EffectMiddlewareOptions,
  FailureReport,
} from "./effect-middleware.ts";
import { executionKey } from "./execution.ts";
import type { ExecutionCapability } from "./execution.ts";
import {
  projectFailure,
  rejectMiddlewareFailure,
  rejectRuntimeFailure,
} from "./failure.server.ts";
import { ownFailure } from "./provenance.server.ts";

interface Operation {
  readonly method: Method;
  readonly serverFnMeta: FailureReport["serverFnMeta"];
}

/**
 * Lend a request-local execution capability to the native middleware chain.
 *
 * Runtime configuration is resolved only when the generated handler calls `run`.
 * Decoding and business work share a Scope and operation span; both close before
 * failure projection and reporting. Request cancellation interrupts that work,
 * while cleanup and rejection processing are awaited before returning to Start.
 * The application's runtime remains application-owned.
 *
 * @param options - Execution configuration and trusted fallback rejection.
 * @param operation - Native function metadata used for tracing and reporting.
 * @param context - Incoming native context, checked for conflicting ownership.
 * @param continueMiddleware - Continue the native chain with the new capability.
 * @returns The native middleware result, or a rejection selected by the boundary.
 * @internal
 */
export const execute = async <
  R,
  RuntimeError,
  P extends object,
  F extends object,
  Output,
>(
  options: EffectMiddlewareOptions<R, RuntimeError, P, F>,
  operation: Operation,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This native framework context is inspected only for conflicting execution ownership.
  context: unknown,
  continueMiddleware: (context: ExecutionCapability<R>) => Promise<Output>
): Promise<Output> => {
  const { fallbackFailure } = options;
  let request: Request;

  try {
    request = getRequest();

    if (Predicate.hasProperty(context, executionKey)) {
      throw new Error(
        "Multiple Effect middleware owners cannot execute one server function"
      );
    }
  } catch (error) {
    return rejectRuntimeFailure(fallbackFailure, Cause.fail(error));
  }

  let phase: FailureReport["phase"] = "execution";
  let active = true;

  const capability: ExecutionCapability<R> = {
    [executionKey]: {
      beginExecution: () => {
        phase = "execution";
      },
      beginInput: () => {
        phase = "input";
      },
      async run(program) {
        if (!active) {
          return rejectRuntimeFailure(
            fallbackFailure,
            Cause.die(new Error("Effect execution outlived its native handler"))
          );
        }

        if (request.signal.aborted) {
          return rejectRuntimeFailure(fallbackFailure, Cause.interrupt());
        }

        // Resolve lazily: native middleware can reject or replace the handler without acquiring the runtime.
        let configuration: EffectConfiguration<R, RuntimeError, P>;

        try {
          configuration = await options.resolve();
        } catch (error) {
          return rejectRuntimeFailure(fallbackFailure, Cause.fail(error));
        }

        const scopedOperation = Effect.scoped(program).pipe(
          Effect.withSpan(operation.serverFnMeta.name, {
            attributes: {
              "rpc.boundary": "server-function",
              "rpc.method": operation.method,
            },
          })
        );

        const supervisedOperation = Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* superviseOperation() {
            // Cancellation interrupts the operation; cleanup and failure projection are awaited.
            const operationExit = yield* Effect.exit(restore(scopedOperation));

            if (Exit.isSuccess(operationExit)) {
              return operationExit;
            }

            const projectionExit = yield* Effect.exit(
              projectFailure(
                operationExit.cause,
                phase,
                configuration,
                fallbackFailure,
                operation.serverFnMeta
              )
            );

            const rejection = Exit.isSuccess(projectionExit)
              ? projectionExit.value
              : ownFailure(
                  { ...fallbackFailure },
                  "native",
                  operationExit.cause
                );

            return Exit.fail(rejection);
          })
        ).pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(request)
          )
        );

        // The outer Exit represents runtime acquisition/execution faults; the inner Exit is the projected operation result.
        let runtimeExit: Exit.Exit<
          Effect.Success<typeof supervisedOperation>,
          RuntimeError
        >;

        try {
          runtimeExit = await configuration.runPromiseExit(
            supervisedOperation,
            { signal: request.signal }
          );
        } catch (error) {
          return rejectRuntimeFailure(fallbackFailure, Cause.die(error));
        }

        if (Exit.isFailure(runtimeExit)) {
          return rejectRuntimeFailure(fallbackFailure, runtimeExit.cause);
        }

        const operationExit = runtimeExit.value;

        if (Exit.isFailure(operationExit)) {
          throw Cause.squash(operationExit.cause);
        }

        return operationExit.value;
      },
    },
  };

  try {
    if (request.signal.aborted) {
      return rejectRuntimeFailure(fallbackFailure, Cause.interrupt());
    }

    const output = await continueMiddleware(capability);

    if (
      Predicate.hasProperty(output, "result") &&
      Effect.isEffect(output.result)
    ) {
      throw new Error(
        "Missing effectServerFns() Vite plugin: the handler returned an unexecuted Effect"
      );
    }

    return output;
  } catch (error) {
    return rejectMiddlewareFailure(fallbackFailure, error);
  } finally {
    active = false;
  }
};
