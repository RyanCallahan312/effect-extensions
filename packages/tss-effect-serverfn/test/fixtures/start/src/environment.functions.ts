import { createServerFn } from "@tanstack/react-start";
import { Effect } from "effect";

import { createEffectServerFn } from "./effect-server-fn.ts";
import { isomorphicEffect, serverEffect } from "./environment.ts";

export const nativeFunction = createServerFn().handler(() => "native-result");

export const effectFunction = createEffectServerFn().handler(() =>
  Effect.gen(function* environment() {
    const messages: string[] = [];
    yield* serverEffect((message) => messages.push(message));
    yield* isomorphicEffect((message) => messages.push(message));

    return messages;
  })
);
