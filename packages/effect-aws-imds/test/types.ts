import { Config, Effect, Layer as L, Redacted, Schema } from "effect";
import type { Layer, Option } from "effect";
import type { HttpClient } from "effect/http";

import * as AwsImds from "../src/index.ts";

type Is<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const assertType = <T extends true>(_: T) => _;

const optionalRead = AwsImds.get("/x").pipe(AwsImds.optional);

assertType<
  Is<
    typeof optionalRead,
    Effect.Effect<Option.Option<string>, AwsImds.AwsImdsError, AwsImds.AwsImds>
  >
>(true);

const decoded = AwsImds.getSchema(
  "/x",
  Schema.fromJsonString(Schema.Struct({ a: Schema.Finite }))
);

assertType<
  Is<
    typeof decoded,
    Effect.Effect<{ readonly a: number }, AwsImds.AwsImdsError, AwsImds.AwsImds>
  >
>(true);

assertType<
  Is<
    typeof AwsImds.layer,
    Layer.Layer<
      AwsImds.InstanceIdentity | AwsImds.AwsImds | AwsImds.AwsImdsToken,
      never,
      HttpClient.HttpClient
    >
  >
>(true);

assertType<
  Is<
    typeof AwsImds.layerFetch,
    Layer.Layer<
      AwsImds.InstanceIdentity | AwsImds.AwsImds | AwsImds.AwsImdsToken
    >
  >
>(true);

// README snippets, kept here so they typecheck.
const StaticToken = L.succeed(
  AwsImds.AwsImdsToken,
  AwsImds.AwsImdsToken.of({
    clear: Effect.void,
    get: Effect.succeed(Redacted.make("token-issued-elsewhere")),
    invalidate: () => Effect.void,
  })
);

const Reads = AwsImds.AwsImds.layer.pipe(L.provide(StaticToken));

assertType<
  Is<typeof Reads, Layer.Layer<AwsImds.AwsImds, never, HttpClient.HttpClient>>
>(true);

const ImdsLive = AwsImds.layerFetch.pipe(
  L.provide(
    AwsImds.AwsImdsConfig.layerConfig({
      endpoint: Config.String("AWS_EC2_METADATA_SERVICE_ENDPOINT").pipe(
        Config.withDefault("http://169.254.169.254")
      ),
      retrySchedule: Config.Int("IMDS_RETRIES").pipe(
        Config.withDefault(2),
        Config.map(AwsImds.retryPolicy)
      ),
    })
  )
);

assertType<
  Is<
    typeof ImdsLive,
    Layer.Layer<
      AwsImds.InstanceIdentity | AwsImds.AwsImds | AwsImds.AwsImdsToken,
      Config.ConfigError
    >
  >
>(true);
