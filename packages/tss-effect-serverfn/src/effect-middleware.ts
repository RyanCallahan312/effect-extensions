import { createMiddleware, createServerOnlyFn } from "@tanstack/react-start";
import type { ServerFnMeta } from "@tanstack/react-start";
import type { ValidateSerializableInput } from "@tanstack/router-core";
import type { Cause, Duration, Effect, Exit, Schema } from "effect";
import type { HttpServerRequest } from "effect/http";

import { bootstrapFailure } from "./bootstrap.server.ts";
import type { ExecutionCapability } from "./execution.ts";

/**
 * Server-local diagnostics passed to a configured failure reporter after request
 * cleanup. Causes can contain private input and application details; only the
 * projected rejection is eligible for transport to the client.
 */
export interface FailureReport {
  /** Original operation Cause, including any request-scope finalizer failures. */
  readonly cause: Cause.Cause<unknown>;
  /** The phase active when the operation failed. */
  readonly phase: "input" | "execution";
  /** Proposed client rejection: the approved encoded error or trusted fallback. */
  readonly failure: unknown;
  /** An additional fault from inspecting or encoding the original failure. */
  readonly processingCause?: Cause.Cause<unknown> | undefined;
  /** TanStack's identity and source metadata for the current server function. */
  readonly serverFnMeta: ServerFnMeta;
}

/**
 * Application-owned execution and failure policy resolved for a handler call.
 *
 * The adapter owns the request Scope; the application owns the runtime and its
 * disposal. Encoding and reporting run after request cleanup, with application
 * services and HTTP request metadata still available.
 *
 * @template R - Services supplied by the application's runner.
 * @template RuntimeError - Failures from acquiring the application's runtime.
 * @template P - Public rejection record produced by the error encoder.
 */
export interface EffectConfiguration<R, RuntimeError, P extends object> {
  /**
   * Execute in the application environment and return the complete Exit.
   * Use `Effect.runPromiseExit` for service-free work or a shared
   * `ManagedRuntime`'s `runPromiseExit`. Custom runners must honor the supplied
   * abort signal and await finalization before settling.
   */
  readonly runPromiseExit: <A, E>(
    program: Effect.Effect<A, E, R>,
    options?: Effect.RunOptions
  ) => Promise<Exit.Exit<A, E | RuntimeError>>;
  /**
   * Approve and encode a single typed business failure for the client.
   * Undeclared properties are stripped. Unapproved failures, defects, mixed
   * Causes, and encoding failures use `fallbackFailure` instead.
   */
  readonly publicError?: Schema.ConstraintEncoder<
    // Built-in wire values avoid a recursive Register.config dependency for global middleware.
    ValidateSerializableInput<unknown, P>,
    NoInfer<R> | HttpServerRequest.HttpServerRequest
  >;
  /**
   * Replace native `ErrorReporter.report` with an awaited Effect.
   * Control flow, ordinary invalid input, and pure interruption skip reporting.
   * Faults or timeouts in this callback leave the business rejection intact and
   * allow outer framework reporting. Compose native reporting here if desired.
   */
  readonly reportFailure?: (
    report: FailureReport
  ) => Effect.Effect<
    void,
    unknown,
    NoInfer<R> | HttpServerRequest.HttpServerRequest
  >;
  /**
   * Timeout for the `reportFailure` override only.
   *
   * @default "5 seconds"
   */
  readonly reportTimeout?: Duration.Input;
}

/**
 * Configure the eager safe fallback and lazy application execution policy.
 *
 * @template R - Services supplied by the resolved runner.
 * @template RuntimeError - Failures from acquiring the application's runtime.
 * @template P - Public rejection record produced by the error encoder.
 * @template F - Trusted fallback record available before application loading.
 */
export interface EffectMiddlewareOptions<
  R,
  RuntimeError,
  P extends object,
  F extends object,
> {
  /**
   * Trusted, serializable rejection for failures that cannot be exposed.
   * Keep it independent of lazy application loading and free of private details.
   * A fresh copy receives server-local diagnostics for each rejection.
   */
  readonly fallbackFailure: F & ValidateSerializableInput<unknown, F>;
  /**
   * Resolve configuration when the generated handler requests execution.
   * Native middleware that rejects or replaces the handler does not invoke this
   * callback. Reuse an application runtime rather than creating one per request.
   */
  readonly resolve: () =>
    | EffectConfiguration<R, RuntimeError, P>
    | PromiseLike<EffectConfiguration<R, RuntimeError, P>>;
}

const loadBoundary = createServerOnlyFn(() => import("./boundary.server.ts"));

const makeBootstrapFailure = createServerOnlyFn(bootstrapFailure);

/**
 * Create native Start middleware that supplies Effect execution to server functions.
 *
 * Install one owner before authorization and validation middleware. The Vite
 * plugin's generated handler uses it to decode input and execute business work
 * in one request Scope, with cancellation tied to the actual HTTP request.
 * Cleanup completes before native post-handler middleware resumes.
 *
 * @param options - Trusted fallback and lazy application configuration.
 * @returns Function middleware for a configured `createEffectServerFn` builder
 * or Start's global function-middleware registration.
 *
 * @example
 * ```ts
 * import { createServerOnlyFn } from "@tanstack/react-start";
 * import { Effect } from "effect";
 * import {
 *   createEffectMiddleware,
 *   createEffectServerFn as base,
 * } from "tss-effect-serverfn";
 *
 * export const createEffectServerFn = base().middleware([
 *   createEffectMiddleware({
 *     fallbackFailure: { code: "INTERNAL", message: "Something went wrong" },
 *     resolve: createServerOnlyFn(() => ({
 *       runPromiseExit: Effect.runPromiseExit,
 *     })),
 *   }),
 * ]);
 * ```
 */
export const createEffectMiddleware = <
  R,
  RuntimeError,
  P extends object,
  F extends object,
>(
  options: EffectMiddlewareOptions<R, RuntimeError, P, F>
) =>
  createMiddleware({ type: "function" }).server<ExecutionCapability<R>>(
    async ({ next, context, method, serverFnMeta }) => {
      let boundary: Awaited<ReturnType<typeof loadBoundary>>;

      try {
        boundary = await loadBoundary();
      } catch (error) {
        throw makeBootstrapFailure<F>(options.fallbackFailure, error);
      }

      return boundary.execute(
        options,
        { method, serverFnMeta },
        context,
        (execution) => next({ context: execution })
      );
    }
  );
