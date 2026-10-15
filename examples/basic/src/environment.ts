import {
  createClientOnlyFn,
  createIsomorphicFn,
  createServerOnlyFn,
} from "@tanstack/react-start";
import { Effect } from "effect";

export const greeting = createServerOnlyFn((name: string) =>
  Effect.succeed(`Hello, ${name}!`)
);

export const environment = createIsomorphicFn()
  .server(() => Effect.succeed("server"))
  .client(() => Effect.succeed("browser"));

export const browserPath = createClientOnlyFn(() =>
  Effect.sync(() => window.location.pathname)
);
