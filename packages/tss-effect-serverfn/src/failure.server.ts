/* oxlint-disable anti-slop/no-unknown-parameters -- This boundary classifies arbitrary thrown values; parsing them first would lose native control flow and error identity. */
import { setResponseStatus } from "@tanstack/react-start/server";
import { isNotFound, isRedirect } from "@tanstack/router-core";
import {
  Cause,
  Effect,
  ErrorReporter,
  Exit,
  Option,
  Predicate,
  Schema,
} from "effect";
import type { HttpServerRequest } from "effect/http";

import type {
  EffectConfiguration,
  FailureReport,
} from "./effect-middleware.ts";
import {
  getServerFnFailureDisposition,
  ownFailure,
} from "./provenance.server.ts";

const isControlFlow = (value: unknown) =>
  value instanceof Response || isRedirect(value) || isNotFound(value);

/**
 * Extract a typed failure only when it is the Cause's sole reason.
 * Mixed Causes, defects, and interruption cannot qualify as a public business
 * error. `Some(undefined)` still represents a real typed failure.
 */
const getSingleFailure = <E>(cause: Cause.Cause<E>): Option.Option<E> => {
  const reason = cause.reasons.length === 1 ? cause.reasons[0] : undefined;

  return reason && Cause.isFailReason(reason)
    ? Option.some(reason.error)
    : Option.none();
};

const isOwnedFailure = (value: unknown) =>
  getServerFnFailureDisposition(value) !== undefined;

const suppressInterruption = <E>(cause: Cause.Cause<E>) => {
  const rejection = Cause.squash(cause);

  return Predicate.isObject(rejection)
    ? ownFailure(rejection, "suppress", cause)
    : rejection;
};

/**
 * Reject a configuration or runtime failure without invoking application policy.
 * Runtime faults are never approved by the business-error schema, even when
 * they resemble a public error or native redirect.
 *
 * @param fallback - Trusted rejection record to copy for an unexpected failure.
 * @param cause - Original failure retained in the server-local registry.
 * @throws {unknown} The squashed interruption, or a fresh fallback with native reporting ownership.
 * @internal
 */
export const rejectRuntimeFailure = <F extends object, E>(
  fallback: F,
  cause: Cause.Cause<E>
): never => {
  if (Cause.hasInterruptsOnly(cause)) {
    throw suppressInterruption(cause);
  }

  throw ownFailure({ ...fallback }, "native", cause);
};

/**
 * Handle a rejection escaping the native middleware chain.
 * Recognized control flow and already-owned rejections retain their identity.
 * Other values, including objects whose inspection throws, receive the trusted
 * fallback without loading the application runtime.
 *
 * @param fallback - Trusted rejection record for unrecognized failures.
 * @param error - Value thrown by native middleware or the generated handler.
 * @throws {unknown} The recognized rejection or a registered fallback record.
 * @internal
 */
export const rejectMiddlewareFailure = <F extends object>(
  fallback: F,
  error: unknown
): never => {
  let passthrough = false;

  try {
    passthrough = isControlFlow(error) || isOwnedFailure(error);
  } catch {
    // Inspection faults remain private.
  }

  if (passthrough) {
    throw error;
  }

  return rejectRuntimeFailure(fallback, Cause.fail(error));
};

/**
 * Await the selected reporter and determine who owns further reporting.
 * An explicit override replaces native reporting and its ignore policy. The
 * override is interruptible and timeout-bounded even during masked rejection
 * processing. Reporter failures leave ownership with the outer framework.
 *
 * @returns An Effect yielding `boundary` after handling, `suppress` for a native
 * ignore annotation, or `native` when outer framework reporting is still needed.
 */
const reportFailure = Effect.fnUntraced(function* reportFailure<
  R,
  RuntimeError,
  P extends object,
>(
  report: FailureReport,
  configuration: EffectConfiguration<R, RuntimeError, P>,
  ignoredByNativeReporter: boolean
): Effect.fn.Return<
  "native" | "boundary" | "suppress",
  never,
  R | HttpServerRequest.HttpServerRequest
> {
  const { reportFailure: override, reportTimeout } = configuration;

  if (override) {
    const reportingExit = yield* Effect.exit(
      Effect.suspend(() => override(report)).pipe(
        Effect.interruptible,
        Effect.timeout(reportTimeout ?? "5 seconds")
      )
    );

    return Exit.isSuccess(reportingExit) ? "boundary" : "native";
  }

  const reporters = yield* ErrorReporter.CurrentErrorReporters;
  const reportingExit = yield* Effect.exit(ErrorReporter.report(report.cause));

  if (ignoredByNativeReporter) {
    return "suppress";
  }

  return Exit.isSuccess(reportingExit) && reporters.size > 0
    ? "boundary"
    : "native";
});

/**
 * Project a completed operation's Cause into a client rejection and report it.
 *
 * Pure interruption and native control flow pass through without reporting.
 * Ordinary decoder failures become `INVALID_INPUT` with HTTP 400. Only a single
 * execution failure can be approved by the public-error encoder; other failures
 * use the trusted fallback. Diagnostics stay attached by server-local identity.
 *
 * The caller must close the operation Scope before running this Effect and
 * contain any defect in projection itself. Encoder/reporter services come from
 * the application runtime and HTTP request, not the closed operation Scope.
 *
 * @returns An Effect yielding the rejection value for the Promise boundary to
 * throw. The original Cause is preserved separately from the client payload.
 * @internal
 */
export const projectFailure = Effect.fnUntraced(function* projectFailure<
  R,
  RuntimeError,
  P extends object,
  F extends object,
>(
  cause: Cause.Cause<unknown>,
  phase: FailureReport["phase"],
  configuration: EffectConfiguration<R, RuntimeError, P>,
  fallback: F,
  serverFnMeta: FailureReport["serverFnMeta"]
) {
  if (Cause.hasInterruptsOnly(cause)) {
    return suppressInterruption(cause);
  }

  let failure: FailureReport["failure"] = { ...fallback };
  let processingCause: Cause.Cause<unknown> | undefined;

  const inspectionExit = yield* Effect.exit(
    Effect.sync(() => {
      const single = getSingleFailure(cause);

      return Option.isSome(single)
        ? {
            ignored: ErrorReporter.isIgnored(single.value),
            invalidInput:
              phase === "input" && Schema.isSchemaError(single.value),
            passthrough:
              isControlFlow(single.value) || isOwnedFailure(single.value),
            value: single.value,
          }
        : undefined;
    })
  );

  if (Exit.isFailure(inspectionExit)) {
    processingCause = inspectionExit.cause;
  } else if (inspectionExit.value) {
    const single = inspectionExit.value;

    if (single.passthrough) {
      return single.value;
    }

    if (single.invalidInput) {
      yield* Effect.sync(() => setResponseStatus(400));

      return ownFailure(
        { code: "INVALID_INPUT", message: "Invalid input" },
        "suppress",
        cause
      );
    }

    const { publicError } = configuration;

    if (phase === "execution" && publicError) {
      const encodingExit = yield* Effect.exit(
        Effect.suspend(() =>
          Schema.encodeUnknownEffect(publicError, {
            onExcessProperty: "ignore",
          })(single.value)
        )
      );

      if (Exit.isSuccess(encodingExit)) {
        failure = encodingExit.value;
      } else {
        processingCause = encodingExit.cause;
      }
    }
  }

  const report: FailureReport = {
    cause,
    failure,
    phase,
    processingCause,
    serverFnMeta,
  };

  const ignored =
    Exit.isSuccess(inspectionExit) && inspectionExit.value?.ignored === true;

  const disposition = yield* reportFailure(report, configuration, ignored);

  if (Predicate.isObject(failure)) {
    return ownFailure({ ...failure }, disposition, cause);
  }

  return ownFailure({ ...fallback }, "native", cause);
});
