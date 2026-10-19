import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { describe, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { expect } from "vitest";

import * as AwsImds from "../src/index.ts";

interface SeenRequest {
  readonly method: string;
  readonly url: string;
  readonly ttl: string | undefined;
  readonly token: string | undefined;
}

const header = (request: IncomingMessage, name: string) => {
  const value = request.headers[name];

  return Array.isArray(value) ? value.join(",") : value;
};

const decodeAddress = Schema.decodeUnknownSync(
  Schema.Struct({ port: Schema.Int })
);

// A loopback IMDS that issues "loopback-token" and serves `/ok` and `/hang`.
const loopbackImds = Effect.acquireRelease(
  Effect.callback<{
    readonly endpoint: string;
    readonly seen: SeenRequest[];
    readonly close: Effect.Effect<undefined>;
  }>((resume) => {
    const seen: SeenRequest[] = [];

    const server = createServer(
      (request: IncomingMessage, response: ServerResponse) => {
        seen.push({
          method: request.method ?? "",
          token: header(request, "x-aws-ec2-metadata-token"),
          ttl: header(request, "x-aws-ec2-metadata-token-ttl-seconds"),
          url: request.url ?? "",
        });

        if (request.method === "PUT") {
          response.end("loopback-token");

          return;
        }

        if (request.url === "/ok") {
          response.end("served over fetch");

          return;
        }

        if (request.url === "/drop") {
          request.socket.destroy();
        }
      }
    );

    server.listen(0, "127.0.0.1", () => {
      const { port } = decodeAddress(server.address());

      resume(
        Effect.succeed({
          close: Effect.callback<undefined>((closed) => {
            server.closeAllConnections();
            server.close(() => closed(Effect.undefined));
          }),
          endpoint: `http://127.0.0.1:${port}`,
          seen,
        })
      );
    });

    // Interrupted before listening: release the socket instead of leaking it.
    return Effect.sync(() => server.close());
  }),
  (imds) => imds.close
);

const fetchLayer = (options: AwsImds.AwsImdsOptions) =>
  AwsImds.layerFetch.pipe(Layer.provide(AwsImds.AwsImdsConfig.layer(options)));

describe("AwsImds over FetchHttpClient", () => {
  it.live("performs the IMDSv2 handshake against a real HTTP server", () =>
    Effect.gen(function* handshake() {
      const imds = yield* loopbackImds;

      const body = yield* AwsImds.get("/ok").pipe(
        Effect.provide(
          fetchLayer({ endpoint: imds.endpoint, tokenTtl: "5 minutes" })
        )
      );

      expect(body).toBe("served over fetch");
      expect(imds.seen).toEqual([
        {
          method: "PUT",
          token: undefined,
          ttl: "300",
          url: "/latest/api/token",
        },
        { method: "GET", token: "loopback-token", ttl: undefined, url: "/ok" },
      ]);
    }).pipe(Effect.scoped)
  );

  it.live("fails with a sanitized typed error when a request times out", () =>
    Effect.gen(function* timeout() {
      const imds = yield* loopbackImds;

      const error = yield* AwsImds.get("/hang").pipe(
        Effect.flip,
        Effect.provide(
          fetchLayer({
            attemptTimeout: "50 millis",
            endpoint: imds.endpoint,
            retrySchedule: AwsImds.retryPolicy(0),
          })
        )
      );

      expect(error).toBeInstanceOf(AwsImds.AwsImdsMetadataError);
      expect(error).toMatchObject({ path: "/hang" });
      expect(error).not.toHaveProperty("status");
    }).pipe(Effect.scoped)
  );

  it.live("keeps the session token out of transport errors", () =>
    Effect.gen(function* transport() {
      const imds = yield* loopbackImds;

      const error = yield* AwsImds.get("/drop").pipe(
        Effect.flip,
        Effect.provide(
          fetchLayer({
            endpoint: imds.endpoint,
            retrySchedule: AwsImds.retryPolicy(0),
          })
        )
      );

      expect(error).toBeInstanceOf(AwsImds.AwsImdsMetadataError);
      expect(`${JSON.stringify(error)} ${String(error)}`).not.toContain(
        "loopback-token"
      );
    }).pipe(Effect.scoped)
  );
});
