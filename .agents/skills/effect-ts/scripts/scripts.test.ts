import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../../../");
const temporaryDirectories: string[] = [];

const makeSkill = (files: Record<string, string>) => {
  const directory = mkdtempSync(join(tmpdir(), "effect-skill-test-"));
  temporaryDirectories.push(directory);
  for (const [path, content] of Object.entries(files)) {
    const target = join(directory, path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content);
  }
  return directory;
};

const runScript = (name: string, skillRoot: string) => {
  const process = Bun.spawnSync(["bun", join(import.meta.dir, name)], {
    cwd: repoRoot,
    env: { ...Bun.env, EFFECT_SKILL_ROOT: skillRoot },
    stderr: "pipe",
    stdout: "pipe",
  });
  return {
    exitCode: process.exitCode,
    output: `${process.stdout.toString()}${process.stderr.toString()}`,
  };
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("effect skill validators", () => {
  it("typechecks each markdown example as an isolated module", () => {
    const skillRoot = makeSkill({
      "SKILL.md": [
        "```ts",
        "const declarationFromAnotherExample = 1",
        "```",
        "",
        "```ts",
        "declarationFromAnotherExample.toFixed()",
        "```",
      ].join("\n"),
    });

    const result = runScript("typecheck-examples.ts", skillRoot);

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("declarationFromAnotherExample");
  });

  it("rejects compiler suppression directives in examples", () => {
    const skillRoot = makeSkill({
      "SKILL.md": [
        "```ts",
        "// @ts-ignore",
        "const value: string = 1",
        "```",
      ].join("\n"),
    });

    const result = runScript("typecheck-examples.ts", skillRoot);

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("suppression directive");
  });

  it("recognizes TypeScript fence variants", () => {
    const skillRoot = makeSkill({
      "SKILL.md": [
        "```TSX",
        "const Component = () => null",
        "const value = <Component />",
        "```",
      ].join("\n"),
    });

    const result = runScript("typecheck-examples.ts", skillRoot);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("1 isolated TypeScript example(s) compile");
  });

  it("rejects links to missing markdown fragments", () => {
    const skillRoot = makeSkill({
      "SKILL.md": "[missing](./reference.md#does-not-exist)\n",
      "reference.md": "# Existing heading\n",
    });

    const result = runScript("check-links.ts", skillRoot);

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("does-not-exist");
  });

  it("ignores markdown links and headings inside code fences", () => {
    const skillRoot = makeSkill({
      "SKILL.md": [
        "```md",
        "# Not a rendered heading",
        "[example](./missing.md)",
        "```",
        "",
        "# Real heading",
        "",
        "[self](#real-heading)",
      ].join("\n"),
    });

    const result = runScript("check-links.ts", skillRoot);

    expect(result.exitCode).toBe(0);
  });

  it("rejects Effect API symbols absent from the installed source", () => {
    const skillRoot = makeSkill({
      "SKILL.md": [
        "```ts",
        'import { Effect } from "effect"',
        "Effect.thisApiDoesNotExist()",
        "```",
      ].join("\n"),
    });

    const result = runScript("verify-apis.ts", skillRoot);

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("Effect.thisApiDoesNotExist");
  });

  it("rejects stale Effect APIs in inline code", () => {
    const skillRoot = makeSkill({
      "SKILL.md": "Use `Effect.catchAll` to recover.\n",
    });

    const result = runScript("verify-apis.ts", skillRoot);

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("Effect.catchAll");
  });

  it("accepts shorthand exports from installed Effect modules", () => {
    const skillRoot = makeSkill({
      "SKILL.md": [
        "```ts",
        'import { Schema } from "effect"',
        "declare const error: Schema.SchemaError",
        "```",
      ].join("\n"),
    });

    const result = runScript("verify-apis.ts", skillRoot);

    expect(result.exitCode).toBe(0);
  });

  it("accepts stable Effect 4 constructors and subpath imports", () => {
    const skillRoot = makeSkill({
      "SKILL.md": [
        "```ts",
        'import { Config, Schema, Schedule } from "effect"',
        'import { HttpClient } from "effect/http"',
        'Config.Redacted("API_KEY")',
        'Schema.TaggedError',
        'Schedule.upTo({ times: 3 })',
        'HttpClient.filterStatusOk',
        "```",
      ].join("\n"),
    });

    expect(runScript("verify-apis.ts", skillRoot).exitCode).toBe(0);
  });

  it("rejects beta constructors and old module paths", () => {
    const skillRoot = makeSkill({
      "SKILL.md": [
        "Use `Schema.TaggedErrorClass`, `Config.string`, and `Schedule.both`.",
        'Import from `effect/unstable/http`.',
      ].join("\n"),
    });

    const result = runScript("verify-apis.ts", skillRoot);

    expect(result.exitCode).not.toBe(0);
    for (const stale of [
      "TaggedErrorClass",
      "Config.string",
      "Schedule.both",
      "effect/unstable/",
    ]) {
      expect(result.output).toContain(stale);
    }
  });

  it("checks aliased imports and subpath API members", () => {
    const skillRoot = makeSkill({
      "SKILL.md": [
        "```ts",
        'import { Effect as Fx } from "effect"',
        'import { HttpClient } from "effect/http"',
        'Fx.thisApiDoesNotExist()',
        'HttpClient.thisApiDoesNotExist()',
        "```",
      ].join("\n"),
    });

    const result = runScript("verify-apis.ts", skillRoot);

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("Effect.thisApiDoesNotExist");
    expect(result.output).toContain("HttpClient.thisApiDoesNotExist");
  });

  it("typechecks examples against stable Effect 4, not beta declarations", () => {
    const skillRoot = makeSkill({
      "SKILL.md": [
        "```ts",
        'import { Config } from "effect"',
        'export const key = Config.redacted("API_KEY")',
        "```",
      ].join("\n"),
    });

    const result = runScript("typecheck-examples.ts", skillRoot);

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("redacted");
  });
});
