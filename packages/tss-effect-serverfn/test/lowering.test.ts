import { fileURLToPath } from "node:url";

import { Predicate } from "effect";
import { createServer, normalizePath } from "vite";
import type { ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { effectServerFns } from "../src/vite.ts";

const id = normalizePath(
  fileURLToPath(new URL("fixtures/compiler-gate/virtual.ts", import.meta.url))
);

let server: ViteDevServer;

beforeAll(async () => {
  server = await createServer({
    configFile: false,
    server: { middlewareMode: true },
  });
});

afterAll(async () => {
  await server.close();
});

const imports =
  'import { createEffectServerFn as base } from "@rc312/tss-effect-serverfn";';

const lower = (code: string) => {
  const plugin = effectServerFns();
  const { transform } = plugin;

  if (!Predicate.isFunction(transform)) {
    throw new TypeError("Expected a transform hook");
  }

  // SAFETY: This transform uses only resolve from Vite's context; full builds exercise Vite itself.
  const context = {
    resolve: (source: string, importer: string) =>
      server.environments.ssr.pluginContainer.resolveId(source, importer),
  } as ThisParameterType<typeof transform>;

  return transform.call(context, code, id);
};

describe("binding-aware lowering", () => {
  it("keeps schema evaluation outside the handler and produces source maps", async () => {
    const output = await lower(
      `${imports}\nexport const call = base().validator(makeSchema()).handler(() => program);`
    );

    if (
      !output ||
      Predicate.isString(output) ||
      !Predicate.isString(output.code)
    ) {
      throw new Error("Missing generated code");
    }

    expect(output.code).toContain("prepareInput(makeSchema())");
    expect(output.code).toContain("effectHandler(() => program)");
    expect(output.map).toMatchObject({ sources: [id] });
    expect(await lower(output.code)).toBeUndefined();
  });

  it("respects shadowed bindings and leaves ordinary handlers alone", async () => {
    const code = `${imports}\nexport const unrelated = (base) => base().handler(() => 1);`;
    expect(await lower(code)).toBeUndefined();
  });

  it("recognizes namespace imports and transparent configured factory re-exports", async () => {
    const namespace = await lower(
      'import * as Adapter from "@rc312/tss-effect-serverfn"; export const call = Adapter.createEffectServerFn().handler(() => program);'
    );

    expect(namespace).toMatchObject({
      code: expect.stringContaining("effectHandler"),
    });

    const reexport = await lower(
      'import { createEffectServerFn } from "./factory.js"; export const call = createEffectServerFn().handler(() => program);'
    );

    expect(reexport).toMatchObject({
      code: expect.stringContaining("effectHandler"),
    });
  });

  it.each([
    'base()["handler"](() => program)',
    "base().unknown().handler(() => program)",
    "wrapper().handler(() => program)",
  ])("rejects unsupported composition %s", async (expression) => {
    await expect(
      lower(
        `${imports}\nconst wrapper = () => base(); export const call = ${expression};`
      )
    ).rejects.toThrow(/unsupported|not supported/iu);
  });

  it("follows explicit re-exports before export stars", async () => {
    expect(
      await lower(
        'import { configured } from "./exports.js"; export const call = configured().handler(() => program);'
      )
    ).toMatchObject({ code: expect.stringContaining("effectHandler") });
    expect(
      await lower(
        'import { createEffectServerFn } from "./exports.js"; export const call = createEffectServerFn().handler(() => program);'
      )
    ).toBeUndefined();
  });

  it.each(["base as Factory", "base satisfies Factory", "base!"])(
    "traces TypeScript aliases: %s",
    async (expression) => {
      expect(
        await lower(
          `${imports}\nconst configured = (${expression}); export const call = configured().handler(() => program);`
        )
      ).toMatchObject({ code: expect.stringContaining("effectHandler") });
    }
  );

  it("rejects reassigned factories", async () => {
    await expect(
      lower(
        `${imports}\nlet configured = base(); configured = other; export const call = configured.handler(() => program);`
      )
    ).rejects.toThrow("Mutable Effect factory");
  });
});
