import { describe, it } from "@effect/vitest";
import {
  Config,
  ConfigProvider,
  Effect,
  Fiber,
  Layer,
  Option,
  Redacted,
  Schema,
} from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { TestClock } from "effect/testing";
import { expect } from "vitest";

import * as AwsImds from "../src/index.ts";
import { document, fakeImds, methods, text } from "./fixtures.ts";

describe("AwsImds", () => {
  it.effect("fetches a session token and decodes the identity document", () => {
    const imds = fakeImds({ get: () => text(JSON.stringify(document)) });

    return Effect.gen(function* decodeDocument() {
      const result = yield* AwsImds.identityDocument;

      expect(result.accountId).toBe("123456789012");
      expect(result.region).toBe("us-east-1");
      expect(result.pendingTime).toEqual(new Date("2024-01-02T03:04:05Z"));
      expect(result).not.toHaveProperty("addedByAwsLater");
      expect(imds.requests).toEqual([
        {
          headers: expect.objectContaining({
            "x-aws-ec2-metadata-token-ttl-seconds": "21600",
          }),
          method: "PUT",
          redactsToken: false,
          url: "http://169.254.169.254/latest/api/token",
        },
        {
          headers: expect.objectContaining({
            "x-aws-ec2-metadata-token": "token-1",
          }),
          method: "GET",
          redactsToken: true,
          url: "http://169.254.169.254/latest/dynamic/instance-identity/document",
        },
      ]);
    }).pipe(Effect.provide(imds.layer()));
  });

  it.effect("encodes a decoded identity document back to its wire form", () =>
    Effect.gen(function* roundTrip() {
      const { addedByAwsLater: _extra, ...wire } = {
        ...document,
        pendingTime: "2024-01-02T03:04:05.000Z",
      };

      const decoded = yield* Schema.decodeUnknownEffect(
        AwsImds.IdentityDocument
      )(wire);

      expect(
        yield* Schema.encodeEffect(AwsImds.IdentityDocument)(decoded)
      ).toEqual(wire);
    })
  );

  it.effect("shares one token request between concurrent reads", () => {
    const imds = fakeImds({ get: () => text("ok") });

    return Effect.gen(function* dedupeToken() {
      yield* Effect.all(
        [
          AwsImds.get("/latest/meta-data/ami-id"),
          AwsImds.get("/latest/meta-data/instance-id"),
          AwsImds.get("/latest/meta-data/instance-type"),
        ],
        { concurrency: 3 }
      );

      expect(methods(imds.requests)).toEqual(["PUT", "GET", "GET", "GET"]);
    }).pipe(Effect.provide(imds.layer()));
  });

  it.effect(
    "reads settings from Config through AwsImdsConfig.layerConfig",
    () => {
      const imds = fakeImds({ get: (request) => text(request.url) });

      const config = AwsImds.AwsImdsConfig.layerConfig({
        endpoint: Config.String("IMDS_ENDPOINT"),
        tokenTtl: Config.Duration("IMDS_TOKEN_TTL"),
      }).pipe(
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              IMDS_ENDPOINT: "http://imds.test",
              IMDS_TOKEN_TTL: "10 minutes",
            })
          )
        )
      );

      const layer = AwsImds.layer.pipe(
        Layer.provide(imds.clientLayer),
        Layer.provide(config)
      );

      return Effect.gen(function* configured() {
        expect(yield* AwsImds.get("/latest/meta-data/ami-id")).toBe(
          "http://imds.test/latest/meta-data/ami-id"
        );
        expect(imds.requests[0]?.headers).toMatchObject({
          "x-aws-ec2-metadata-token-ttl-seconds": "600",
        });
      }).pipe(Effect.provide(layer));
    }
  );

  it.effect("defaults omitted optional document fields to null", () => {
    const {
      billingProducts: _billing,
      kernelId: _kernel,
      ...minimal
    } = document;

    const imds = fakeImds({ get: () => text(JSON.stringify(minimal)) });

    return Effect.gen(function* defaultOptionalFields() {
      const result = yield* AwsImds.identityDocument;
      expect(result.billingProducts).toBeNull();
      expect(result.kernelId).toBeNull();
    }).pipe(Effect.provide(imds.layer()));
  });

  it.effect("memoizes the identity document until the cache is cleared", () => {
    const imds = fakeImds({ get: () => text(JSON.stringify(document)) });

    return Effect.gen(function* memoizeDocument() {
      yield* AwsImds.identityDocument;
      yield* AwsImds.identityDocument;
      expect(methods(imds.requests)).toEqual(["PUT", "GET"]);

      yield* AwsImds.clearCache;
      yield* AwsImds.identityDocument;
      expect(methods(imds.requests)).toEqual(["PUT", "GET", "PUT", "GET"]);
    }).pipe(Effect.provide(imds.layer()));
  });

  it.effect("does not cache failed identity document lookups", () => {
    const imds = fakeImds({
      get: (_request, attempt) =>
        attempt === 1 ? text("missing", 404) : text(JSON.stringify(document)),
    });

    return Effect.gen(function* retryFailedLookup() {
      const error = yield* Effect.flip(AwsImds.identityDocument);
      expect(error).toBeInstanceOf(AwsImds.AwsImdsMetadataError);
      expect(error).toMatchObject({ status: 404 });

      const result = yield* AwsImds.identityDocument;
      expect(result.instanceId).toBe("i-1234567890abcdef0");
    }).pipe(Effect.provide(imds.layer()));
  });

  it.effect("rejects identity documents with malformed fields", () => {
    const imds = fakeImds({
      get: () => text(JSON.stringify({ ...document, accountId: "1234" })),
    });

    return Effect.gen(function* rejectMalformedDocument() {
      const error = yield* Effect.flip(AwsImds.identityDocument);
      expect(error).toBeInstanceOf(AwsImds.AwsImdsMetadataError);
      expect(error).toMatchObject({
        path: "/latest/dynamic/instance-identity/document",
      });
      expect(error).not.toHaveProperty("status");
    }).pipe(Effect.provide(imds.layer()));
  });

  it.effect("keeps the session token out of metadata errors", () => {
    const imds = fakeImds({ get: () => text("missing", 404) });

    return Effect.gen(function* redactToken() {
      const error = yield* Effect.flip(AwsImds.get("/latest/meta-data/spot"));

      expect(error).toMatchObject({
        path: "/latest/meta-data/spot",
        status: 404,
      });
      expect(`${JSON.stringify(error)} ${String(error)}`).not.toContain(
        "token-1"
      );
    }).pipe(Effect.provide(imds.layer()));
  });

  it.effect("accepts regions outside the two-letter prefix convention", () => {
    const imds = fakeImds({
      get: () =>
        text(JSON.stringify({ ...document, region: "eusc-de-east-1" })),
    });

    return Effect.gen(function* acceptSovereignRegion() {
      const result = yield* AwsImds.identityDocument;
      expect(result.region).toBe("eusc-de-east-1");
    }).pipe(Effect.provide(imds.layer()));
  });

  it.effect("reuses one session token across metadata reads", () => {
    const imds = fakeImds({ get: (request) => text(request.url) });

    return Effect.gen(function* reuseToken() {
      const instanceId = yield* AwsImds.get("/latest/meta-data/instance-id");
      yield* AwsImds.get("/latest/meta-data/instance-type");

      expect(instanceId).toBe(
        "http://[fd00:ec2::254]/latest/meta-data/instance-id"
      );
      expect(methods(imds.requests)).toEqual(["PUT", "GET", "GET"]);
    }).pipe(Effect.provide(imds.layer({ endpoint: "http://[fd00:ec2::254]" })));
  });

  it.effect("refreshes the session token once after a 401", () => {
    const imds = fakeImds({
      get: (request) =>
        request.headers["x-aws-ec2-metadata-token"] === "token-1"
          ? text("expired", 401)
          : text("i-1234567890abcdef0"),
      put: (_request, attempt) => text(`token-${attempt}`),
    });

    return Effect.gen(function* refreshAfterUnauthorized() {
      const instanceId = yield* AwsImds.get("/latest/meta-data/instance-id");

      expect(instanceId).toBe("i-1234567890abcdef0");
      expect(methods(imds.requests)).toEqual(["PUT", "GET", "PUT", "GET"]);
    }).pipe(Effect.provide(imds.layer()));
  });

  it.effect("refreshes the session token shortly before it expires", () => {
    const imds = fakeImds({
      get: (request) => text(request.headers["x-aws-ec2-metadata-token"] ?? ""),
      put: (_request, attempt) => text(`token-${attempt}`),
    });

    return Effect.gen(function* refreshBeforeExpiry() {
      expect(yield* AwsImds.get("/latest/meta-data/ami-id")).toBe("token-1");
      yield* TestClock.adjust("89 seconds");
      expect(yield* AwsImds.get("/latest/meta-data/ami-id")).toBe("token-1");
      yield* TestClock.adjust("2 seconds");
      expect(yield* AwsImds.get("/latest/meta-data/ami-id")).toBe("token-2");
      expect(imds.requests[0]?.headers).toMatchObject({
        "x-aws-ec2-metadata-token-ttl-seconds": "120",
      });
    }).pipe(Effect.provide(imds.layer({ tokenTtl: "2 minutes" })));
  });

  it.effect("clamps the requested token lifetime to the IMDS maximum", () => {
    const imds = fakeImds({ get: () => text("ok") });

    return Effect.gen(function* clampTokenTtl() {
      yield* AwsImds.get("/latest/meta-data/ami-id");
      expect(imds.requests[0]?.headers).toMatchObject({
        "x-aws-ec2-metadata-token-ttl-seconds": "21600",
      });
    }).pipe(Effect.provide(imds.layer({ tokenTtl: "2 days" })));
  });

  it.effect("fails with a token error when IMDSv2 is unavailable", () => {
    const imds = fakeImds({
      get: () => text("unused"),
      put: () => text("forbidden", 403),
    });

    return Effect.gen(function* failWithoutToken() {
      const error = yield* Effect.flip(AwsImds.get("/latest/meta-data/ami-id"));
      expect(error).toBeInstanceOf(AwsImds.AwsImdsTokenError);
      expect(methods(imds.requests)).toEqual(["PUT"]);
    }).pipe(Effect.provide(imds.layer()));
  });

  it.effect("times out each attempt and retries transient failures", () => {
    const imds = fakeImds({
      get: (_request, attempt) =>
        attempt === 1 ? Effect.never : text("i-1234567890abcdef0"),
    });

    return Effect.gen(function* retryTimedOutAttempt() {
      const fiber = yield* AwsImds.get("/latest/meta-data/instance-id").pipe(
        Effect.forkChild
      );

      yield* TestClock.adjust("1 second");
      yield* TestClock.adjust("1 second");

      expect(yield* Fiber.join(fiber)).toBe("i-1234567890abcdef0");
      expect(methods(imds.requests)).toEqual(["PUT", "GET", "GET"]);
    }).pipe(Effect.provide(imds.layer()));
  });

  it.effect(
    "fails after exhausting retries for an unreachable endpoint",
    () => {
      const imds = fakeImds({
        get: () => Effect.never,
        put: () => Effect.never,
      });

      return Effect.gen(function* failWhenUnreachable() {
        const fiber = yield* Effect.flip(
          AwsImds.get("/latest/meta-data/ami-id")
        ).pipe(Effect.forkChild);

        for (let step = 0; step < 5; step += 1) {
          yield* TestClock.adjust("1 second");
        }

        expect(yield* Fiber.join(fiber)).toBeInstanceOf(
          AwsImds.AwsImdsTokenError
        );
        expect(methods(imds.requests)).toEqual(["PUT", "PUT"]);
      }).pipe(
        Effect.provide(imds.layer({ retrySchedule: AwsImds.retryPolicy(1) }))
      );
    }
  );

  it.effect(
    "keeps the token request outside each read's attempt timeout",
    () => {
      const imds = fakeImds({
        get: () => Effect.sleep("700 millis").pipe(Effect.andThen(text("ok"))),
        put: () =>
          Effect.sleep("700 millis").pipe(Effect.andThen(text("token-1"))),
      });

      return Effect.gen(function* slowTokenAndRead() {
        const fiber = yield* AwsImds.get("/latest/meta-data/ami-id").pipe(
          Effect.forkChild
        );

        yield* TestClock.adjust("700 millis");
        yield* TestClock.adjust("700 millis");

        expect(yield* Fiber.join(fiber)).toBe("ok");
        expect(methods(imds.requests)).toEqual(["PUT", "GET"]);
      }).pipe(Effect.provide(imds.layer()));
    }
  );

  it.effect("refreshes once when concurrent reads all receive a 401", () => {
    const imds = fakeImds({
      get: (request) =>
        request.headers["x-aws-ec2-metadata-token"] === "token-1"
          ? text("expired", 401)
          : text("ok"),
      put: (_request, attempt) => text(`token-${attempt}`),
    });

    return Effect.gen(function* concurrentUnauthorized() {
      const reads = yield* Effect.all(
        [
          AwsImds.get("/latest/meta-data/ami-id"),
          AwsImds.get("/latest/meta-data/instance-id"),
          AwsImds.get("/latest/meta-data/instance-type"),
        ],
        { concurrency: 3 }
      );

      expect(reads).toEqual(["ok", "ok", "ok"]);
      expect(
        methods(imds.requests).filter((method) => method === "PUT")
      ).toEqual(["PUT", "PUT"]);
    }).pipe(Effect.provide(imds.layer()));
  });
});

describe("AwsImds combinators", () => {
  it.effect("optional maps a 404 to none and keeps other failures", () => {
    const imds = fakeImds({
      get: (request) => {
        if (request.url.endsWith("/spot/instance-action")) {
          return text("missing", 404);
        }

        return request.url.endsWith("/forbidden")
          ? text("no", 403)
          : text("i-1234567890abcdef0");
      },
    });

    return Effect.gen(function* optionalReads() {
      const missing = yield* AwsImds.get(
        "/latest/meta-data/spot/instance-action"
      ).pipe(AwsImds.optional);

      const present = yield* AwsImds.get("/latest/meta-data/instance-id").pipe(
        AwsImds.optional
      );

      const forbidden = yield* AwsImds.get("/latest/meta-data/forbidden").pipe(
        AwsImds.optional,
        Effect.flip
      );

      expect(missing).toEqual(Option.none());
      expect(present).toEqual(Option.some("i-1234567890abcdef0"));
      expect(forbidden).toMatchObject({
        path: "/latest/meta-data/forbidden",
        status: 403,
      });
    }).pipe(Effect.provide(imds.layer()));
  });

  it.effect(
    "getSchema decodes metadata text and reports decode failures",
    () => {
      const Credentials = Schema.fromJsonString(
        Schema.Struct({ Code: Schema.Literal("Success") })
      );

      const imds = fakeImds({
        get: (request) =>
          text(
            request.url.endsWith("/good")
              ? JSON.stringify({ Code: "Success" })
              : JSON.stringify({ Code: "Failure" })
          ),
      });

      return Effect.gen(function* decodedReads() {
        const good = yield* AwsImds.getSchema(
          "/latest/meta-data/good",
          Credentials
        );

        const bad = yield* AwsImds.getSchema(
          "/latest/meta-data/bad",
          Credentials
        ).pipe(Effect.flip);

        expect(good).toEqual({ Code: "Success" });
        expect(bad).toBeInstanceOf(AwsImds.AwsImdsMetadataError);
        expect(bad).toMatchObject({ path: "/latest/meta-data/bad" });
        expect(bad).not.toHaveProperty("status");
      }).pipe(Effect.provide(imds.layer()));
    }
  );
});

describe("AwsImds layers as seams", () => {
  it.effect(
    "reads with a token supplied by a custom AwsImdsToken layer",
    () => {
      const imds = fakeImds({ get: () => text("ok") });

      const staticToken = Layer.succeed(
        AwsImds.AwsImdsToken,
        AwsImds.AwsImdsToken.of({
          clear: Effect.void,
          get: Effect.succeed(Redacted.make("static-token")),
          invalidate: () => Effect.void,
        })
      );

      const layer = AwsImds.AwsImds.layer.pipe(
        Layer.provide(staticToken),
        Layer.provide(imds.clientLayer)
      );

      return Effect.gen(function* customToken() {
        yield* AwsImds.get("/latest/meta-data/ami-id");

        expect(imds.requests).toEqual([
          expect.objectContaining({
            headers: expect.objectContaining({
              "x-aws-ec2-metadata-token": "static-token",
            }),
            method: "GET",
          }),
        ]);
      }).pipe(Effect.provide(layer));
    }
  );

  it.effect("lets application code depend on InstanceIdentity alone", () => {
    const { addedByAwsLater: _extra, ...wire } = document;
    const decoded = Schema.decodeUnknownSync(AwsImds.IdentityDocument)(wire);

    const fixedIdentity = Layer.succeed(
      AwsImds.InstanceIdentity,
      AwsImds.InstanceIdentity.of({
        document: Effect.succeed(decoded),
        invalidate: Effect.void,
      })
    );

    const regionLabel = AwsImds.identityDocument.pipe(
      Effect.map(
        (identity) => `${identity.region}/${identity.availabilityZone}`
      )
    );

    return regionLabel.pipe(
      Effect.map((label) => expect(label).toBe("us-east-1/us-east-1a")),
      Effect.provide(fixedIdentity)
    );
  });

  it.effect(
    "composes the public client combinators with a caller's own",
    () => {
      const imds = fakeImds({ get: () => text("ok") });

      return Effect.gen(function* customClient() {
        const settings = yield* AwsImds.AwsImdsConfig;
        const token = yield* AwsImds.AwsImdsToken;

        const client = (yield* HttpClient.HttpClient).pipe(
          AwsImds.imdsTransport(settings),
          HttpClient.mapRequest(HttpClientRequest.setHeader("x-trace", "abc")),
          AwsImds.withSessionToken(token)
        );

        const body = yield* client
          .get("/latest/meta-data/ami-id")
          .pipe(Effect.flatMap((response) => response.text));

        expect(body).toBe("ok");
        expect(imds.requests.at(-1)?.headers).toMatchObject({
          "x-aws-ec2-metadata-token": "token-1",
          "x-trace": "abc",
        });
      }).pipe(
        Effect.provide(
          AwsImds.AwsImdsToken.layer.pipe(Layer.provideMerge(imds.clientLayer))
        )
      );
    }
  );
});
