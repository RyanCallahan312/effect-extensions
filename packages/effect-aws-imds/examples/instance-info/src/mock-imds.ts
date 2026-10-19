/**
 * A strict, in-process stand-in for the EC2 Instance Metadata Service.
 *
 * It enforces the IMDSv2 rules that matter to a client: tokens come only from
 * `PUT /latest/api/token` with a valid TTL header, `X-Forwarded-For` on that
 * request is refused, and every other read needs a live token. Scenarios add
 * the failure modes a real instance can produce.
 */
import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { Option, Schema } from "effect";

/**
 * - `healthy`: every request succeeds.
 * - `flaky`: the first token request returns 503 and the first read returns 429.
 * - `expire-tokens`: each token is accepted for three reads, then rejected.
 * - `hang`: requests are accepted but never answered.
 * - `malformed`: the identity document has an invalid `accountId`.
 */
// oxlint-disable-next-line no-redeclare -- The decoded type below intentionally shares the schema's name.
const Scenario = Schema.Literals([
  "healthy",
  "flaky",
  "expire-tokens",
  "hang",
  "malformed",
]);

type Scenario = typeof Scenario.Type;

interface MockImdsRequest {
  readonly method: string;
  readonly path: string;
  readonly status: number | "no-response";
  readonly token: string | undefined;
  readonly ttl: string | undefined;
}

interface MockImds {
  readonly url: string;
  readonly port: number;
  readonly requests: readonly MockImdsRequest[];
  readonly close: () => Promise<void>;
}

const TOKEN_PATH = "/latest/api/token";
const IDENTITY_DOCUMENT_PATH = "/latest/dynamic/instance-identity/document";
const MAX_TTL_SECONDS = 21_600;

// Three of the CLI's five concurrent reads succeed; each refreshed token covers a retry.
const READS_PER_TOKEN_WHEN_EXPIRING = 3;

const identityDocument = {
  accountId: "123456789012",
  architecture: "arm64",
  availabilityZone: "eu-west-1b",
  billingProducts: null,
  devpayProductCodes: null,
  imageId: "ami-0123456789abcdef0",
  instanceId: "i-0abc123def4567890",
  instanceType: "m7g.large",
  kernelId: null,
  marketplaceProductCodes: null,
  pendingTime: "2026-10-01T08:30:00Z",
  privateIp: "10.20.30.40",
  ramdiskId: null,
  region: "eu-west-1",
  version: "2017-09-30",
};

const metadata = new Map<string, string>([
  ["/latest/meta-data/ami-id", identityDocument.imageId],
  ["/latest/meta-data/instance-id", identityDocument.instanceId],
  ["/latest/meta-data/instance-type", identityDocument.instanceType],
  ["/latest/meta-data/local-ipv4", identityDocument.privateIp],
  [
    "/latest/meta-data/placement/availability-zone",
    identityDocument.availabilityZone,
  ],
]);

const TtlSeconds = Schema.FiniteFromString.check(
  Schema.isInt(),
  Schema.isBetween({ maximum: MAX_TTL_SECONDS, minimum: 1 })
);

const decodeTtl = Schema.decodeUnknownOption(TtlSeconds);

const decodeAddress = Schema.decodeUnknownSync(
  Schema.Struct({ port: Schema.Int })
);

const header = (request: IncomingMessage, name: string) => {
  const value = request.headers[name];

  return Array.isArray(value) ? value.join(",") : value;
};

const identityDocumentBody = (scenario: Scenario) =>
  JSON.stringify(
    scenario === "malformed"
      ? { ...identityDocument, accountId: "not-an-account" }
      : identityDocument
  );

/** Starts a mock IMDS on `127.0.0.1`. Port `0` picks a free port. */
const startMockImds = async (scenario: Scenario = "healthy", port = 0) => {
  const requests: MockImdsRequest[] = [];
  const tokens = new Map<string, { expiresAt: number; reads: number }>();
  let issued = 0;
  let failedTokenRequest = false;
  let failedRead = false;

  const tokenStatus = (request: IncomingMessage) => {
    if (request.method !== "PUT") {
      return 405;
    }

    if (header(request, "x-forwarded-for") !== undefined) {
      return 403;
    }

    if (scenario === "flaky" && !failedTokenRequest) {
      failedTokenRequest = true;

      return 503;
    }

    return 200;
  };

  const issueToken = (ttlSeconds: number) => {
    issued += 1;
    const token = `mock-token-${issued}`;
    tokens.set(token, { expiresAt: Date.now() + ttlSeconds * 1000, reads: 0 });

    return token;
  };

  const isLive = (token: string | undefined) => {
    const entry = token === undefined ? undefined : tokens.get(token);

    if (entry === undefined || entry.expiresAt <= Date.now()) {
      return false;
    }

    entry.reads += 1;

    return (
      scenario !== "expire-tokens" ||
      entry.reads <= READS_PER_TOKEN_WHEN_EXPIRING
    );
  };

  const respond = (
    request: IncomingMessage,
    response: ServerResponse,
    status: number,
    body = ""
  ) => {
    requests.push({
      method: request.method ?? "",
      path: request.url ?? "",
      status,
      token: header(request, "x-aws-ec2-metadata-token"),
      ttl: header(request, "x-aws-ec2-metadata-token-ttl-seconds"),
    });
    response.writeHead(status, { "content-type": "text/plain" });
    response.end(body);
  };

  const server = createServer((request, response) => {
    const path = request.url ?? "";

    if (scenario === "hang") {
      requests.push({
        method: request.method ?? "",
        path,
        status: "no-response",
        token: header(request, "x-aws-ec2-metadata-token"),
        ttl: header(request, "x-aws-ec2-metadata-token-ttl-seconds"),
      });

      return;
    }

    if (path === TOKEN_PATH) {
      const status = tokenStatus(request);

      const ttl = decodeTtl(
        header(request, "x-aws-ec2-metadata-token-ttl-seconds")
      );

      if (status !== 200) {
        respond(request, response, status);
      } else if (Option.isNone(ttl)) {
        respond(request, response, 400);
      } else {
        respond(request, response, 200, issueToken(ttl.value));
      }

      return;
    }

    if (request.method !== "GET") {
      respond(request, response, 405);

      return;
    }

    if (!isLive(header(request, "x-aws-ec2-metadata-token"))) {
      respond(request, response, 401);

      return;
    }

    if (scenario === "flaky" && !failedRead) {
      failedRead = true;
      respond(request, response, 429);

      return;
    }

    const body =
      path === IDENTITY_DOCUMENT_PATH
        ? identityDocumentBody(scenario)
        : metadata.get(path);

    if (body === undefined) {
      respond(request, response, 404);
    } else {
      respond(request, response, 200, body);
    }
  });

  server.listen(port, "127.0.0.1");
  await once(server, "listening");

  const address = decodeAddress(server.address());

  const mock: MockImds = {
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
    port: address.port,
    requests,
    url: `http://127.0.0.1:${address.port}`,
  };

  return mock;
};

export { identityDocument, Scenario, startMockImds };

export type { MockImds, MockImdsRequest };
