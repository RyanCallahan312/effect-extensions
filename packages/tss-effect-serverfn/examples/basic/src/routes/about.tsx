import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/about")({
  component: () => (
    <>
      <h1>About this example</h1>
      <p>
        Raw Effect Schemas, Effect handlers, and Start's native function
        utilities.
      </p>
    </>
  ),
});
