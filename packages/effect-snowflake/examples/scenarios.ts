import type { SnowflakeClient } from "@rc312/effect-snowflake";
import {
  Bool,
  Int64,
  Table,
  tableFromArrays,
  Utf8,
  vectorFromArray,
} from "apache-arrow";
import { Data, Effect, Schema, Stream } from "effect";

const queryRow = Schema.Struct({
  enabled: Schema.Boolean,
  id: Schema.String,
  label: Schema.String,
  optional: Schema.Null,
});

/** Bind Arrow int64, text, boolean, and a typed null, then decode a result. */
export const queryExample = Effect.fn("Snowflake.Example.query")(
  function* query(client: SnowflakeClient) {
    const parameters = new Table({
      enabled: vectorFromArray([true], new Bool()),
      id: vectorFromArray([9_007_199_254_740_993n], new Int64()),
      label: vectorFromArray(["hello ? -- Snowflake"], new Utf8()),
      optional: vectorFromArray([null], new Utf8()),
    });

    const result = yield* client.query(
      'select ?::boolean as "enabled", ?::number(38, 0)::varchar as "id", ?::varchar as "label", ?::varchar as "optional"',
      parameters
    );

    return yield* Schema.decodeUnknownEffect(queryRow)(result.get(0)?.toJSON());
  }
);

/** Count a complete stream, stop another after one batch, then reuse its client. */
export const streamExample = Effect.fn("Snowflake.Example.stream")(
  function* stream(client: SnowflakeClient) {
    const totalRows = yield* client
      .stream("select seq4() from table(generator(rowcount => 1000))")
      .pipe(
        Stream.runFold(
          () => 0,
          (count, batch) => count + batch.numRows
        )
      );

    const firstBatchRows = yield* client
      .stream("select seq4() from table(generator(rowcount => 100000))")
      .pipe(
        Stream.filter((batch) => batch.numRows > 0),
        Stream.take(1),
        Stream.runFold(
          () => 0,
          (count, batch) => count + batch.numRows
        )
      );

    const next = yield* client.query("select 'ok' as \"status\"");

    const { status } = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ status: Schema.Literal("ok") })
    )(next.get(0)?.toJSON());

    return { firstBatchRows, status, totalRows };
  }
);

class RollbackExample extends Data.TaggedError("RollbackExample") {}

/** Create a session-temporary table before DML transactions and always drop it. */
export const transactionExample = Effect.fn("Snowflake.Example.transaction")(
  function* transactions(client: SnowflakeClient) {
    return yield* Effect.acquireUseRelease(
      client.execute(
        "create temporary table EFFECT_SNOWFLAKE_EXAMPLE (ID number(38, 0))"
      ),
      () =>
        Effect.gen(function* commitAndRollback() {
          yield* client
            .execute(
              "insert into EFFECT_SNOWFLAKE_EXAMPLE values (?)",
              tableFromArrays({ id: [1] })
            )
            .pipe(client.withTransaction);
          yield* client
            .execute(
              "insert into EFFECT_SNOWFLAKE_EXAMPLE values (?)",
              tableFromArrays({ id: [2] })
            )
            .pipe(
              Effect.andThen(Effect.fail(new RollbackExample())),
              client.withTransaction,
              Effect.catchTag("RollbackExample", () => Effect.void)
            );

          const rows = yield* client.query(
            'select ID::varchar as "id" from EFFECT_SNOWFLAKE_EXAMPLE order by ID'
          );

          return yield* Schema.decodeEffect(
            Schema.Array(Schema.Struct({ id: Schema.String }))
          )(Array.from(rows, (row) => row.toJSON()));
        }),
      // A failed drop must remain visible even when the transaction already failed.
      () =>
        client
          .execute("drop table if exists EFFECT_SNOWFLAKE_EXAMPLE")
          .pipe(Effect.orDie)
    );
  }
);
