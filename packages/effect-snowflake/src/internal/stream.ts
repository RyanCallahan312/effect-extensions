import type { RecordBatch } from "apache-arrow";
import { Effect, Scope, Stream } from "effect";

import { SnowflakeOperation } from "../operations.ts";
import { failure } from "../snowflake-error.ts";
import type { SnowflakeError } from "../snowflake-error.ts";
import { acquireLifetime, owned } from "./lifecycle.ts";

const acquireOwnedStream = Effect.fnUntraced(function* acquireStreamLifetime(
  stream: Stream.Stream<RecordBatch, SnowflakeError>,
  owner: Scope.Scope,
  isOpen: () => boolean
) {
  if (!isOpen()) {
    return yield* failure(SnowflakeOperation.Closed)();
  }

  const lifetime = yield* Effect.acquireRelease(
    acquireLifetime(owner),
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
