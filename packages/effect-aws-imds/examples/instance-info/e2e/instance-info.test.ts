import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { identityDocument, startMockImds } from "../src/mock-imds.ts";
import type { MockImds, MockImdsRequest } from "../src/mock-imds.ts";

const CLI = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const IDENTITY_DOCUMENT_PATH = "/latest/dynamic/instance-identity/document";
const SPOT_ACTION_PATH = "/latest/meta-data/spot/instance-action";
const PROCESS_TIMEOUT_MS = 15_000;

const Failure = Schema.Struct({
  error: Schema.Literals(["config", "metadata", "token"]),
  message: Schema.String,
  path: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Int),
});

const decodeFailure = Schema.decodeUnknownSync(Schema.fromJsonString(Failure));

const expectedInfo = {
  accountId: identityDocument.accountId,
  architecture: identityDocument.architecture,
  availabilityZone: identityDocument.availabilityZone,
  instanceId: identityDocument.instanceId,
  instanceType: identityDocument.instanceType,
  launchedAt: "2026-10-01T08:30:00.000Z",
  localIpv4: identityDocument.privateIp,
  region: identityDocument.region,
  spotInstanceAction: null,
};

// Runs the built CLI as a separate Node process and collects its output.
const runCli = async (env: Readonly<Record<string, string>>) => {
  const started = performance.now();

  const child = spawn(process.execPath, [CLI], {
    env: { PATH: process.env.PATH ?? "", ...env },
    signal: AbortSignal.timeout(PROCESS_TIMEOUT_MS),
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const [code] = await once(child, "close");

  return { code, elapsedMs: performance.now() - started, stderr, stdout };
};

const runAgainst = (
  mock: MockImds,
  env: Readonly<Record<string, string>> = {}
) => runCli({ AWS_EC2_METADATA_SERVICE_ENDPOINT: mock.url, ...env });

const count = (requests: readonly MockImdsRequest[], method: string) =>
  requests.filter((request) => request.method === method).length;

const open: MockImds[] = [];

const mockImds = async (...args: Parameters<typeof startMockImds>) => {
  const mock = await startMockImds(...args);
  open.push(mock);

  return mock;
};

afterEach(async () => {
  await Promise.all(open.splice(0).map((mock) => mock.close()));
});

describe("instance-info CLI against a mock IMDS", () => {
  it("prints instance details using one IMDSv2 session token", async () => {
    const mock = await mockImds("healthy");

    const result = await runAgainst(mock);

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(expectedInfo);

    const [tokenRequest, ...reads] = mock.requests;
    expect(tokenRequest).toEqual({
      method: "PUT",
      path: "/latest/api/token",
      status: 200,
      token: undefined,
      ttl: "21600",
    });
    expect(reads).toHaveLength(5);
    expect(new Set(reads.map((read) => read.token))).toEqual(
      new Set(["mock-token-1"])
    );
    expect(reads).toContainEqual(
      expect.objectContaining({ path: SPOT_ACTION_PATH, status: 404 })
    );
  });

  it("retries throttled and unavailable responses", async () => {
    const mock = await mockImds("flaky");

    const result = await runAgainst(mock);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(expectedInfo);
    expect(mock.requests.map((request) => request.status)).toEqual(
      expect.arrayContaining([503, 429])
    );
    expect(count(mock.requests, "PUT")).toBe(2);
    // Five reads plus one retry of the throttled read.
    expect(count(mock.requests, "GET")).toBe(6);
  });

  it("retries twice by default when IMDS_RETRIES is unset", async () => {
    const mock = await mockImds("hang");

    const result = await runAgainst(mock, {
      IMDS_ATTEMPT_TIMEOUT: "200 millis",
    });

    expect(result.code).toBe(1);
    expect(decodeFailure(result.stderr.trim())).toMatchObject({
      error: "token",
    });
    expect(count(mock.requests, "PUT")).toBe(3);
  });

  it("reports invalid configuration as a config error without contacting IMDS", async () => {
    const mock = await mockImds("healthy");

    const result = await runAgainst(mock, { IMDS_RETRIES: "lots" });

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    const failure = decodeFailure(result.stderr.trim());
    expect(failure.error).toBe("config");
    expect(failure.message).toContain("IMDS_RETRIES");
    expect(mock.requests).toEqual([]);
  });

  it("refreshes the session token when IMDS rejects it", async () => {
    const mock = await mockImds("expire-tokens");

    const result = await runAgainst(mock);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(expectedInfo);
    expect(mock.requests).toContainEqual(
      expect.objectContaining({ method: "GET", status: 401 })
    );
    // Two concurrent reads are rejected with the first token; one refresh serves both.
    expect(count(mock.requests, "PUT")).toBe(2);
    expect(count(mock.requests, "GET")).toBe(7);
  });

  it("reports an invalid identity document with its path", async () => {
    const mock = await mockImds("malformed");

    const result = await runAgainst(mock);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(decodeFailure(result.stderr.trim())).toMatchObject({
      error: "metadata",
      path: IDENTITY_DOCUMENT_PATH,
    });
  });

  it("gives up on an unresponsive IMDS within the attempt budget", async () => {
    const mock = await mockImds("hang");

    const result = await runAgainst(mock, {
      IMDS_ATTEMPT_TIMEOUT: "200 millis",
      IMDS_RETRIES: "1",
    });

    expect(result.code).toBe(1);
    expect(decodeFailure(result.stderr.trim())).toMatchObject({
      error: "token",
    });
    expect(mock.requests.map((request) => request.method)).toEqual([
      "PUT",
      "PUT",
    ]);
    expect(result.elapsedMs).toBeLessThan(5000);
  });

  it("fails with a typed token error when no IMDS is listening", async () => {
    const probe = await startMockImds();
    const { port } = probe;
    await probe.close();

    const result = await runCli({
      AWS_EC2_METADATA_SERVICE_ENDPOINT: `http://127.0.0.1:${port}`,
      IMDS_RETRIES: "0",
    });

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    const failure = decodeFailure(result.stderr.trim());
    expect(failure.error).toBe("token");
    expect(failure).not.toHaveProperty("status");
  });
});

describe("mock IMDS strictness", () => {
  it("rejects reads without a session token", async () => {
    const mock = await mockImds("healthy");

    const response = await fetch(`${mock.url}${IDENTITY_DOCUMENT_PATH}`);

    expect(response.status).toBe(401);
  });

  it("rejects token requests without a valid TTL or behind a proxy", async () => {
    const mock = await mockImds("healthy");
    const tokenUrl = `${mock.url}/latest/api/token`;

    const missingTtl = await fetch(tokenUrl, { method: "PUT" });

    const tooLong = await fetch(tokenUrl, {
      headers: { "x-aws-ec2-metadata-token-ttl-seconds": "21601" },
      method: "PUT",
    });

    const forwarded = await fetch(tokenUrl, {
      headers: {
        "x-aws-ec2-metadata-token-ttl-seconds": "60",
        "x-forwarded-for": "203.0.113.7",
      },
      method: "PUT",
    });

    expect([missingTtl.status, tooLong.status, forwarded.status]).toEqual([
      400, 400, 403,
    ]);
  });
});
