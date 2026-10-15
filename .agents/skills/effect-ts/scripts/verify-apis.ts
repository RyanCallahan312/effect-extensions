#!/usr/bin/env bun

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import * as ts from "typescript/unstable/ast";

const defaultSkillRoot = resolve(import.meta.dir, "..");
const skillRoot = resolve(Bun.env.EFFECT_SKILL_ROOT ?? defaultSkillRoot);
const repoRoot = resolve(defaultSkillRoot, "../../..");
const sourceRoot = join(
  repoRoot,
  "packages/tss-effect-serverfn/node_modules/effect/src"
);
const banned = [
  [/\bEffect\.catchAll\b/g, "Effect.catch"],
  [/\bEffect\.either\b/g, "Effect.result"],
  [/\bEffect\.forkDaemon\b/g, "Effect.forkDetach"],
  [/\bEffect\.fork\s*\(/g, "Effect.forkChild / forkScoped / forkDetach"],
  [/\bLayer\.scoped\b/g, "Layer.effect"],
  [/\bContext\.(?:Tag|GenericTag)\b/g, "Context.Service"],
  [/\bEffect\.async\s*\(/g, "Effect.callback"],
  [/\bStream\.async\s*\(/g, "Stream.callback"],
  [/\bEffect\.transaction\b/g, "Effect.tx"],
  [/\bEffect\.retryTransaction\b/g, "Effect.txRetry"],
  [/\bEffect\.atomic\b/g, "Effect.tx"],
  [/\bEffect\.validateAll\b/g, "Effect.validate"],
  [/\bStream\.asyncPush\b/g, "Stream.callback"],
  [/\bStream\.asyncScoped\b/g, "Stream.callback"],
  [/\bStream\.asyncEffect\b/g, "Stream.callback"],
  [/\bStream\.flattenIterables\b/g, "Stream.flattenIterable"],
  [/\bChunk\.unsafeFromArray\b/g, "Chunk.fromArrayUnsafe"],
  [/\bCause\.isInterruptType\b/g, "Cause.isInterruptReason"],
  [/\bSchema\.makeUnsafe\b/g, "Schema.make"],
  [/\bServiceMap\./g, "Context"],
  [/\bSchema\.TaggedErrorClass\b/g, "Schema.TaggedError"],
  [/\bSchedule\.(?:both|either|take)\b/g, "Schedule.max / min / upTo"],
  [/effect\/unstable\//g, "effect/<public subpath> (check package exports)"],
] as const;

const apiSources = {
  Cache: "Cache.ts",
  Cause: "Cause.ts",
  Chunk: "Chunk.ts",
  Clock: "Clock.ts",
  Config: "Config.ts",
  ConfigProvider: "ConfigProvider.ts",
  Context: "Context.ts",
  Crypto: "Crypto.ts",
  Data: "Data.ts",
  DateTime: "DateTime.ts",
  Deferred: "Deferred.ts",
  Duration: "Duration.ts",
  Effect: "Effect.ts",
  Exit: "Exit.ts",
  Fiber: "Fiber.ts",
  Layer: "Layer.ts",
  Latch: "Latch.ts",
  ManagedRuntime: "ManagedRuntime.ts",
  Match: "Match.ts",
  Option: "Option.ts",
  PubSub: "PubSub.ts",
  Queue: "Queue.ts",
  Random: "Random.ts",
  Redacted: "Redacted.ts",
  Ref: "Ref.ts",
  Result: "Result.ts",
  Schedule: "Schedule.ts",
  Schema: "Schema.ts",
  SchemaTransformation: "SchemaTransformation.ts",
  Scope: "Scope.ts",
  Stream: "Stream.ts",
  TestClock: "testing/TestClock.ts",
  Activity: "workflow/Activity.ts",
  Entity: "cluster/Entity.ts",
  HttpClient: "http/HttpClient.ts",
  HttpClientRequest: "http/HttpClientRequest.ts",
  HttpClientResponse: "http/HttpClientResponse.ts",
  HttpIncomingMessage: "http/HttpIncomingMessage.ts",
  SqlClient: "sql/SqlClient.ts",
  SqlSchema: "sql/SqlSchema.ts",
  TestRunner: "cluster/TestRunner.ts",
  Workflow: "workflow/Workflow.ts",
  WorkflowEngine: "workflow/WorkflowEngine.ts",
} as const;
const markdownFencePattern = /^\s*(`{3,}|~{3,})(\w+)?/;
const inlineCodePattern = /(?<!`)`([^`\n]+)`(?!`)/g;
const scannedFenceLanguagePattern =
  /^(?:ts|tsx|typescript|mts|js|jsx|javascript)$/i;

// TypeScript 7 exposes a scanner, but no in-process createSourceFile API.
// Ignore comments and strings when inspecting member references; full example
// typechecking belongs to typecheck-examples.ts.
const tokens = (code: string) => {
  const scanner = ts.createScanner(true, ts.LanguageVariant.Standard, code);
  const output: Array<{ text: string; line: number }> = [];
  let line = 0;
  let previousEnd = 0;
  let previousStart = -1;
  for (
    let kind = scanner.scan();
    kind !== ts.SyntaxKind.EndOfFile;
    kind = scanner.scan()
  ) {
    const start = scanner.getTokenStart();
    if (start <= previousStart) {
      throw new Error(
        "verify-apis: scanner did not advance; typecheck this example directly"
      );
    }
    previousStart = start;
    line += (code.slice(previousEnd, start).match(/\n/g) ?? []).length;
    const text =
      kind === ts.SyntaxKind.StringLiteral ||
      kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral
        ? ""
        : scanner.getTokenText();
    output.push({ text, line });
    previousEnd = start;
  }
  return output;
};

const exportedSymbols = new Map<string, Set<string>>();
for (const [namespace, path] of Object.entries(apiSources)) {
  const file = join(sourceRoot, path);
  const source = readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const symbols = new Set<string>();
  for (const match of source.matchAll(
    /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:const|let|var|function|class|interface|type|enum|namespace)\s+([\w$]+)/gm
  )) {
    if (match[1]) {
      symbols.add(match[1]);
    }
  }
  for (const match of source.matchAll(/^export\s+(?:type\s+)?\{([^}]+)\}/gm)) {
    for (const entry of (match[1] ?? "").split(",")) {
      const name = entry.trim().split(/\s+/).at(-1);
      if (name) {
        symbols.add(name);
      }
    }
  }
  exportedSymbols.set(namespace, symbols);
}

type SourceUnit = {
  readonly code: string;
  readonly line: number;
  readonly source: string;
  readonly validateSyntax: boolean;
};

const markdownUnits = (file: string): SourceUnit[] => {
  const source = relative(skillRoot, file);
  const lines = readFileSync(file, "utf8").split("\n");
  const units: SourceUnit[] = [];
  let fenceMarker: string | undefined;
  let fenceLanguage = "";
  let fenceStart = 0;
  let fenceBody: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (!fenceMarker) {
      const opening = line.match(markdownFencePattern);
      if (opening?.[1]) {
        fenceMarker = opening[1];
        fenceLanguage = opening[2] ?? "";
        fenceStart = index + 2;
        fenceBody = [];
        continue;
      }
      for (const match of line.matchAll(inlineCodePattern)) {
        if (match[1]) {
          units.push({
            code: match[1],
            line: index + 1,
            source,
            validateSyntax: false,
          });
        }
      }
      continue;
    }
    const closing = new RegExp(
      `^\\s*${fenceMarker[0]}{${fenceMarker.length},}\\s*$`
    );
    if (closing.test(line)) {
      if (scannedFenceLanguagePattern.test(fenceLanguage)) {
        units.push({
          code: fenceBody.join("\n"),
          line: fenceStart,
          source,
          validateSyntax: true,
        });
      }
      fenceMarker = undefined;
      continue;
    }
    fenceBody.push(line);
  }
  return units;
};

const importedNamespaces = (source: string) => {
  const imports = new Map<string, string>();
  for (const match of source.matchAll(
    /\bimport\s+(?:type\s+)?\{([^}]+)\}\s+from\s+["']effect(?:\/[^"']+)?["']/g
  )) {
    for (const entry of (match[1] ?? "").split(",")) {
      const [exported, local = exported] = entry
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/);
      if (!exported || !local) {
        continue;
      }
      if (exported in apiSources) {
        imports.set(local, exported);
      }
    }
  }
  return imports;
};

function* contentFiles(directory: string): Generator<string> {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      yield* contentFiles(path);
    } else if ([".md", ".ts", ".tsx"].includes(extname(path))) {
      yield path;
    }
  }
}

const failures: string[] = [];
for (const file of contentFiles(skillRoot)) {
  // Validator implementations are not Effect examples. Scan the Markdown
  // examples and any standalone examples outside scripts/ instead.
  if (
    relative(skillRoot, file).startsWith("scripts/") ||
    file.endsWith(".test.ts")
  ) {
    continue;
  }
  const units =
    extname(file) === ".md"
      ? markdownUnits(file)
      : [
          {
            code: readFileSync(file, "utf8"),
            line: 1,
            source: relative(skillRoot, file),
            validateSyntax: true,
          },
        ];
  for (const unit of units) {
    for (const [pattern, replacement] of banned) {
      pattern.lastIndex = 0;
      const match = pattern.exec(unit.code);
      if (match) {
        failures.push(
          `${unit.source}:${unit.line} ${match[0]} -> ${replacement}`
        );
      }
    }
    if (!unit.validateSyntax) {
      for (const [namespace, symbols] of exportedSymbols) {
        const memberPattern = new RegExp(
          `(?<![\\w/])${namespace}\\.([A-Za-z_$][\\w$]*)`,
          "g"
        );
        for (const match of unit.code.matchAll(memberPattern)) {
          if (match[1] && !symbols.has(match[1])) {
            failures.push(
              `${unit.source}:${unit.line} ${namespace}.${match[1]} is not exported by installed ${namespace}`
            );
          }
        }
      }
      continue;
    }
    const imports = importedNamespaces(unit.code);
    const sourceTokens = tokens(unit.code);
    for (let index = 0; index < sourceTokens.length - 2; index++) {
      const token = sourceTokens[index];
      const dot = sourceTokens[index + 1];
      const member = sourceTokens[index + 2];
       if (!token || dot?.text !== "." || !member) {
         continue;
       }
      const namespace = imports.get(token.text);
      const symbols = namespace ? exportedSymbols.get(namespace) : undefined;
      if (namespace && symbols && !symbols.has(member.text)) {
        failures.push(
          `${unit.source}:${unit.line + token.line} ${namespace}.${member.text} is not exported by installed ${namespace}`
        );
      }
    }
  }
}

if (failures.length > 0) {
  console.error(
    `verify-apis: ${failures.length} stale API reference(s)\n${failures.join("\n")}`
  );
  process.exit(1);
}

console.log("verify-apis: installed Effect API references resolve");
