import { describe, it } from "@effect/vitest";
import {
  Config,
  ConfigProvider,
  Duration,
  Effect,
  Layer,
  Redacted,
  Schema,
} from "effect";
import { expect } from "vitest";

import * as AwsImds from "../src/index.ts";
import { count, document, fakeImds, text } from "./fixtures.ts";

const PATH = "/latest/meta-data/instance-id";

// Maps each IMDS error to a label through `catchTags`.
const label = (failure: Effect.Effect<never, AwsImds.AwsImdsError>) =>
  failure.pipe(
    Effect.catchTags({
      AwsImdsMetadataError: (error) => Effect.succeed(`metadata ${error.path}`),
      AwsImdsTokenError: (error) => Effect.succeed(`token ${error.message}`),
    })
  );

const fromEnv = (env: Record<string, string>) =>
  ConfigProvider.layer(ConfigProvider.fromUnknown(env));

describe("AwsImdsConfig", () => {
  it.effect("uses the documented defaults when nothing provides settings", () =>
    Effect.gen(function* defaults() {
      const settings = yield* AwsImds.AwsImdsConfig;

      expect(settings.endpoint).toBe("http://169.254.169.254");
      expect(Duration.toMillis(settings.attemptTimeout)).toBe(1000);
      expect(Duration.toHours(settings.tokenTtl)).toBe(6);
    })
  );

  it.effect("keeps defaults for every field a partial override omits", () =>
    Effect.gen(function* partial() {
      const settings = yield* AwsImds.AwsImdsConfig;

      expect(settings.endpoint).toBe("http://imds.test");
      expect(Duration.toMillis(settings.attemptTimeout)).toBe(1000);
      expect(Duration.toHours(settings.tokenTtl)).toBe(6);
    }).pipe(
      Effect.provide(
        AwsImds.AwsImdsConfig.layer({ endpoint: "http://imds.test" })
      )
    )
  );

  it.effect("accepts a single Config for all settings", () => {
    const imds = fakeImds({ get: (request) => text(request.url) });

    const settings = AwsImds.AwsImdsConfig.layerConfig(
      Config.all({
        attemptTimeout: Config.Duration("TIMEOUT"),
        endpoint: Config.String("ENDPOINT"),
      })
    ).pipe(
      Layer.provide(
        fromEnv({ ENDPOINT: "http://imds.test", TIMEOUT: "250 millis" })
      )
    );

    return Effect.gen(function* singleConfig() {
      expect(yield* AwsImds.get(PATH)).toBe(`http://imds.test${PATH}`);
    }).pipe(
      Effect.provide(
        AwsImds.layer.pipe(
          Layer.provide(imds.clientLayer),
          Layer.provide(settings)
        )
      )
    );
  });

  it.effect(
    "fails with a ConfigError when a required setting is missing",
    () => {
      const imds = fakeImds({ get: () => text("unused") });

      const settings = AwsImds.AwsImdsConfig.layerConfig({
        endpoint: Config.String("AWS_EC2_METADATA_SERVICE_ENDPOINT"),
      }).pipe(Layer.provide(fromEnv({})));

      return Effect.gen(function* missingSetting() {
        const error = yield* Effect.flip(
          AwsImds.get(PATH).pipe(
            Effect.provide(
              AwsImds.layer.pipe(
                Layer.provide(imds.clientLayer),
                Layer.provide(settings)
              )
            )
          )
        );

        expect(error).toBeInstanceOf(Config.ConfigError);
        expect(imds.requests).toEqual([]);
      });
    }
  );

  it.effect(
    "ignores settings merged beside the layers instead of provided to them",
    () => {
      const imds = fakeImds({ get: (request) => text(request.url) });

      const merged = Layer.merge(
        AwsImds.layer.pipe(Layer.provide(imds.clientLayer)),
        AwsImds.AwsImdsConfig.layer({ endpoint: "http://imds.test" })
      );

      return Effect.gen(function* mergedSettings() {
        expect(yield* AwsImds.get(PATH)).toBe(`http://169.254.169.254${PATH}`);
      }).pipe(Effect.provide(merged));
    }
  );
});

describe("layer composition", () => {
  it.effect(
    "provides working AwsImdsToken, AwsImds, and InstanceIdentity services",
    () => {
      const imds = fakeImds({
        get: (request) =>
          request.url.endsWith("/document")
            ? text(JSON.stringify(document))
            : text("i-123"),
      });

      return Effect.gen(function* services() {
        const token = yield* AwsImds.AwsImdsToken.use((service) => service.get);

        const instanceId = yield* AwsImds.AwsImds.use((service) =>
          service.get(PATH)
        );

        const identity = yield* AwsImds.InstanceIdentity.use(
          (service) => service.document
        );

        expect(Redacted.value(token)).toBe("token-1");
        expect(instanceId).toBe("i-123");
        expect(identity.instanceId).toBe(document.instanceId);
      }).pipe(Effect.provide(imds.layer()));
    }
  );

  it.effect("shares one token between reads and the identity document", () => {
    const imds = fakeImds({
      get: (request) =>
        request.url.endsWith("/document")
          ? text(JSON.stringify(document))
          : text("i-123"),
    });

    return Effect.gen(function* sharedToken() {
      yield* AwsImds.get(PATH);
      yield* AwsImds.identityDocument;
      yield* AwsImds.get(PATH);

      expect(count(imds.requests, "PUT")).toBe(1);
    }).pipe(Effect.provide(imds.layer()));
  });

  it.effect(
    "builds separate caches for separate provides of the same layer",
    () => {
      const imds = fakeImds({ get: () => text("i-123") });
      const layer = imds.layer();

      return Effect.gen(function* separateBuilds() {
        yield* AwsImds.get(PATH).pipe(Effect.provide(layer));
        yield* AwsImds.get(PATH).pipe(Effect.provide(layer));

        expect(count(imds.requests, "PUT")).toBe(2);
      });
    }
  );
});

describe("error contracts", () => {
  it("round-trips both error types through their schemas", () => {
    const metadata = new AwsImds.AwsImdsMetadataError({
      message: "IMDS returned 404",
      path: PATH,
      status: 404,
    });

    const token = new AwsImds.AwsImdsTokenError({ message: "timed out" });

    const metadataEncoded = Schema.encodeSync(AwsImds.AwsImdsMetadataError)(
      metadata
    );

    const tokenEncoded = Schema.encodeSync(AwsImds.AwsImdsTokenError)(token);

    // The wire form carries the tag and every field, and nothing else.
    expect(Object.keys(metadataEncoded).toSorted()).toEqual([
      "_tag",
      "message",
      "path",
      "status",
    ]);
    expect(Object.keys(tokenEncoded).toSorted()).toEqual(["_tag", "message"]);
    expect(Object.values(metadataEncoded)).toContain("AwsImdsMetadataError");
    expect(Object.values(tokenEncoded)).toContain("AwsImdsTokenError");

    const metadataDecoded = Schema.decodeSync(AwsImds.AwsImdsMetadataError)(
      structuredClone(metadataEncoded)
    );

    const tokenDecoded = Schema.decodeSync(AwsImds.AwsImdsTokenError)(
      structuredClone(tokenEncoded)
    );

    expect(metadataDecoded).toBeInstanceOf(AwsImds.AwsImdsMetadataError);
    expect(metadataDecoded).toMatchObject({
      message: "IMDS returned 404",
      path: PATH,
      status: 404,
    });
    expect(tokenDecoded).toBeInstanceOf(AwsImds.AwsImdsTokenError);
    expect(tokenDecoded.message).toBe("timed out");
  });

  it.effect("dispatches both error types with catchTags", () =>
    Effect.gen(function* dispatch() {
      expect(
        yield* label(
          Effect.fail(
            new AwsImds.AwsImdsMetadataError({ message: "x", path: PATH })
          )
        )
      ).toBe(`metadata ${PATH}`);
      expect(
        yield* label(
          Effect.fail(new AwsImds.AwsImdsTokenError({ message: "denied" }))
        )
      ).toBe("token denied");
    })
  );
});
