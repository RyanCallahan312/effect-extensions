import { Data, Effect, Layer, Tracer } from "effect";
import type { HttpClientRequest } from "effect/http";
import {
  Headers,
  HttpClient,
  HttpClientError,
  HttpClientResponse,
} from "effect/http";

import * as AwsImds from "../src/index.ts";

interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly redactsToken: boolean;
}

/** Fails a scripted request the way a reset connection does. */
class Dropped extends Data.TaggedError("Dropped") {}

type Route = (
  request: RecordedRequest,
  attempt: number
) => Effect.Effect<Response, Dropped>;

const document = {
  accountId: "123456789012",
  addedByAwsLater: "ignored",
  architecture: "x86_64",
  availabilityZone: "us-east-1a",
  billingProducts: null,
  devpayProductCodes: null,
  imageId: "ami-0abcdef1234567890",
  instanceId: "i-1234567890abcdef0",
  instanceType: "t3.micro",
  kernelId: null,
  marketplaceProductCodes: null,
  pendingTime: "2024-01-02T03:04:05Z",
  privateIp: "10.0.0.12",
  ramdiskId: null,
  region: "us-east-1",
  version: "2017-09-30",
};

const text = (
  body: string,
  status = 200,
  headers: Record<string, string> = {}
): Effect.Effect<Response> =>
  Effect.succeed(new Response(body, { headers, status }));

const dropConnection = Effect.fail(new Dropped());

const tokenRoute: Route = () => text("token-1");

// Builds an in-memory IMDS whose PUT and GET routes are scripted per test.
// `attempt` counts requests per HTTP method, starting at 1.
const fakeImds = (routes: { readonly put?: Route; readonly get: Route }) => {
  const requests: RecordedRequest[] = [];
  const attempts = new Map<string, number>();

  const client = HttpClient.make(
    (request: HttpClientRequest.HttpClientRequest, url, _signal, fiber) => {
      const recorded = {
        headers: { ...request.headers },
        method: request.method,
        redactsToken: fiber
          .getRef(Headers.CurrentRedactedNames)
          .includes("x-aws-ec2-metadata-token"),
        url: url.toString(),
      };

      requests.push(recorded);

      const attempt = (attempts.get(request.method) ?? 0) + 1;
      attempts.set(request.method, attempt);

      const route =
        request.method === "PUT" ? (routes.put ?? tokenRoute) : routes.get;

      return route(recorded, attempt).pipe(
        Effect.map((response) => HttpClientResponse.fromWeb(request, response)),
        Effect.mapError(
          () =>
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({
                description: "connection reset",
                request,
              }),
            })
        )
      );
    }
  );

  const clientLayer = Layer.succeed(HttpClient.HttpClient, client);

  return {
    clientLayer,
    layer: (options: AwsImds.AwsImdsOptions = {}) =>
      AwsImds.layer.pipe(
        Layer.provide(clientLayer),
        Layer.provide(AwsImds.AwsImdsConfig.layer(options))
      ),
    requests,
  };
};

const methods = (requests: readonly RecordedRequest[]) =>
  requests.map((request) => request.method);

const count = (requests: readonly RecordedRequest[], method: string) =>
  methods(requests).filter((candidate) => candidate === method).length;

/** A tracer that keeps every span it creates, for asserting names and attributes. */
const recordingTracer = () => {
  const spans: Tracer.NativeSpan[] = [];

  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);

      return span;
    },
  });

  return { layer: Layer.succeed(Tracer.Tracer, tracer), spans };
};

export {
  count,
  document,
  dropConnection,
  fakeImds,
  methods,
  recordingTracer,
  text,
};

export type { RecordedRequest, Route };
