# Package development

Run the following commands from the repository root unless noted otherwise.

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
(cd packages/tss-effect-serverfn && bunx --no-install playwright install chromium)
bun run test:e2e
```

The suite runs both examples against Vite dev and production preview, using real browser interactions and RPC responses. See [E2E coverage and debugging](../e2e/README.md). Failures retain Playwright traces and screenshots in the package directory.

## TypeScript configuration

`tsconfig.base.json` holds shared strict compiler settings and Effect diagnostics. Each package extends it with its own source include. The root `tsconfig.json` is a solution config: add a project reference there when adding a package, and add package-level references for workspace dependencies.

`bunx tsc -b` builds the package solution. Examples use Vite-oriented TypeScript configs and `noEmit`. `bun run typecheck` builds first so generated route types and package exports exist, then checks the package, both apps, and E2E code. Package builds emit JavaScript, declarations, and maps into `dist/`; the published package includes `src/` so map navigation works.

## Releases

The package is published as `@rc312/tss-effect-serverfn` under the MIT license. Nothing is published automatically on push.

1. Run `bun run changeset` and commit the generated changeset with your changes.
2. Run `bun run version-packages`, then `bun install` to refresh the lockfile. Commit the version changes, changelog, and lockfile to `main`.
3. Inspect the artifact locally:

   ```sh
   bun run check
   cd packages/tss-effect-serverfn
   npm pack --dry-run
   ```

4. To publish locally, authenticate with `npm login`, return to the root, and run `bun run release`. Changesets publishes only unreleased package versions. Push any generated version tags if you want them recorded on GitHub.
