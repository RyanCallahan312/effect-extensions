import { createFileRoute } from "@tanstack/react-router";
import React from "react";

import { effectFunction, nativeFunction } from "../environment.functions";
import { getGreeting } from "../greeting.functions";
import { renameNote } from "../notes.functions";

export const Route = createFileRoute("/")({
  component: () => (
    <>
      <a id="endpoint" href={renameNote.url}>
        Rename
      </a>
      <a id="quick-start" href={getGreeting.url}>
        Greeting
      </a>
      <a id="native-function" href={nativeFunction.url}>
        Native
      </a>
      <a id="effect-function" href={effectFunction.url}>
        Effect composition
      </a>
    </>
  ),
});
