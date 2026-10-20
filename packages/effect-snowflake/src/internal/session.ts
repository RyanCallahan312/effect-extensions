import { Table } from "apache-arrow";
import type { RecordBatch } from "apache-arrow";
import { Cause, Effect, flow, pipe, Stream } from "effect";
import type { Scope, Semaphore } from "effect";

import type { Statement } from "../adbc-driver.ts";
import type { SnowflakeSession } from "../models.ts";
import { failure } from "../snowflake-error.ts";
import type { Connection } from "./connection.ts";
import { owned, ownedStream } from "./lifecycle.ts";
import { call } from "./native.ts";

type Reader = Awaited<ReturnType<Statement["executeQuery"]>>;

const executeStatement = (statement: Statement) =>
  call("execute", () => statement.executeUpdate());

const collectBatches = (source: Reader) =>
  call("query.read", async () => {
    await source.open();
    const { schema } = source;
    const batches: RecordBatch[] = [];

    for await (const batch of source) {
      batches.push(batch);
    }

    return new Table(schema, batches);
  });

// fromAsyncIterable installs an unsanitized iterator.return finalizer. The scoped
// reader.cancel owns cleanup; this pull only reads on downstream demand.
const streamBatches = (source: Reader) =>
  pipe(
    call("stream.read", () => Promise.resolve(source.next())),
    Effect.flatMap((result) =>
      result.done ? Cause.done() : Effect.succeed([result.value] as const)
    ),
    Effect.succeed,
    Stream.fromPull
  );

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

  const permit = Effect.acquireRelease(mutex.take(1), () => mutex.release(1));

  return {
    execute: Effect.fn("Snowflake.execute")(
      flow(statement, Effect.flatMap(executeStatement), run)
    ),
    query: Effect.fn("Snowflake.query")(
      flow(reader, Effect.flatMap(collectBatches), run)
    ),
    stream: (sql, parameters) =>
      pipe(
        permit,
        Effect.andThen(reader(sql, parameters)),
        Effect.map(streamBatches),
        Stream.unwrap,
        (self) => ownedStream(self, owner, active),
        Stream.withSpan("Snowflake.stream")
      ),
  };
};
