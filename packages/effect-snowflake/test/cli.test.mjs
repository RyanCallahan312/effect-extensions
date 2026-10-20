import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("..", import.meta.url));

const cleanEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.startsWith("SNOWFLAKE_") && key !== "NODE_TEST_CONTEXT"
  )
);

const configuredEnvironment = {
  ...cleanEnvironment,
  SNOWFLAKE_ACCOUNT: "example-account",
  SNOWFLAKE_ADBC_DRIVER: "/nonexistent/effect-snowflake-e2e-driver",
  SNOWFLAKE_DATABASE: "EXAMPLE_DB",
  SNOWFLAKE_PASSWORD: "credential-must-not-escape-cli",
  SNOWFLAKE_SCHEMA: "PUBLIC",
  SNOWFLAKE_USERNAME: "example-user",
  SNOWFLAKE_WAREHOUSE: "EXAMPLE_WH",
};

const run = (args, env) =>
  spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf-8",
    env,
    timeout: 20_000,
  });

test("the compiled configuration CLI succeeds without a native driver", () => {
  const result = run(
    [".cache/examples/examples/check.js"],
    configuredEnvironment
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /configuration is valid/u);
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /credential-must-not-escape-cli/u
  );
});

test("the compiled query CLI exits unsuccessfully with a sanitized native error", () => {
  const result = run(
    [".cache/examples/examples/query.js"],
    configuredEnvironment
  );

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Snowflake database.open failed/u);
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /credential-must-not-escape-cli/u
  );
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /Could not load|cannot open shared object/u
  );
});

test("the compiled configuration CLI fails clearly when settings are missing", () => {
  const result = run([".cache/examples/examples/check.js"], cleanEnvironment);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /SNOWFLAKE_ACCOUNT/u);
});

test("the compiled E2E harness skips Snowflake when not opted in", () => {
  const result = run(
    ["--test", "--test-reporter=tap", ".cache/examples/e2e/snowflake.test.js"],
    {
      ...cleanEnvironment,
      SNOWFLAKE_E2E: "0",
    }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /skipped|SKIP/u);
});
