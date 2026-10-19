/**
 * Runs the mock IMDS until interrupted, for trying the example by hand:
 *
 *   MOCK_IMDS_PORT=1338 MOCK_IMDS_SCENARIO=flaky bun run mock
 */
import { Schema } from "effect";

import { Scenario, startMockImds } from "./mock-imds.ts";

const scenario = Schema.decodeUnknownSync(Scenario)(
  process.env.MOCK_IMDS_SCENARIO ?? "healthy"
);

const port = Schema.decodeSync(Schema.FiniteFromString.check(Schema.isInt()))(
  process.env.MOCK_IMDS_PORT ?? "1338"
);

const mock = await startMockImds(scenario, port);

process.stdout.write(`Mock IMDS (${scenario}) listening on ${mock.url}\n`);

process.once("SIGINT", () => {
  void mock.close();
});
