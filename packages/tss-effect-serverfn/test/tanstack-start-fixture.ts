import { createMiddleware, executeMiddleware } from "@tanstack/react-start";
import { createServerEntry } from "@tanstack/react-start/server";
import { runWithStartContext } from "@tanstack/start-storage-context";

const metadata = { filename: "fixture.ts", id: "fixture", name: "read" };

export const execute = async <
  D = undefined,
  C extends object = Record<never, never>,
>(
  middlewares: Parameters<typeof executeMiddleware>[0],
  request: Request = new Request("http://localhost"),
  data?: D,
  context?: C
): Promise<Awaited<ReturnType<typeof executeMiddleware>>> => {
  const result =
    Promise.withResolvers<Awaited<ReturnType<typeof executeMiddleware>>>();

  await createServerEntry({
    fetch: async (nativeRequest) => {
      result.resolve(
        await runWithStartContext(
          {
            contextAfterGlobalMiddlewares: {},
            executedRequestMiddlewares: new Set(),
            getRouter: () => {
              throw new Error("This fixture must not access a router");
            },
            handlerType: "serverFn",
            request: nativeRequest,
            startOptions: {},
          },
          () =>
            executeMiddleware(middlewares, "server", {
              context: context ?? {},
              data,
              method: "GET",
              serverFnMeta: metadata,
              // Deliberately unrelated: cancellation must come from the actual Request.
              signal: new AbortController().signal,
            })
        )
      );

      return new Response("Done");
    },
  }).fetch(request);

  return result.promise;
};

export const leaf = <A>(program: A) =>
  createMiddleware({ type: "function" }).server(async ({ next }) => ({
    ...(await next()),
    result: program,
  }));
