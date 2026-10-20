import { describe, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Schedule } from "effect";
import { HttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import { expect } from "vitest";

import * as AwsImds from "../src/index.ts";
import {
  count,
  document,
  dropConnection,
  fakeImds,
  recordingTracer,
  text,
} from "./fixtures.ts";
import type { Route } from "./fixtures.ts";

const PATH = "/latest/meta-data/instance-id";
const TOKEN_HEADER_ATTRIBUTE = "http.request.header.x-aws-ec2-metadata-token";

// Runs `effect` in the background, advances virtual time well past any
// retry delay, and returns its result or failure.
const runToCompletion = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* advanceUntilDone() {
    const fiber = yield* Effect.forkChild(effect);

    for (let step = 0; step < 20; step += 1) {
      yield* TestClock.adjust("1 second");
    }

    return yield* Fiber.join(fiber);
  });

describe("status classification", () => {
  for (const status of [408, 429, 500, 502, 503, 504]) {
    it.effect(`retries a transient ${status} response`, () => {
      const imds = fakeImds({
        get: (_request, attempt) =>
          attempt === 1 ? text("busy", status) : text("i-123"),
      });

      return Effect.gen(function* transient() {
        expect(yield* runToCompletion(AwsImds.get(PATH))).toBe("i-123");
        expect(count(imds.requests, "GET")).toBe(2);
      }).pipe(Effect.provide(imds.layer()));
    });
  }

  for (const status of [400, 403, 404, 405]) {
    it.effect(`fails at once on a ${status} response`, () => {
      const imds = fakeImds({ get: () => text("no", status) });

      return Effect.gen(function* permanent() {
        const error = yield* Effect.flip(AwsImds.get(PATH));

        expect(error).toBeInstanceOf(AwsImds.AwsImdsMetadataError);
        expect(error).toMatchObject({ path: PATH, status });
        expect(count(imds.requests, "GET")).toBe(1);
      }).pipe(Effect.provide(imds.layer()));
    });
  }

  it.effect("waits at least as long as a Retry-After header asks", () => {
    const imds = fakeImds({
      get: (_request, attempt) =>
        attempt === 1
          ? text("slow down", 503, { "retry-after": "2" })
          : text("i-123"),
    });

    return Effect.gen(function* retryAfter() {
      const fiber = yield* Effect.forkChild(AwsImds.get(PATH));

      yield* TestClock.adjust("1900 millis");
      expect(count(imds.requests, "GET")).toBe(1);

      yield* TestClock.adjust("200 millis");
      expect(yield* Fiber.join(fiber)).toBe("i-123");
      expect(count(imds.requests, "GET")).toBe(2);
    }).pipe(Effect.provide(imds.layer()));
  });
});

describe("transport failures", () => {
  it.effect("retries a dropped connection", () => {
    const imds = fakeImds({
      get: (_request, attempt) =>
        attempt === 1 ? dropConnection : text("i-123"),
    });

    return Effect.gen(function* dropped() {
      expect(yield* runToCompletion(AwsImds.get(PATH))).toBe("i-123");
      expect(count(imds.requests, "GET")).toBe(2);
    }).pipe(Effect.provide(imds.layer()));
  });

  it.effect("reports a persistent transport failure without a status", () => {
    const imds = fakeImds({ get: () => dropConnection });

    return Effect.gen(function* persistentDrop() {
      const error = yield* Effect.flip(runToCompletion(AwsImds.get(PATH)));

      expect(error).toBeInstanceOf(AwsImds.AwsImdsMetadataError);
      expect(count(imds.requests, "GET")).toBe(3);
      expect(error).not.toHaveProperty("status");
      expect(JSON.stringify(error)).not.toContain("token-1");
    }).pipe(Effect.provide(imds.layer()));
  });
});

describe("response bodies", () => {
  for (const method of ["PUT", "GET"] as const) {
    it.effect(`retries an interrupted ${method} response body`, () => {
      const interrupted: Effect.Effect<Response> = Effect.sync(
        () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error("connection reset during body"));
              },
            })
          )
      );

      const route: Route = (_request, attempt) =>
        attempt === 1 ? interrupted : text("complete");

      const imds = fakeImds({
        get: method === "GET" ? route : () => text("complete"),
        put: method === "PUT" ? route : () => text("token-1"),
      });

      return Effect.gen(function* interruptedBody() {
        expect(yield* runToCompletion(AwsImds.get(PATH))).toBe("complete");
        expect(count(imds.requests, method)).toBe(2);
        expect(count(imds.requests, method === "PUT" ? "GET" : "PUT")).toBe(1);
      }).pipe(Effect.provide(imds.layer()));
    });
  }

  it.effect("does not retry metadata schema decoding failures", () => {
    const imds = fakeImds({ get: () => text("not JSON") });

    return Effect.gen(function* invalidDocument() {
      const error = yield* Effect.flip(AwsImds.identityDocument);

      expect(error).toBeInstanceOf(AwsImds.AwsImdsMetadataError);
      expect(count(imds.requests, "GET")).toBe(1);
    }).pipe(Effect.provide(imds.layer()));
  });
});

describe("retry policy", () => {
  it.effect("makes three attempts with the default policy", () => {
    const imds = fakeImds({ get: () => text("busy", 503) });

    return Effect.gen(function* defaults() {
      const error = yield* Effect.flip(runToCompletion(AwsImds.get(PATH)));

      expect(error).toMatchObject({ status: 503 });
      expect(count(imds.requests, "GET")).toBe(3);
    }).pipe(Effect.provide(imds.layer()));
  });

  for (const retries of [0, 1, 3]) {
    it.effect(
      `retryPolicy(${retries}) allows exactly ${retries} retries`,
      () => {
        const imds = fakeImds({ get: () => text("busy", 503) });

        return Effect.gen(function* bounded() {
          yield* Effect.flip(runToCompletion(AwsImds.get(PATH)));

          expect(count(imds.requests, "GET")).toBe(retries + 1);
        }).pipe(
          Effect.provide(
            imds.layer({ retrySchedule: AwsImds.retryPolicy(retries) })
          )
        );
      }
    );
  }

  it.effect("backs off exponentially from 50 ms with ±20% jitter", () => {
    const imds = fakeImds({ get: () => text("busy", 503) });

    return Effect.gen(function* backoff() {
      const fiber = yield* Effect.forkChild(Effect.flip(AwsImds.get(PATH)));

      // First retry after 40–60 ms, second 80–120 ms after that.
      yield* TestClock.adjust("39 millis");
      expect(count(imds.requests, "GET")).toBe(1);

      yield* TestClock.adjust("22 millis");
      expect(count(imds.requests, "GET")).toBe(2);

      yield* TestClock.adjust("58 millis");
      expect(count(imds.requests, "GET")).toBe(2);

      yield* TestClock.adjust("62 millis");
      expect(count(imds.requests, "GET")).toBe(3);

      yield* Fiber.join(fiber);
    }).pipe(Effect.provide(imds.layer()));
  });

  it.effect("accepts any bounded Schedule as the retry policy", () => {
    const imds = fakeImds({
      get: (_request, attempt) =>
        attempt < 3 ? text("busy", 503) : text("i-123"),
    });

    return Effect.gen(function* customSchedule() {
      const fiber = yield* Effect.forkChild(AwsImds.get(PATH));

      yield* TestClock.adjust("999 millis");
      expect(count(imds.requests, "GET")).toBe(1);

      yield* TestClock.adjust("1 second");
      yield* TestClock.adjust("1 second");
      expect(yield* Fiber.join(fiber)).toBe("i-123");
      expect(count(imds.requests, "GET")).toBe(3);
    }).pipe(
      Effect.provide(
        imds.layer({
          retrySchedule: Schedule.spaced("1 second").pipe(
            Schedule.upTo({ times: 5 })
          ),
        })
      )
    );
  });
});

describe("observability", () => {
  it.effect(
    "names spans for reads, token requests, and document resolution",
    () => {
      const imds = fakeImds({
        get: (request) =>
          request.url.endsWith("/document")
            ? text(JSON.stringify(document))
            : text("i-123"),
      });

      const tracer = recordingTracer();

      return Effect.gen(function* spans() {
        yield* AwsImds.get(PATH);
        yield* AwsImds.identityDocument;

        const names = tracer.spans.map((span) => span.name);
        expect(names).toEqual(
          expect.arrayContaining([
            "AwsImds.get",
            "AwsImdsToken.fetch",
            "InstanceIdentity.resolve",
          ])
        );

        const reads = tracer.spans.filter(
          (span) => span.name === "AwsImds.get"
        );

        expect(
          reads.map((span) => span.attributes.get("aws.imds.path"))
        ).toEqual([PATH, "/latest/dynamic/instance-identity/document"]);
        expect(
          names.filter((name) => name === "AwsImdsToken.fetch")
        ).toHaveLength(1);
      }).pipe(Effect.provide(Layer.merge(imds.layer(), tracer.layer)));
    }
  );

  it.effect(
    "records the session token as <redacted> when headers are captured",
    () => {
      const imds = fakeImds({ get: () => text("i-123") });
      const tracer = recordingTracer();

      const captureAllHeaders = Layer.succeed(
        HttpClient.TracerHeaderFilter,
        () => true
      );

      return Effect.gen(function* redacted() {
        yield* AwsImds.get(PATH);

        const captured = tracer.spans.flatMap((span) => {
          const value = span.attributes.get(TOKEN_HEADER_ATTRIBUTE);

          return value === undefined ? [] : [value];
        });

        expect(captured).toEqual(["<redacted>"]);
        expect(
          JSON.stringify(tracer.spans.flatMap((span) => [...span.attributes]))
        ).not.toContain("token-1");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(imds.layer(), tracer.layer, captureAllHeaders)
        )
      );
    }
  );
});
