import { Effect } from "effect";

import type { SnowflakeOperationLabel } from "../operations.ts";
import { failure } from "../snowflake-error.ts";

/** ADBC JS cannot cancel promises; settle before releasing or reusing resources. */
export const call = <A>(
  operation: SnowflakeOperationLabel,
  run: () => Promise<A>
) =>
  Effect.tryPromise({ catch: failure(operation), try: run }).pipe(
    Effect.uninterruptible
  );
