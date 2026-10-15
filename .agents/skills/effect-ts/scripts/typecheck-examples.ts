#!/usr/bin/env bun

import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, relative, resolve } from "node:path";
import { $ } from "bun";
import * as ts from "typescript/unstable/ast";

const defaultSkillRoot = resolve(import.meta.dir, "..");
const skillRoot = resolve(Bun.env.EFFECT_SKILL_ROOT ?? defaultSkillRoot);
const repoRoot = resolve(defaultSkillRoot, "../../..");
const effectModules = join(repoRoot, "packages/tss-effect-serverfn/node_modules");
const fence = /^\s*(`{3,}|~{3,})(ts|tsx|typescript|mts)(?:\s+.*)?$/i;
const suppression = /@ts-(?:ignore|nocheck|expect-error)|@effect-diagnostics/;

const containsSuppressionComment = (code: string) => {
  const scanner = ts.createScanner(
    false,
    ts.LanguageVariant.JSX,
    code
  );
  for (
    let token = scanner.scan();
    token !== ts.SyntaxKind.EndOfFile;
    token = scanner.scan()
  ) {
    if (
      (token === ts.SyntaxKind.SingleLineCommentTrivia ||
        token === ts.SyntaxKind.MultiLineCommentTrivia) &&
      suppression.test(scanner.getTokenText())
    ) {
      return true;
    }
  }
  return false;
};

function* markdownFiles(directory: string): Generator<string> {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      yield* markdownFiles(path);
    } else if (extname(path) === ".md") {
      yield path;
    }
  }
}

const examples: Array<{
  readonly source: string;
  readonly line: number;
  readonly code: string;
  readonly extension: ".ts" | ".tsx";
}> = [];
const extractionFailures: string[] = [];
for (const file of markdownFiles(skillRoot)) {
  const lines = readFileSync(file, "utf8").split("\n");
  for (let index = 0; index < lines.length; index++) {
    const opening = (lines[index] ?? "").match(fence);
    if (!opening) {
      continue;
    }
    const marker = opening[1];
    if (!marker) {
      continue;
    }
    const closing = new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`);
    const start = index + 2;
    const body: string[] = [];
    for (
      index++;
      index < lines.length && !closing.test(lines[index] ?? "");
      index++
    ) {
      body.push(lines[index] ?? "");
    }
    if (index >= lines.length) {
      extractionFailures.push(
        `${relative(skillRoot, file)}:${start - 1} unclosed TypeScript fence`
      );
      continue;
    }
    const code = body.join("\n");
    if (containsSuppressionComment(code)) {
      extractionFailures.push(
        `${relative(skillRoot, file)}:${start} suppression directive in TypeScript example`
      );
    }
    examples.push({
      source: relative(skillRoot, file),
      line: start,
      code,
      extension: opening[2]?.toLowerCase() === "tsx" ? ".tsx" : ".ts",
    });
  }
}

if (extractionFailures.length > 0) {
  console.error(
    `typecheck-examples: ${extractionFailures.length} invalid example(s)\n${extractionFailures.join("\n")}`
  );
  process.exit(1);
}

if (examples.length === 0) {
  throw new Error("typecheck-examples: no TypeScript examples found");
}

const lockfile = Bun.JSONC.parse(await Bun.file(join(repoRoot, "bun.lock")).text());
const expectedEffectVersion = lockfile.packages.effect[0].replace(/^effect@/, "");
const installedEffectPackage = await Bun.file(
  join(effectModules, "effect/package.json")
).json();
if (installedEffectPackage.version !== expectedEffectVersion) {
  throw new Error(
    `typecheck-examples: expected effect@${expectedEffectVersion}, found effect@${installedEffectPackage.version}`
  );
}

const directory = mkdtempSync(join(tmpdir(), "effect-skill-examples-"));
let exitCode = 0;
try {
  writeFileSync(join(directory, "package.json"), '{"type":"module"}\n');
  examples.forEach((example, index) => {
    writeFileSync(
      join(directory, `example-${index}${example.extension}`),
      `// ${example.source}:${example.line}\nexport {}\n${example.code}\n`
    );
  });
  const writeTsconfig = (path: string, files: string[]) =>
    writeFileSync(
      path,
      JSON.stringify(
        {
          extends: join(repoRoot, "tsconfig.base.json"),
          compilerOptions: {
            composite: false,
            incremental: false,
            noEmit: true,
            rootDir: directory,
            noUnusedLocals: false,
            noUnusedParameters: false,
            jsx: "preserve",
            types: [],
          },
          files,
        },
        null,
        2
      )
    );
  const sentinelConfig = join(directory, "tsconfig-sentinel.json");
  writeTsconfig(sentinelConfig, ["diagnostics-sentinel.ts"]);
  symlinkSync(effectModules, join(directory, "node_modules"), "dir");

  writeFileSync(
    join(directory, "diagnostics-sentinel.ts"),
    'import { Effect } from "effect"\nEffect.succeed(1)\n'
  );
  const sentinel = await $`${join(repoRoot, "node_modules/.bin/tsc")} --project ${sentinelConfig}`
    .cwd(repoRoot)
    .nothrow()
    .quiet();
  if (
    sentinel.exitCode === 0 ||
    !`${sentinel.stdout}${sentinel.stderr}`.includes("floatingEffect")
  ) {
    throw new Error(
      `typecheck-examples: Effect diagnostics are not active\n${sentinel.stdout}${sentinel.stderr}`
    );
  }
  rmSync(join(directory, "diagnostics-sentinel.ts"));
  rmSync(sentinelConfig);

  const results = await Promise.all(
    examples.map(async (example, index) => {
      const source = `example-${index}${example.extension}`;
      const config = join(directory, `tsconfig-${index}.json`);
      writeTsconfig(config, [source]);
      return await $`${join(repoRoot, "node_modules/.bin/tsc")} --project ${config}`
        .cwd(repoRoot)
        .nothrow();
    })
  );
  for (const result of results) {
    if (result.exitCode !== 0) {
      exitCode = result.exitCode;
    }
  }
  if (exitCode === 0) {
    console.log(
      `typecheck-examples: ${examples.length} isolated TypeScript example(s) compile`
    );
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
process.exitCode = exitCode;
