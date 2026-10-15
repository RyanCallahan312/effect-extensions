import { createServerFn } from "@tanstack/react-start";
import { createClientRpc } from "@tanstack/react-start/client-rpc";
import { runWithStartContext } from "@tanstack/start-storage-context";

export type TransportFetch = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

interface TransportRecord {
  [key: string]: TransportValue;
}

type TransportValue =
  | boolean
  | null
  | number
  | string
  | TransportRecord
  | TransportValue[]
  | undefined;

type TransportResult = Response | TransportValue;

const startContext = () => ({
  contextAfterGlobalMiddlewares: {},
  executedRequestMiddlewares: new Set(),
  getRouter: () => {
    throw new Error("This fixture must not access a router");
  },
  handlerType: "serverFn" as const,
  request: new Request("http://localhost/_server/fixture"),
  startOptions: {},
});

const withServerFunctionBase = <A>(run: () => A): A => {
  const previous = process.env.TSS_SERVER_FN_BASE;
  process.env.TSS_SERVER_FN_BASE = "/_server/";

  try {
    return run();
  } finally {
    if (previous === undefined) {
      delete process.env.TSS_SERVER_FN_BASE;
    } else {
      process.env.TSS_SERVER_FN_BASE = previous;
    }
  }
};

const clientRpc = (id: string) =>
  withServerFunctionBase(() => createClientRpc(id));

/**
 * Invokes the real Start client RPC helper while supplying only the network
 * boundary. Responses come from Start's generated HTTP handler.
 */
export const invokeClientRpc = (
  id: string,
  data: TransportValue,
  fetch: TransportFetch,
  method: "GET" | "POST" = "POST"
): Promise<TransportResult> =>
  runWithStartContext(startContext(), () =>
    clientRpc(id)({ data, fetch, method })
  );

type CompiledClientHandler = (
  extractedFn: ReturnType<typeof createClientRpc>,
  serverFn: (context: { data: TransportValue }) => TransportValue
) => (options?: {
  data?: TransportValue;
  fetch?: TransportFetch;
}) => Promise<TransportResult>;

/**
 * Builds the runtime shape produced by TanStack Start's compiler. This keeps
 * rejection assertions at the public createServerFn boundary rather than only
 * inspecting the lower-level RPC envelope.
 */
export const invokeTransformedClientServerFn = (
  id: string,
  data: TransportValue,
  fetch: TransportFetch
): Promise<TransportResult> => {
  const builder = createServerFn({ method: "POST" });

  // SAFETY: The compiler supplies the extracted RPC as the first handler
  // argument; the public declaration only exposes the source-level overload.
  const compiledHandler = builder.handler as typeof builder.handler &
    CompiledClientHandler;

  const serverFn = compiledHandler(clientRpc(id), ({ data: input }) => input);

  return runWithStartContext(startContext(), () => serverFn({ data, fetch }));
};
