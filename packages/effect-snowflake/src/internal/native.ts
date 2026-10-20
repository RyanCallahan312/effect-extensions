import { Effect } from "effect";

import { failure } from "../snowflake-error.ts";

/** ADBC JS cannot cancel promises; settle before releasing or reusing resources. */
export const call = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({ catch: failure(operation), try: run }).pipe(
    Effect.uninterruptible
  );
