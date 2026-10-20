import { Table } from "apache-arrow";
import type { RecordBatch } from "apache-arrow";
import { Effect, pipe, Stream } from "effect";
import type { Scope, Semaphore } from "effect";

import type { SnowflakeSession } from "../models.ts";
import { failure } from "../snowflake-error.ts";
import type { Connection } from "./connection.ts";
import { owned, ownedStream } from "./lifecycle.ts";
import { call } from "./native.ts";

/** Build session operations over a captured connection, permit, and owning scope. */
export const make = (
  connection: Connection,
  owner: Scope.Scope,
  mutex: Semaphore.Semaphore,
  active: () => boolean
): SnowflakeSession => {
  const statement = Effect.fnUntraced(function* acquireStatement(
    sql: string,
    parameters?: Table
  ) {
    if (!active()) {
      return yield* failure("closed")();
    }

    const resource = yield* Effect.acquireRelease(
      call("statement.create", () => connection.native.createStatement()),
      (value) => connection.cleanup("statement.close", () => value.close())
    );

    yield* call("statement.sql", () => resource.setSqlQuery(sql));

    if (parameters !== undefined) {
      yield* call("statement.bind", () => resource.bind(parameters));
    }

    return resource;
  });

  const reader = Effect.fnUntraced(function* acquireReader(
    sql: string,
    parameters?: Table
  ) {
    const resource = yield* statement(sql, parameters);

    return yield* Effect.acquireRelease(
      call("query", () => resource.executeQuery()),
      (value) =>
        connection.cleanup("reader.close", async () => {
          await value.cancel();
        })
    );
  });

  const run = <A, E, R>(effect: Effect.Effect<A, E, R | Scope.Scope>) =>
    pipe(effect, Effect.scoped, mutex.withPermit, (self) =>
      owned(self, owner, active)
    );

  return {
    execute: Effect.fn("Snowflake.execute")(function* executeStatement(
      sql: string,
      parameters?: Table
    ) {
      const resource = yield* statement(sql, parameters);

      return yield* call("execute", () => resource.executeUpdate());
    }, run),
    query: Effect.fn("Snowflake.query")(function* collectQuery(
      sql: string,
      parameters?: Table
    ) {
      const source = yield* reader(sql, parameters);

      return yield* call("query.read", async () => {
        await source.open();
        const { schema } = source;
        const batches: RecordBatch[] = [];

        for await (const batch of source) {
          batches.push(batch);
        }

        return new Table(schema, batches);
      });
    }, run),
    stream: (sql, parameters) =>
      pipe(
        Stream.unwrap(
          Effect.gen(function* acquireBatchStream() {
            yield* Effect.acquireRelease(mutex.take(1), () => mutex.release(1));
            const source = yield* reader(sql, parameters);

            return Stream.transformPull(
              Stream.fromAsyncIterable(source, failure("stream.read")),
              (pull) => Effect.succeed(Effect.uninterruptible(pull))
            );
          })
        ),
        (self) => ownedStream(self, owner, active),
        Stream.withSpan("Snowflake.stream")
      ),
  };
};
