import { Effect } from "effect";

import { optionsFromEnv } from "./options.ts";

// Validate names and credential wrapping without loading the native driver.
try {
  await Effect.runPromise(optionsFromEnv());
  console.info("Snowflake example configuration is valid.");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
