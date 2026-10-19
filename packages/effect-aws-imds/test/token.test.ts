import { describe, it } from "@effect/vitest";
import { Effect, Redacted } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";

import * as AwsImds from "../src/index.ts";
import { count, fakeImds, methods, text } from "./fixtures.ts";
import type { Route } from "./fixtures.ts";

const PATH = "/latest/meta-data/instance-id";
const TOKEN_HEADER = "x-aws-ec2-metadata-token";
const TTL_HEADER = "x-aws-ec2-metadata-token-ttl-seconds";

const tokenPerAttempt: Route = (_request, attempt) => text(`token-${attempt}`);

describe("session token refresh", () => {
  it.effect(
    "refreshes at most once when IMDS keeps rejecting the token",
    () => {
      const imds = fakeImds({
        get: () => text("expired", 401),
        put: tokenPerAttempt,
      });

      return Effect.gen(function* persistentUnauthorized() {
        const error = yield* Effect.flip(AwsImds.get(PATH));

        expect(error).toBeInstanceOf(AwsImds.AwsImdsMetadataError);
        expect(error).toMatchObject({ path: PATH, status: 401 });
        expect(methods(imds.requests)).toEqual(["PUT", "GET", "PUT", "GET"]);
        expect(
          imds.requests.map((request) => request.headers[TOKEN_HEADER])
        ).toEqual([undefined, "token-1", undefined, "token-2"]);
      }).pipe(Effect.provide(imds.layer()));
    }
  );

  it.effect("keeps the token after failures other than 401", () => {
    const imds = fakeImds({
      get: (request) =>
        request.url.endsWith("/missing") ? text("no", 404) : text("i-123"),
    });

    return Effect.gen(function* keepToken() {
      yield* Effect.flip(AwsImds.get("/latest/meta-data/missing"));
      yield* AwsImds.get(PATH);

      expect(count(imds.requests, "PUT")).toBe(1);
    }).pipe(Effect.provide(imds.layer()));
  });

  it.effect("does not cache a failed token request", () => {
    const imds = fakeImds({
      get: () => text("i-123"),
      put: (_request, attempt) =>
        attempt === 1 ? text("forbidden", 403) : text("token-2"),
    });

    return Effect.gen(function* retryToken() {
      const error = yield* Effect.flip(AwsImds.get(PATH));
      expect(error).toBeInstanceOf(AwsImds.AwsImdsTokenError);
      expect(error).toMatchObject({ status: 403 });

      expect(yield* AwsImds.get(PATH)).toBe("i-123");
      expect(imds.requests.at(-1)?.headers[TOKEN_HEADER]).toBe("token-2");
    }).pipe(Effect.provide(imds.layer()));
  });

  it.effect("rejects an empty token as a token error", () => {
    const imds = fakeImds({ get: () => text("unused"), put: () => text("") });

    return Effect.gen(function* emptyToken() {
      const error = yield* Effect.flip(AwsImds.get(PATH));

      expect(error).toBeInstanceOf(AwsImds.AwsImdsTokenError);
      expect(error).not.toHaveProperty("status");
      expect(count(imds.requests, "GET")).toBe(0);
    }).pipe(Effect.provide(imds.layer()));
  });

  it.effect("keeps token errors typed through the optional combinator", () => {
    const imds = fakeImds({
      get: () => text("unused"),
      put: () => text("no", 403),
    });

    return Effect.gen(function* optionalToken() {
      const error = yield* Effect.flip(
        AwsImds.get(PATH).pipe(AwsImds.optional)
      );

      expect(error).toBeInstanceOf(AwsImds.AwsImdsTokenError);
    }).pipe(Effect.provide(imds.layer()));
  });
});

describe("session token lifetime", () => {
  for (const [ttl, header] of [
    ["500 millis", "1"],
    ["90 seconds", "90"],
    ["90999 millis", "90"],
    ["6 hours", "21600"],
    ["7 hours", "21600"],
  ] as const) {
    it.effect(`requests ${header} seconds for a ${ttl} token TTL`, () => {
      const imds = fakeImds({ get: () => text("ok") });

      return Effect.gen(function* requestedTtl() {
        yield* AwsImds.get(PATH);

        expect(imds.requests[0]?.headers[TTL_HEADER]).toBe(header);
      }).pipe(Effect.provide(imds.layer({ tokenTtl: ttl })));
    });
  }

  it.effect("refreshes a short-lived token halfway through its TTL", () => {
    const imds = fakeImds({
      get: (request) => text(request.headers[TOKEN_HEADER] ?? ""),
      put: tokenPerAttempt,
    });

    return Effect.gen(function* halfway() {
      // A 40 second token refreshes after max(40 - 30, 40 / 2) = 20 seconds.
      expect(yield* AwsImds.get(PATH)).toBe("token-1");

      yield* TestClock.adjust("19 seconds");
      expect(yield* AwsImds.get(PATH)).toBe("token-1");

      yield* TestClock.adjust("2 seconds");
      expect(yield* AwsImds.get(PATH)).toBe("token-2");
    }).pipe(Effect.provide(imds.layer({ tokenTtl: "40 seconds" })));
  });

  it.effect(
    "keeps the default six-hour token until 30 seconds before expiry",
    () => {
      const imds = fakeImds({
        get: (request) => text(request.headers[TOKEN_HEADER] ?? ""),
        put: tokenPerAttempt,
      });

      return Effect.gen(function* defaultLifetime() {
        expect(yield* AwsImds.get(PATH)).toBe("token-1");

        yield* TestClock.adjust("21569 seconds");
        expect(yield* AwsImds.get(PATH)).toBe("token-1");

        yield* TestClock.adjust("2 seconds");
        expect(yield* AwsImds.get(PATH)).toBe("token-2");
      }).pipe(Effect.provide(imds.layer()));
    }
  );
});

describe("AwsImdsToken service", () => {
  it.effect("returns the session token as a Redacted value", () => {
    const imds = fakeImds({
      get: () => text("unused"),
      put: () => text("secret-token"),
    });

    return Effect.gen(function* redacted() {
      const token = yield* AwsImds.AwsImdsToken.use((service) => service.get);

      expect(Redacted.value(token)).toBe("secret-token");
      expect(String(token)).not.toContain("secret-token");
      expect(JSON.stringify({ token })).not.toContain("secret-token");
    }).pipe(Effect.provide(imds.layer()));
  });

  it.effect("invalidates only the token it was given", () => {
    const imds = fakeImds({ get: () => text("unused"), put: tokenPerAttempt });

    return Effect.gen(function* compareAndInvalidate() {
      const service = yield* AwsImds.AwsImdsToken;
      const first = yield* service.get;

      yield* service.invalidate(first);
      const second = yield* service.get;

      yield* service.invalidate(first);
      const stillSecond = yield* service.get;

      yield* service.clear;
      const third = yield* service.get;

      expect([first, second, stillSecond, third].map(Redacted.value)).toEqual([
        "token-1",
        "token-2",
        "token-2",
        "token-3",
      ]);
    }).pipe(Effect.provide(imds.layer()));
  });
});
