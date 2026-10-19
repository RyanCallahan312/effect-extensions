# Effect Extensions

A Bun/Turborepo workspace for Effect packages and related projects.

## Packages

| Package | Documentation |
| --- | --- |
| [`@rc312/effect-aws-imds`](packages/effect-aws-imds) | [Usage and API](packages/effect-aws-imds/README.md) |
| [`@rc312/tss-effect-serverfn`](packages/tss-effect-serverfn) | [Quick start](packages/tss-effect-serverfn/README.md), [usage](packages/tss-effect-serverfn/docs/usage.md), [examples](packages/tss-effect-serverfn/examples/README.md), and [development](packages/tss-effect-serverfn/docs/development.md) |

Package-specific documentation, examples, and browser tests live inside their package directory.

## Workspace development

Use Bun 1.3.13 and Node.js 22.12 or newer.

```sh
bun install
bun run check       # lint, typecheck, and test the workspaces
bun run build       # build the workspaces
bun run dev         # start workspace development processes
bun run format      # apply formatting and safe lint fixes
```

Add packages under `packages/`. Example apps under `packages/*/examples/*` are private Bun workspaces. Shared tooling and TypeScript configuration remain at the root. Add a project reference to the root `tsconfig.json` for each package that uses the shared TypeScript build.

See each package's documentation for its development, browser testing, and release instructions.
