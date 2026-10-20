import type { RecordBatch } from "apache-arrow";
import { Cause, Effect, Exit, Fiber, Scope, Stream } from "effect";

import { failure } from "../snowflake-error.ts";
import type { SnowflakeError } from "../snowflake-error.ts";

const cleanupReason = <E>(reason: Cause.Reason<E>): Cause.Reason<never> =>
  Cause.isFailReason(reason)
    ? Cause.makeDieReason(reason.error).annotate(
        Cause.reasonAnnotations(reason)
      )
    : reason;

const cleanupCause = <E>(cause: Cause.Cause<E>) =>
  Cause.fromReasons<never>(cause.reasons.map(cleanupReason));

export const asCleanup = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.catchCause(effect, (cause) => Effect.failCause(cleanupCause(cause)));

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

const observeCleanup = <A, E>(fiber: Fiber.Fiber<A, E>) =>
  Fiber.await(fiber).pipe(Effect.flatMap(cleanupExit));

const stopOperation = Effect.fnUntraced(function* stopOwnedOperation<A, E>(
  fiber: Fiber.Fiber<A, E>
) {
  if (fiber.pollUnsafe() !== undefined) {
    return;
  }

  yield* Fiber.interrupt(fiber);
  yield* observeCleanup(fiber);
});

interface Operation<A, E> {
  readonly fiber: Fiber.Fiber<A, E>;
  readonly lifetime: Scope.Closeable;
  readonly stop: Effect.Effect<void>;
}

const acquireOperation = Effect.fnUntraced(function* acquireOwnedOperation<
  A,
  E,
  R,
>(effect: Effect.Effect<A, E, R>, scope: Scope.Scope) {
  const lifetime = yield* Scope.fork(scope, "sequential");
  const fiber = yield* Effect.forkIn(Effect.interruptible(effect), lifetime);
  // forkIn joins on closure but discards the exit; observe cleanup failures too.
  const stop = yield* stopOperation(fiber).pipe(Effect.cached);
  yield* Scope.addFinalizer(lifetime, stop);

  return { fiber, lifetime, stop } satisfies Operation<A, E>;
});

const releaseOperation = <A, E>(
  { fiber, lifetime, stop }: Operation<A, E>,
  exit: Exit.Exit<A, E>
) =>
  stop.pipe(
    Effect.andThen(
      Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
        ? observeCleanup(fiber)
        : Effect.void
    ),
    Effect.ensuring(Scope.close(lifetime, exit))
  );

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
          acquireOperation(effect, scope),
          ({ fiber }) => Fiber.join(fiber),
          releaseOperation
        )
      : Effect.fail(failure("closed")())
  );

// Finalizers and concurrent callers must join the same teardown. Scope.close
// marks a scope closed before its finalizers settle, so it cannot provide this
// join by itself. Keep the parent registration attached until teardown finishes.
const makeLifetime = Effect.fnUntraced(function* makeOwnedLifetime(
  owner: Scope.Scope
) {
  const registration = yield* Scope.fork(owner, "sequential");
  const scope = yield* Scope.make("sequential");
  // Native resources must finalize after any fiber that can acquire or use them.
  const resources = yield* Scope.fork(scope, "sequential");
  let firstExit: Exit.Exit<unknown, unknown> | undefined;
  let retired = false;
  let open = true;

  const retire = Effect.suspend(() => {
    retired = true;

    return Scope.close(registration, firstExit ?? Exit.void);
  });

  const teardown = yield* Effect.suspend(() => {
    open = false;

    return Scope.close(scope, firstExit ?? Exit.void);
  }).pipe(Effect.ensuring(retire), Effect.uninterruptible, Effect.cached);

  const close = (exit: Exit.Exit<unknown, unknown>) =>
    Effect.suspend(() => {
      firstExit ??= exit;

      return teardown;
    });

  yield* Scope.addFinalizerExit(registration, (exit) =>
    retired ? Effect.void : close(exit)
  );

  return { close, isOpen: () => open, resources, scope };
});

const acquireOwnedStream = Effect.fnUntraced(function* acquireStreamLifetime(
  stream: Stream.Stream<RecordBatch, SnowflakeError>,
  owner: Scope.Scope,
  isOpen: () => boolean
) {
  if (!isOpen()) {
    return yield* failure("closed")();
  }

  const lifetime = yield* Effect.acquireRelease(
    makeLifetime(owner),
    (resource, exit) => resource.close(exit)
  );

  const active = () => lifetime.isOpen() && isOpen();

  const pull = yield* owned(
    Stream.toPull(stream).pipe(Scope.provide(lifetime.resources)),
    lifetime.scope,
    active
  );

  return Stream.fromPull(Effect.succeed(owned(pull, lifetime.scope, active)));
});

export const ownedStream = (
  stream: Stream.Stream<RecordBatch, SnowflakeError>,
  owner: Scope.Scope,
  isOpen: () => boolean
) => Stream.unwrap(acquireOwnedStream(stream, owner, isOpen));

/** Join interrupted acquisition before releasing its late native resources. */
export const acquireOwner = Effect.fnUntraced(function* acquireClientOwner<
  A,
  E,
  R,
>(self: Effect.Effect<A, E, R>) {
  return yield* Effect.acquireUseRelease(
    makeLifetime(yield* Effect.scope),
    (lifetime) =>
      owned(
        self.pipe(Scope.provide(lifetime.resources)),
        lifetime.scope,
        lifetime.isOpen
      ),
    (lifetime, exit) =>
      Exit.isFailure(exit) ? lifetime.close(exit) : Effect.void
  );
});
