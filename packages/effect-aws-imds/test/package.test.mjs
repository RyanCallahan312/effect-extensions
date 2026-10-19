import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const manifest = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf-8")
);

test("the public entry point resolves to built JavaScript", async () => {
  const entry = manifest.exports["."];
  assert.equal(entry, "./dist/index.js");
  const api = await import(new URL(`../${entry}`, import.meta.url));
  assert.deepEqual(Object.keys(api).toSorted(), [
    "AwsImds",
    "AwsImdsConfig",
    "AwsImdsMetadataError",
    "AwsImdsToken",
    "AwsImdsTokenError",
    "IdentityDocument",
    "InstanceIdentity",
    "clearCache",
    "get",
    "getSchema",
    "identityDocument",
    "imdsTransport",
    "layer",
    "layerFetch",
    "optional",
    "retryPolicy",
    "withSessionToken",
  ]);
  assert.deepEqual(Object.keys(manifest.exports).toSorted(), [
    ".",
    "./package.json",
  ]);
});

test("the package has no runtime dependencies beyond its effect peer", () => {
  assert.equal(manifest.dependencies, undefined);
  assert.deepEqual(Object.keys(manifest.peerDependencies), ["effect"]);
});

test("the public entry point includes generated TypeScript declarations", async () => {
  const declarations = await readFile(
    new URL("../dist/index.d.ts", import.meta.url),
    "utf-8"
  );

  assert.match(declarations, /export/u);
});
