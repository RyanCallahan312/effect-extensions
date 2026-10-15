# tss-effect-serverfn

Effect Schemas and Effect-returning handlers for TanStack Start, with a Vite plugin that preserves the concise `.validator(schema).handler(() => effect)` syntax.

**[Quick start →](packages/tss-effect-serverfn/README.md#quick-start)** · [Usage reference](packages/tss-effect-serverfn/docs/usage.md) · [Runnable examples](examples/README.md)

[Composition examples](packages/tss-effect-serverfn/docs/composition.md) cover `pipe`, `flow`, `Effect.fn`, do notation, service pipelines, and typed error recovery.

This repository is the Bun/Turborepo workspace for developing the package.

## Layout

```text
packages/
  tss-effect-serverfn/  # publishable ESM package and generated declarations
examples/
  basic/               # raw Schema + Effect endpoint and native utilities
  services/            # ManagedRuntime, service state, and safe errors
e2e/                   # browser tests against both example applications
.changeset/            # versioning and changelogs
.github/workflows/     # package and browser checks
```

The root is private; only packages are published. `packages/tss-effect-serverfn` integrates native Effect Schemas and Effect-returning handlers with TanStack Start; see its README for setup, execution, and failure-handling policy.

## Development

Use Bun 1.3.13 and Node.js 22.12 or newer.

```sh
bun install
bun run check       # lint, builds, typechecks, and package tests
bun run build       # package and example builds through Turbo
bun run dev         # package watcher and both example dev servers
bun run format     # apply formatting and safe lint fixes
```

The package builds with standard `tsc -b`. Effect and TanStack are peers so applications share the same runtime and framework instances.

## Browser tests

```sh
bunx --no-install playwright install chromium
bun run test:e2e
```

The suite runs both examples against Vite dev and production preview, using real browser interactions and RPC responses. See [E2E coverage and debugging](e2e/README.md). CI runs package tests and browser tests; failures include downloadable Playwright traces and screenshots.

## TypeScript configuration

`tsconfig.base.json` holds shared strict compiler settings and Effect diagnostics. Each package extends it with its own source include. The root `tsconfig.json` is a solution config: add a project reference there when adding a package, and add package-level references for workspace dependencies.

`bunx tsc -b` builds the package solution. Examples use Vite-oriented TypeScript configs and `noEmit`. `bun run typecheck` builds first so generated route types and package exports exist, then checks the package, both apps, and E2E code. Package builds emit JavaScript, declarations, and maps into `dist/`; the published package includes `src/` so map navigation works.

## Releases

Before the first release, confirm the npm name is available, choose a license (currently `UNLICENSED`), and set the initial release version. Nothing is published automatically on push.

1. Run `bun run changeset` and commit the generated changeset with your changes.
2. Run `bun run version-packages`, then `bun install` to refresh the lockfile. Commit the version changes, changelog, and lockfile to `main`.
3. Inspect the artifact locally:

   ```sh
   bun run check
   cd packages/tss-effect-serverfn
   npm pack --dry-run
   ```

4. To publish locally, authenticate with `npm login`, return to the root, and run `bun run release`. Changesets publishes only unreleased package versions. Push any generated version tags if you want them recorded on GitHub.
