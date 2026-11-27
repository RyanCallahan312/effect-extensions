import { Table } from "apache-arrow";
import type { RecordBatch } from "apache-arrow";
import { Cause, Effect, flow, pipe, Stream } from "effect";
import type { Scope, Semaphore } from "effect";

import type { Statement } from "../adbc-driver.ts";
import type { SnowflakeSession } from "../models.ts";
import { SnowflakeOperation } from "../operations.ts";
import { failure } from "../snowflake-error.ts";
import type { Connection } from "./connection.ts";
import { owned } from "./lifecycle.ts";
import { call } from "./native.ts";
import { ownedStream } from "./stream.ts";

type Reader = Awaited<ReturnType<Statement["executeQuery"]>>;

const executeStatement = (statement: Statement) =>
  call(SnowflakeOperation.Execute, () => statement.executeUpdate());

const readBatch = (
  source: Reader,
  operation:
    | typeof SnowflakeOperation.QueryRead
    | typeof SnowflakeOperation.StreamRead
) => call(operation, () => Promise.resolve(source.next()));

const collectBatches = Effect.fnUntraced(function* collectQueryBatches(
  source: Reader
) {
  const schema = yield* call(SnowflakeOperation.QueryRead, async () => {
    await source.open();

    return source.schema;
  });

  const batches: RecordBatch[] = [];

  // Wait for the current read to settle so interruption can stop the next read.
  let result = yield* readBatch(source, SnowflakeOperation.QueryRead);

  while (!result.done) {
    batches.push(result.value);
    result = yield* readBatch(source, SnowflakeOperation.QueryRead);
  }

  return yield* Effect.try({
    catch: failure(SnowflakeOperation.QueryRead),
    try: () => new Table(schema, batches),
  });
});

// fromAsyncIterable installs an unsanitized iterator.return finalizer. The scoped
// reader.cancel owns cleanup; this pull only reads on downstream demand.
const streamBatches = (source: Reader) =>
  pipe(
    readBatch(source, SnowflakeOperation.StreamRead),
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
      return yield* failure(SnowflakeOperation.Closed)();
    }

    const resource = yield* Effect.acquireRelease(
      call(SnowflakeOperation.StatementCreate, () =>
        connection.native.createStatement()
      ),
      (value) =>
        connection.cleanup(SnowflakeOperation.StatementClose, () =>
          value.close()
        )
    );

    yield* call(SnowflakeOperation.StatementSql, () =>
      resource.setSqlQuery(sql)
    );

    if (parameters !== undefined) {
      yield* call(SnowflakeOperation.StatementBind, () =>
        resource.bind(parameters)
      );
    }

    return resource;
  });

  const reader = Effect.fnUntraced(function* acquireReader(
    sql: string,
    parameters?: Table
  ) {
    const resource = yield* statement(sql, parameters);

    return yield* Effect.acquireRelease(
      call(SnowflakeOperation.Query, () => resource.executeQuery()),
      (value) =>
        connection.cleanup(SnowflakeOperation.ReaderClose, async () => {
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
