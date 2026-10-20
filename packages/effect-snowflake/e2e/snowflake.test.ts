import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { make } from "@rc312/effect-snowflake";
import type { SnowflakeClient } from "@rc312/effect-snowflake";
import { Effect } from "effect";

import { optionsFromEnv } from "../examples/options.ts";
import {
  queryExample,
  streamExample,
  transactionExample,
} from "../examples/scenarios.ts";

const live = <A, E>(use: (client: SnowflakeClient) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* connectAndRun() {
        const options = yield* optionsFromEnv();

        return yield* use(yield* make(options));
      })
    )
  );

// Opt in at the test-process boundary. Ordinary unit tests never contact Snowflake.
describe(
  "Snowflake ADBC live examples",
  { concurrency: false, skip: process.env.SNOWFLAKE_E2E !== "1" },
  () => {
    it(
      "binds a precision-sensitive int64, text, boolean, and typed null",
      { timeout: 120_000 },
      async () => {
        assert.deepEqual(await live(queryExample), {
          enabled: true,
          id: "9007199254740993",
          label: "hello ? -- Snowflake",
          optional: null,
        });
      }
    );

    it(
      "drains batches and reuses a connection after early termination",
      { timeout: 120_000 },
      async () => {
        const result = await live(streamExample);
        assert.equal(result.totalRows, 1000);
        assert.ok(
          result.firstBatchRows > 0 && result.firstBatchRows <= 100_000
        );
        assert.equal(result.status, "ok");
      }
    );

    it(
      "commits one insert, rolls another back, and cleans up its temporary table",
      { timeout: 120_000 },
      async () => {
        assert.deepEqual(await live(transactionExample), [{ id: "1" }]);
      }
    );

    it(
      "retains schema when a native query returns no rows",
      { timeout: 120_000 },
      async () => {
        const table = await live((client) =>
          client.query('select 1::varchar as "id" where false')
        );

        assert.equal(table.numRows, 0);
        assert.deepEqual(
          table.schema.fields.map((field) => field.name),
          ["id"]
        );
      }
    );

    it(
      "rejects a retained client after the owning scope closes",
      { timeout: 120_000 },
      async () => {
        const client = await live((db) => Effect.succeed(db));

        const error = await Effect.runPromise(
          client.query("select 1").pipe(Effect.flip)
        );

        assert.equal(error.operation, "closed");
      }
    );
  }
);
