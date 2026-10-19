import { ManagedRuntime } from "effect";

import { Notes } from "./notes.server.ts";

export const runtime = ManagedRuntime.make(Notes.layer);

if (import.meta.hot) {
  import.meta.hot.dispose(() => runtime.dispose());
}
