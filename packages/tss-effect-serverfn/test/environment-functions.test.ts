import { cp, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createClientOnlyFn,
  createIsomorphicFn,
  createServerOnlyFn,
} from "@tanstack/react-start";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { Context, Effect } from "effect";
import { effectServerFns } from "tss-effect-serverfn/vite";
import { createBuilder } from "vite";
import { expectTypeOf, it } from "vitest";

import { verifyEnvironmentFunctions } from "./environment-fixture.ts";

class ServerValue extends Context.Service<
  ServerValue,
  { readonly value: number }
>()("test/ServerValue") {}

it("preserves Effect success, error, and service types through native helpers", () => {
  const server = createServerOnlyFn((id: number) =>
    Effect.gen(function* serverValue() {
      const service = yield* ServerValue;

      if (id < 0) {
        return yield* Effect.fail("unavailable" as const);
      }

      return service.value + id;
    })
  );

  const client = createClientOnlyFn((id: number) =>
    Effect.succeed(`client:${id}`)
  );

  const isomorphic = createIsomorphicFn().server(server).client(client);
  const clientFirst = createIsomorphicFn().client(client).server(server);
  const serverOptional = createIsomorphicFn().server(server);
  const clientOptional = createIsomorphicFn().client(client);

  expectTypeOf<Parameters<typeof server>>().toEqualTypeOf<[id: number]>();
  expectTypeOf<Parameters<typeof client>>().toEqualTypeOf<[id: number]>();
  expectTypeOf<ReturnType<typeof server>>().toEqualTypeOf<
    Effect.Effect<number, "unavailable", ServerValue>
  >();
  expectTypeOf<ReturnType<typeof client>>().toEqualTypeOf<
    Effect.Effect<string>
  >();
  expectTypeOf<ReturnType<typeof isomorphic>>().toEqualTypeOf<
    ReturnType<typeof server> | ReturnType<typeof client>
  >();
  expectTypeOf<ReturnType<typeof clientFirst>>().toEqualTypeOf<
    ReturnType<typeof isomorphic>
  >();
  expectTypeOf<ReturnType<typeof serverOptional>>().toEqualTypeOf<
    ReturnType<typeof server> | undefined
  >();
  expectTypeOf<ReturnType<typeof clientOptional>>().toEqualTypeOf<
    ReturnType<typeof client> | undefined
  >();

  const invalid = () =>
    createIsomorphicFn()
      .server(server)
      // @ts-expect-error Both implementations must accept the same arguments.
      .client((id: string) => Effect.succeed(id));

  expectTypeOf(invalid).toBeFunction();
});

it("compiles Effect utilities for both environments with Start's real plugin", async () => {
  const packageRoot = fileURLToPath(new URL("..", import.meta.url));
  const root = await mkdtemp(path.join(packageRoot, ".cache/environment-"));

  try {
    await cp(path.join(packageRoot, "test/fixtures/start"), root, {
      recursive: true,
    });
    const entry = "./environment.ts";

    const builder = await createBuilder({
      configFile: false,
      environments: {
        client: {
          build: {
            rolldownOptions: {
              output: { entryFileNames: "assets/environment.js" },
              preserveEntrySignatures: "strict",
            },
          },
        },
        ssr: {
          build: {
            rolldownOptions: { output: { entryFileNames: "environment.js" } },
          },
        },
      },
      logLevel: "silent",
      plugins: [
        effectServerFns(),
        tanstackStart({ client: { entry }, server: { entry } }),
      ],
      root,
    });

    await builder.buildApp();
    await verifyEnvironmentFunctions(root, "server");
    await verifyEnvironmentFunctions(root, "client");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 60_000);
