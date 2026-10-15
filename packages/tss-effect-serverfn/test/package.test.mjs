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
    "createEffectMiddleware",
    "createEffectServerFn",
  ]);
});

test("the public entry point includes generated TypeScript declarations", async () => {
  const entry = manifest.exports["."];
  const declarationEntry = entry.replace(/\.js$/u, ".d.ts");

  const declarations = await readFile(
    new URL(`../${declarationEntry}`, import.meta.url),
    "utf-8"
  );

  assert.match(declarations, /export/u);
});

test("the server-only entry point exposes only the provenance hooks", async () => {
  const hooks = await import(
    new URL(`../${manifest.exports["./server"]}`, import.meta.url)
  );

  assert.deepEqual(Object.keys(hooks).toSorted(), [
    "acceptServerFnErrorEvent",
    "getServerFnFailureCause",
    "getServerFnFailureDisposition",
  ]);
  assert.deepEqual(Object.keys(manifest.exports).toSorted(), [
    ".",
    "./compiler-runtime",
    "./package.json",
    "./server",
    "./vite",
  ]);
});

test("source and declaration maps resolve to shipped TypeScript source", async () => {
  await Promise.all(
    ["index.js.map", "index.d.ts.map"].map(async (file) => {
      const mapUrl = new URL(`../dist/${file}`, import.meta.url);
      const map = JSON.parse(await readFile(mapUrl, "utf-8"));

      assert.equal(map.sources.length, 1);
      assert.equal(map.sources[0], "../src/index.ts");
      await readFile(new URL(map.sources[0], mapUrl), "utf-8");
    })
  );

  assert.ok(manifest.files.includes("src"));
});
