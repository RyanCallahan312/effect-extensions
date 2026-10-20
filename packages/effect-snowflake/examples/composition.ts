import * as Snowflake from "@rc312/effect-snowflake";
import { tableFromArrays } from "apache-arrow";
import { Effect, flow, Schema } from "effect";

import { runProgram } from "./run.ts";

// Build a reusable workflow, add decoding, then wrap the whole Effect in a
// transaction. No connection or callback needs to be threaded through its steps.
const lookup = flow(
  (id: bigint) =>
    Snowflake.query(
      'select ?::number(38, 0)::varchar as "id"',
      tableFromArrays({ id: new BigInt64Array([id]) })
    ),
  Effect.flatMap((table) =>
    Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))(
      table.get(0)?.toJSON()
    )
  ),
  Effect.map((row) => row.id),
  Snowflake.withTransaction
);

await runProgram(lookup(9_007_199_254_740_993n));
