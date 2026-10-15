#!/usr/bin/env bun

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

const defaultSkillRoot = resolve(import.meta.dir, "..");
const skillRoot = resolve(Bun.env.EFFECT_SKILL_ROOT ?? defaultSkillRoot);
const repoRoot = resolve(defaultSkillRoot, "../../..");
const allowedRoot = Bun.env.EFFECT_SKILL_ROOT ? skillRoot : repoRoot;
const linkPattern = /(?<!!)\[[^\]]+\]\(([^)]+)\)/g;
const headingPattern = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/;
const fencePattern = /^\s{0,3}(`{3,}|~{3,})/;

const slug = (heading: string) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[`*_~]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-");

const markdownAnchors = (file: string) => {
  const anchors = new Set<string>();
  const duplicates = new Map<string, number>();
  let fenceMarker: string | undefined;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const fence = line.match(fencePattern)?.[1];
    if (fence) {
      if (!fenceMarker) {
        fenceMarker = fence;
      } else if (
        fence[0] === fenceMarker[0] &&
        fence.length >= fenceMarker.length
      ) {
        fenceMarker = undefined;
      }
      continue;
    }
    if (fenceMarker) {
      continue;
    }
    const heading = line.match(headingPattern)?.[1];
    if (!heading) {
      continue;
    }
    const base = slug(heading);
    const count = duplicates.get(base) ?? 0;
    duplicates.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  return anchors;
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

const failures: string[] = [];
for (const file of markdownFiles(skillRoot)) {
  const lines = readFileSync(file, "utf8").split("\n");
  let fenceMarker: string | undefined;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const fence = line.match(fencePattern)?.[1];
    if (fence) {
      if (!fenceMarker) {
        fenceMarker = fence;
      } else if (
        fence[0] === fenceMarker[0] &&
        fence.length >= fenceMarker.length
      ) {
        fenceMarker = undefined;
      }
      continue;
    }
    if (fenceMarker) {
      continue;
    }
    for (const match of line.matchAll(linkPattern)) {
      const rawTarget = match[1] ?? "";
      if (!rawTarget || /^[a-z]+:/i.test(rawTarget)) {
        continue;
      }
      const [targetPath = "", encodedFragment] = rawTarget.split("#", 2);
      const resolved = resolve(dirname(file), targetPath || file);
      const fromAllowedRoot = relative(allowedRoot, resolved);
      if (
        isAbsolute(fromAllowedRoot) ||
        fromAllowedRoot === ".." ||
        fromAllowedRoot.startsWith(`..${sep}`)
      ) {
        failures.push(
          `${relative(skillRoot, file)}:${index + 1} -> ${rawTarget}`
        );
        continue;
      }
      if (!existsSync(resolved)) {
        failures.push(
          `${relative(skillRoot, file)}:${index + 1} -> ${rawTarget}`
        );
        continue;
      }
      if (encodedFragment && extname(resolved) === ".md") {
        const fragment = decodeURIComponent(encodedFragment).toLowerCase();
        if (!markdownAnchors(resolved).has(fragment)) {
          failures.push(
            `${relative(skillRoot, file)}:${index + 1} -> ${rawTarget}`
          );
        }
      }
    }
  }
}

if (failures.length > 0) {
  console.error(
    `check-links: ${failures.length} broken link(s)\n${failures.join("\n")}`
  );
  process.exit(1);
}

console.log("check-links: all relative markdown links resolve");
