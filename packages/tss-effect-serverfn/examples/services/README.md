# Services

A tiny in-memory notes app backed by one application-owned `ManagedRuntime` and a native Effect service Layer.

From the repository root:

```sh
bun install
bun run build
bun run --cwd packages/tss-effect-serverfn/examples/services dev
```

Open http://localhost:3001. Save a new title for note `1`; the route loader refreshes, and reloading the page reads the same service state.

The handlers use `flow` and `Effect.fn`. The save pipeline uses `tap` to await the mutation while retaining the service, `flatMap` to read the updated note, and `map` to construct the response. Enable **Recover missing notes with catchTag** to turn a missing ID into a successful `Skipped missing note` result. Invalid input and defects still reject. See the [composition guide](../../docs/composition.md#pipe-service-work-and-recover-a-business-error).

Try these failure cases:

Use the **Try a scenario** buttons to run each case in one click, plus a successful save and a recovered missing note. Each preset fills the form and sets the recovery checkbox explicitly. **Latest request** shows the pending/success/failure state, submitted input, endpoint, and actual client-visible JSON, including public error codes or tags. The saved service state is displayed separately, so a failed or skipped request is not confused with a mutation.

| Input | Result |
| --- | --- |
| Empty title | Schema rejection: `Invalid input`, HTTP 400 |
| ID `missing` | Approved `NoteMissing` error: `Note does not exist` |
| Title `crash` | Deliberate defect: only `Something went wrong` reaches the client |

The data is shared by requests to this process and resets on server restart or runtime replacement during HMR. No database or credentials are needed.

Start reading at:

1. [`src/notes.server.ts`](src/notes.server.ts) — `Context.Service`, `Layer`, and `Ref` state.
2. [`src/runtime.server.ts`](src/runtime.server.ts) — shared runtime and HMR disposal.
3. [`src/effect-server-fn.ts`](src/effect-server-fn.ts) — runtime runner and public-error schema.
4. [`src/notes.functions.ts`](src/notes.functions.ts) — serviceful GET and POST handlers.
5. [`src/routes/index.tsx`](src/routes/index.tsx) — mutation and loader invalidation.

An application using resourceful Layers should also await `runtime.dispose()` in its deployment host's shutdown hook after draining requests.

`bun run --cwd packages/tss-effect-serverfn/examples/services preview` serves the production build on the same port.
