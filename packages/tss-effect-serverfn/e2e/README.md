# Browser end-to-end tests

From the repository root:

```sh
bun install
(cd packages/tss-effect-serverfn && bunx --no-install playwright install chromium)
bun run test:e2e
```

`test:e2e` builds the package and both examples, then Playwright starts and stops four isolated servers. Existing servers on ports 4310–4313 cause a startup failure rather than silently testing a different checkout.

| Project            | Example  | Server                        |
| ------------------ | -------- | ----------------------------- |
| `basic-dev`        | Basic    | Vite dev, port 4310           |
| `basic-preview`    | Basic    | Production preview, port 4311 |
| `services-dev`     | Services | Vite dev, port 4312           |
| `services-preview` | Services | Production preview, port 4313 |

## Coverage

- Initial SSR with JavaScript disabled.
- Hydration and real GET/POST RPCs through browser interactions.
- Encoded string input decoded to a number before business execution.
- Equivalent results through `pipe`, `flow`/`all`, `Effect.fn`, and `Do`/`bind`/`let`, including piped Schema checks and recovery after rejected input.
- Invalid-input HTTP status, safe error records, and recovery with a later valid call.
- Client navigation and a server redirect through `useServerFn`.
- Native client-only and isomorphic helpers returning Effects.
- ManagedRuntime service state, mutations, loader invalidation, and subsequent SSR/reloads.
- Approved business errors and sanitized defects without unintended mutations.
- Piped `tap`/`flatMap` mutations, `catchTag` recovery, and Schema/defect failures that remain rejected with recovery enabled.
- Private service code absent from JavaScript delivered to the browser.
- Automatic failure on unhandled browser exceptions and hydration errors.

There are no mocked RPC responses, fixed sleeps, or automatic retries. Each test gets a fresh browser context. Service tests make assertions against the current note state so they can run independently; each project owns a separate server process.

These browser checks complement the package tests for Scope/finalization, cancellation, reporting, type inference, compiler lowering, and native HTTP transport.

## Debugging

```sh
bun run test:e2e --project=basic-dev
bun run test:e2e --project=services-preview --headed
cd packages/tss-effect-serverfn
bunx --no-install playwright show-report
```

Failures retain screenshots and traces under `packages/tss-effect-serverfn/test-results/`; the HTML report is in `packages/tss-effect-serverfn/playwright-report/`. Playwright prints the command to open each failed test's trace. Generated files are ignored by Git.
