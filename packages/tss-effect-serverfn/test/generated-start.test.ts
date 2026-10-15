import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { effectServerFns } from "tss-effect-serverfn/vite";
import { createBuilder } from "vite";
import { describe, expect, it } from "vitest";

import {
  invokeClientRpc,
  invokeTransformedClientServerFn,
} from "./transport-fixture.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

describe("generated Start HTTP handler", () => {
  it.each(["src", "dist"])(
    "executes %s through the real provider and RPC serializer",
    async (directory) => {
      const root = await mkdtemp(path.join(packageRoot, ".cache/start-"));

      try {
        await cp(path.join(packageRoot, "test/fixtures/start"), root, {
          recursive: true,
        });

        const builder = await createBuilder({
          configFile: false,
          logLevel: "silent",
          plugins: [effectServerFns(), tanstackStart()],
          resolve: {
            alias: [
              {
                find: "tss-effect-serverfn/compiler-runtime",
                replacement: path.join(
                  packageRoot,
                  directory,
                  `compiler-runtime.${directory === "src" ? "ts" : "js"}`
                ),
              },
              {
                find: "tss-effect-serverfn",
                replacement: path.join(
                  packageRoot,
                  directory,
                  `index.${directory === "src" ? "ts" : "js"}`
                ),
              },
            ],
          },
          root,
        });

        await builder.buildApp();
        const files = await readdir(path.join(root, "dist/server"));
        expect(files).toContain("server.js");

        const { default: server } = await import(
          pathToFileURL(path.join(root, "dist/server/server.js")).href
        );

        const page = await server.fetch(new Request("http://localhost/"));
        const html = await page.text();

        const endpoint = /id="endpoint" href="(?<endpoint>[^"]+)"/u.exec(html)
          ?.groups?.endpoint;

        expect(endpoint, html).toBeDefined();

        if (!endpoint) {
          throw new Error("SSR did not expose the generated endpoint");
        }

        const statuses: number[] = [];

        const transport =
          (signal?: AbortSignal, target = endpoint) =>
          async (
            _url: string | URL | Request,
            init?: RequestInit
          ): Promise<Response> => {
            const headers = new Headers(init?.headers);
            headers.set("sec-fetch-site", "same-origin");
            headers.set("origin", "http://localhost");

            const url = new URL(target, "http://localhost");
            url.search = new URL(
              _url instanceof Request ? _url.url : String(_url),
              "http://localhost"
            ).search;

            const response = await server.fetch(
              new Request(url, {
                ...init,
                headers,
                signal: signal ?? null,
              })
            );

            statuses.push(response.status);

            return response;
          };

        const call = (
          data: { id: string; title: string },
          signal?: AbortSignal
        ) => invokeClientRpc("fixture", data, transport(signal));

        expect(await call({ id: "1", title: "Renamed" })).toEqual({
          result: { id: "1", title: "Renamed" },
        });

        const greeting = /id="quick-start" href="(?<endpoint>[^"]+)"/u.exec(
          html
        )?.groups?.endpoint;

        if (!greeting) {
          throw new Error("Quick-start endpoint was not compiled");
        }

        expect(
          await invokeClientRpc(
            "quick-start",
            { name: "Ada" },
            transport(undefined, greeting),
            "GET"
          )
        ).toEqual({ result: { message: "Hello, Ada!" } });

        const utilityCalls = [
          ["native-function", "native-result"],
          [
            "effect-function",
            [
              "environment-server-private-implementation",
              "environment-server-private-implementation",
            ],
          ],
        ] as const;

        await Promise.all(
          utilityCalls.map(async ([name, expected]) => {
            const target = new RegExp(
              `id="${name}" href="(?<endpoint>[^"]+)"`,
              "u"
            ).exec(html)?.groups?.endpoint;

            if (!target) {
              throw new Error(`Missing ${name} endpoint`);
            }

            expect(
              await invokeClientRpc(
                name,
                undefined,
                transport(undefined, target),
                "GET"
              )
            ).toEqual({ result: expected });
          })
        );

        expect(await call({ id: "", title: "invalid" })).toEqual({
          error: { code: "INVALID_INPUT", message: "Invalid input" },
        });
        expect(statuses.at(-1)).toBe(400);
        expect(await call({ id: "missing", title: "Missing" })).toEqual({
          error: { code: "MISSING", message: "Not found" },
        });
        expect(await call({ id: "defect", title: "Private" })).toEqual({
          error: { code: "INTERNAL", message: "Internal error" },
        });
        expect(await call({ id: "native-invalid", title: "Private" })).toEqual({
          error: { code: "INTERNAL", message: "Internal error" },
        });
        await expect(
          invokeTransformedClientServerFn(
            "fixture",
            { id: "missing", title: "Missing" },
            transport()
          )
        ).rejects.toEqual({ code: "MISSING", message: "Not found" });
        const response = await call({ id: "response", title: "raw" });
        expect(response).toBeInstanceOf(Response);

        if (!(response instanceof Response)) {
          throw new Error("Expected a native Response");
        }

        expect(response.status).toBe(201);
        expect(await response.text()).toBe("raw");
        await expect(
          invokeTransformedClientServerFn(
            "fixture",
            { id: "denied", title: "denied" },
            transport()
          )
        ).rejects.toMatchObject({ status: 403 });
        await expect(
          invokeTransformedClientServerFn(
            "fixture",
            { id: "redirect", title: "redirect" },
            transport()
          )
        ).rejects.toMatchObject({ options: { href: "/login" } });
        await expect(
          invokeTransformedClientServerFn(
            "fixture",
            { id: "notFound", title: "missing" },
            transport()
          )
        ).rejects.toMatchObject({ isNotFound: true });
        const controller = new AbortController();
        const waiting = call({ id: "wait", title: "wait" }, controller.signal);

        try {
          expect(await call({ id: "wait-entered", title: "wait" })).toEqual({
            result: "entered",
          });
          controller.abort();
          await waiting.catch(() => {});
          expect(await call({ id: "wait-released", title: "wait" })).toEqual({
            result: "released",
          });
        } finally {
          controller.abort();
        }

        const clientFiles = await readdir(
          path.join(root, "dist/client/assets")
        );

        const chunks = await Promise.all(
          clientFiles.flatMap((file) =>
            file.endsWith(".js")
              ? [readFile(path.join(root, "dist/client/assets", file), "utf-8")]
              : []
          )
        );

        const client = chunks.join("\n");
        expect(client).not.toContain("never-send-this");
        expect(client).not.toContain("http-fixture/Notes");
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    },
    60_000
  );
});
