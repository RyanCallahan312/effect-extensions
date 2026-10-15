import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { Predicate } from "effect";
import { createServer } from "vite";
import { expect, it } from "vitest";

import { effectServerFns } from "../src/vite.ts";
import { invokeClientRpc } from "./transport-fixture.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

it("executes the API through Start's dev provider after invalidation", async () => {
  const root = await mkdtemp(path.join(packageRoot, ".cache/dev-"));
  await cp(path.join(packageRoot, "test/fixtures/start"), root, {
    recursive: true,
  });

  const dev = await createServer({
    configFile: false,
    logLevel: "silent",
    plugins: [effectServerFns(), tanstackStart()],
    root,
    server: { host: "127.0.0.1", port: 0 },
  });

  try {
    await dev.listen();
    const address = dev.httpServer?.address();

    if (!address || Predicate.isString(address)) {
      throw new Error("Dev server has no address");
    }

    const origin = `http://127.0.0.1:${address.port}`;
    const page = await fetch(origin);
    const html = await page.text();

    const endpoint = /id="endpoint" href="(?<endpoint>[^"]+)"/u.exec(html)
      ?.groups?.endpoint;

    if (!endpoint) {
      throw new Error(`Missing dev endpoint: ${html}`);
    }

    const call = () =>
      invokeClientRpc(
        "dev-fixture",
        { id: "1", title: "before" },
        (_url, init) => {
          const headers = new Headers(init?.headers);
          headers.set("origin", origin);
          headers.set("sec-fetch-site", "same-origin");

          return fetch(new URL(endpoint, origin), { ...init, headers });
        }
      );

    expect(await call()).toEqual({ result: { id: "1", title: "before" } });
    const source = path.join(root, "src/notes.functions.js");
    const original = await readFile(source, "utf-8");
    await writeFile(
      source,
      original.replace(
        "notes.rename(data.id, data.title)",
        'notes.rename(data.id, "after")'
      )
    );

    for (const environment of Object.values(dev.environments)) {
      environment.moduleGraph.invalidateAll();
    }

    expect(await call()).toEqual({ result: { id: "1", title: "after" } });
  } finally {
    await dev.close();
    await rm(root, { force: true, recursive: true });
  }
}, 60_000);
