import type { RecordBatch } from "apache-arrow";
import { Cause, Effect, Exit, Fiber, Scope, Stream } from "effect";

import { failure } from "../snowflake-error.ts";
import type { SnowflakeError } from "../snowflake-error.ts";

export const asCleanup = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.catchCause(effect, (cause) =>
    Effect.failCause(
      Cause.fromReasons<never>(
        cause.reasons.map((reason) =>
          Cause.isFailReason(reason)
            ? Cause.makeDieReason(reason.error).annotate(
                Cause.reasonAnnotations(reason)
              )
            : reason
        )
      )
    )
  );

const cleanupExit = <A, E>(exit: Exit.Exit<A, E>) => {
  if (Exit.isFailure(exit)) {
    const reasons = exit.cause.reasons.filter(
      (reason) => !Cause.isInterruptReason(reason)
    );

    if (reasons.length > 0) {
      return Effect.failCause(Cause.fromReasons(reasons)).pipe(asCleanup);
    }
  }

  return Effect.void;
};

// Each operation belongs to both its caller and its client/session Scope. Closing
// either interrupts AND joins it before the ADBC connection can be destroyed.
export const owned = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  scope: Scope.Scope,
  isOpen: () => boolean
): Effect.Effect<A, E | SnowflakeError, R> =>
  Effect.suspend<A, E | SnowflakeError, R>(() =>
    isOpen()
      ? Effect.acquireUseRelease(
          Effect.gen(function* acquireOperation() {
            const lifetime = yield* Scope.fork(scope, "sequential");

            const fiber = yield* Effect.forkIn(
              Effect.interruptible(effect),
              lifetime
            );

            // forkIn joins on scope closure but discards the fiber's exit. This
            // finalizer observes cleanup failures when the owner initiates shutdown.
            const stop = yield* Effect.cached(
              Effect.gen(function* stopOperation() {
                if (fiber.pollUnsafe() !== undefined) {
                  return;
                }

                yield* Fiber.interrupt(fiber);
                yield* cleanupExit(yield* Fiber.await(fiber));
              })
            );

            yield* Scope.addFinalizer(lifetime, stop);

            return { fiber, lifetime, stop };
          }),
          ({ fiber }) => Fiber.join(fiber),
          ({ fiber, lifetime, stop }, exit) =>
            Effect.gen(function* releaseOperation() {
              yield* stop;

              if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) {
                yield* cleanupExit(yield* Fiber.await(fiber));
              }
            }).pipe(Effect.ensuring(Scope.close(lifetime, exit)))
        )
      : Effect.fail(failure("closed")())
  );

export const ownedStream = (
  stream: Stream.Stream<RecordBatch, SnowflakeError>,
  owner: Scope.Scope,
  isOpen: () => boolean
) =>
  Stream.unwrap(
    Effect.gen(function* acquireOwnedStream() {
      if (!isOpen()) {
        return yield* failure("closed")();
      }

      const { scope: streamScope, resources: resourceScope } =
        yield* Effect.acquireRelease(
          Effect.gen(function* acquireStreamLifetime() {
            // Scope.close does not join an in-progress close. Both owners must use
            // the same cached teardown; detach its registration only after cleanup.
            const registration = yield* Scope.fork(owner, "sequential");
            const scope = yield* Scope.make("sequential");
            // Keep native resources below owned operation lifetimes in the finalizer
            // order. Initial stream acquisition may itself start a native read.
            const resources = yield* Scope.fork(scope, "sequential");
            let firstExit: Exit.Exit<unknown, unknown> | undefined;
            let retired = false;

            const teardown = yield* Effect.cached(
              Effect.suspend(() =>
                Scope.close(scope, firstExit ?? Exit.void)
              ).pipe(
                Effect.ensuring(
                  Effect.suspend(() => {
                    retired = true;

                    return Scope.close(registration, firstExit ?? Exit.void);
                  })
                ),
                Effect.uninterruptible
              )
            );

            const close = (exit: Exit.Exit<unknown, unknown>) =>
              Effect.suspend(() => {
                firstExit ??= exit;

                return teardown;
              });

            yield* Scope.addFinalizerExit(registration, (exit) =>
              retired ? Effect.void : close(exit)
            );

            return { close, resources, scope };
          }),
          (resource, exit) => resource.close(exit)
        );

      const pull = yield* owned(
        Stream.toPull(stream).pipe(
          Effect.provideService(Scope.Scope, resourceScope)
        ),
        streamScope,
        isOpen
      );

      return Stream.fromPull(Effect.succeed(owned(pull, streamScope, isOpen)));
    })
  );

/** Transfer a private sequential scope only after its acquisition effect succeeds. */
export const acquireOwner = Effect.fnUntraced(function* acquireClientOwner<
  A,
  E,
  R,
>(self: Effect.Effect<A, E, R>) {
  return yield* Effect.acquireUseRelease(
    Scope.fork(yield* Effect.scope, "sequential"),
    (owner) => self.pipe(Scope.provide(owner)),
    (owner, exit) =>
      Exit.isFailure(exit) ? Scope.close(owner, exit) : Effect.void
  );
});
