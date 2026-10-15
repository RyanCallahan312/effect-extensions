import {
  createClientOnlyFn as clientOnly,
  createIsomorphicFn,
  createServerOnlyFn,
} from "@tanstack/react-start";
import { Effect } from "effect";

import { clientMessage } from "./environment.client.ts";
import { serverMessage } from "./environment.server.ts";

export const serverEffect = createServerOnlyFn(
  (record: (message: string) => void) =>
    Effect.sync(() => {
      record(serverMessage);

      return serverMessage;
    })
);

export const clientEffect = clientOnly((record: (message: string) => void) =>
  Effect.sync(() => {
    record(clientMessage);

    return clientMessage;
  })
);

export const isomorphicEffect = createIsomorphicFn()
  .server(serverEffect)
  .client(clientEffect);

export const clientFirstEffect = createIsomorphicFn()
  .client(clientEffect)
  .server(serverEffect);

export const serverOptional = createIsomorphicFn().server(serverEffect);
export const clientOptional = createIsomorphicFn().client(clientEffect);
