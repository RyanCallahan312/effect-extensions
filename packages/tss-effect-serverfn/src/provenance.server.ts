import { Predicate } from "effect";
import type { Cause } from "effect";

/**
 * Reporting ownership for one rejection identity: suppress all capture, mark
 * boundary handling, or leave reporting to the native framework.
 */
type Disposition = "suppress" | "boundary" | "native";

interface FailureState {
  readonly disposition: Disposition;
  readonly cause?: Cause.Cause<unknown>;
  accepted: boolean;
}

const makeRegistry = () => ({
  failures: new WeakMap<object, FailureState>(),
});

/**
 * Identity-based diagnostics shared by adapters and reporting hooks.
 * Weak keys avoid retaining completed failures; Vite's HMR data keeps in-flight
 * rejections recognizable when this module is replaced.
 */
const registry: ReturnType<typeof makeRegistry> = (() => {
  if (import.meta.hot) {
    import.meta.hot.data.effectServerFnProvenance ??= makeRegistry();

    return import.meta.hot.data.effectServerFnProvenance;
  }

  return makeRegistry();
})();

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Lookup accepts arbitrary rejection values and narrows before touching the identity registry.
const getFailureState = (error: unknown) =>
  Predicate.isObject(error) ? registry.failures.get(error) : undefined;

/**
 * Register diagnostics and reporting ownership without mutating a rejection.
 * Registration resets event acceptance for this identity. Boundary-created
 * rejections use fresh records so separate requests are deduplicated separately.
 *
 * @param failure - Object used as the actual rejection identity.
 * @param disposition - Whether reporting is suppressed, handled, or delegated.
 * @param cause - Original diagnostic Cause; never added to the wire payload.
 * @returns The same object, suitable for returning or throwing.
 * @internal
 */
export const ownFailure = <P extends object>(
  failure: P,
  disposition: Disposition,
  cause?: Cause.Cause<unknown>
): P => {
  const state = {
    accepted: false,
    disposition,
  };

  registry.failures.set(
    failure,
    cause === undefined ? state : { ...state, cause }
  );

  return failure;
};

/**
 * Read the reporting policy for a rejection recognized by this server process.
 *
 * `capture` indicates whether an error event is allowed. `handled` indicates
 * that the boundary handled or suppressed reporting, so outer middleware should
 * not initiate another capture. This lookup does not consume event acceptance.
 *
 * @param error - The original rejection object, not a deserialized copy.
 * @returns A policy snapshot, or `undefined` for an unrecognized value.
 */
export const getServerFnFailureDisposition = <E>(error: E) => {
  const state = getFailureState(error);

  return state
    ? {
        capture: state.disposition !== "suppress",
        handled: state.disposition !== "native",
      }
    : undefined;
};

/**
 * Retrieve the original diagnostic Cause associated with a rejection.
 * Includes bootstrap and runtime failures as well as business/cleanup failures.
 * The Cause can contain private data and must remain server-local.
 *
 * @param error - The original rejection identity observed on the server.
 * @returns Its registered Cause, or `undefined` when none is available.
 */
export const getServerFnFailureCause = <E>(
  error: E
): Cause.Cause<unknown> | undefined => getFailureState(error)?.cause;

/**
 * Accept at most one error-delivery event for a registered rejection identity.
 * Use in a reporter's `beforeSend`-style hook, including events initiated by the
 * boundary itself. Unlike the disposition lookup, this call consumes acceptance.
 * Unrelated errors retain native reporting behavior.
 *
 * @param error - The original exception associated with the delivery event.
 * @returns `false` for suppressed or already-accepted registered failures;
 * `true` for the first allowed event or any unrecognized value.
 */
export const acceptServerFnErrorEvent = <E>(error: E) => {
  const state = getFailureState(error);

  if (!state) {
    return true;
  }

  if (state.disposition === "suppress" || state.accepted) {
    return false;
  }

  state.accepted = true;

  return true;
};
