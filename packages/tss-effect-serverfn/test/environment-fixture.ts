import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { Effect } from "effect";
import { expect } from "vitest";

import type * as Environment from "./fixtures/start/src/environment.ts";

export const verifyEnvironmentFunctions = async (
  root: string,
  environment: "client" | "server"
) => {
  const directory = path.join(
    root,
    "dist",
    environment === "client" ? "client/assets" : "server"
  );

  const files = await readdir(directory);
  const entry = "environment.js";

  // Execute actual environment-specific build output, not Start's uncompiled stubs.
  const utilities: typeof Environment = await import(
    pathToFileURL(path.join(directory, entry)).href
  );

  const messages: string[] = [];
  const record = (message: string) => messages.push(message);
  const expected = `environment-${environment}-private-implementation`;

  const own =
    environment === "server" ? utilities.serverEffect : utilities.clientEffect;

  const wrong =
    environment === "server" ? utilities.clientEffect : utilities.serverEffect;

  const optional =
    environment === "server"
      ? utilities.serverOptional
      : utilities.clientOptional;

  const missing =
    environment === "server"
      ? utilities.clientOptional
      : utilities.serverOptional;

  const program = own(record);
  expect(Effect.isEffect(program)).toBe(true);
  expect(messages).toEqual([]);
  expect(await Effect.runPromise(program)).toBe(expected);
  expect(messages).toEqual([expected]);
  expect(await Effect.runPromise(utilities.isomorphicEffect(record))).toBe(
    expected
  );
  expect(await Effect.runPromise(utilities.clientFirstEffect(record))).toBe(
    expected
  );

  const present = optional(record);
  expect(present).toBeDefined();

  if (!present) {
    throw new Error(`Missing ${environment} implementation`);
  }

  expect(await Effect.runPromise(present)).toBe(expected);
  expect(missing(record)).toBeUndefined();
  expect(() => wrong(record)).toThrow(/functions can only be called on the/u);
  expect(messages).toEqual([expected, expected, expected, expected]);

  const chunks = await Promise.all(
    files.flatMap((file) =>
      file.endsWith(".js")
        ? [readFile(path.join(directory, file), "utf-8")]
        : []
    )
  );

  expect(chunks.join("\n")).not.toContain(
    `environment-${environment === "server" ? "client" : "server"}-private-implementation`
  );
};
