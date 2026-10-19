/**
 * Prints a summary of the EC2 instance this process runs on, as JSON.
 *
 * Configuration comes from the environment:
 * - `AWS_EC2_METADATA_SERVICE_ENDPOINT` (default `http://169.254.169.254`)
 * - `IMDS_ATTEMPT_TIMEOUT` (default `1 second`)
 * - `IMDS_RETRIES` (default `2`)
 *
 * Failures, including invalid configuration, are written to stderr as
 * `{ error, message, path?, status? }` and set exit code 1.
 */
import * as AwsImds from "@rc312/effect-aws-imds";
import { Config, Console, Duration, Effect, Layer, Option } from "effect";

// Settings reach the IMDS layers only through `Layer.provide`.
const ImdsConfig = AwsImds.AwsImdsConfig.layerConfig({
  attemptTimeout: Config.Duration("IMDS_ATTEMPT_TIMEOUT").pipe(
    Config.withDefault(Duration.seconds(1))
  ),
  endpoint: Config.String("AWS_EC2_METADATA_SERVICE_ENDPOINT").pipe(
    Config.withDefault("http://169.254.169.254")
  ),
  retrySchedule: Config.Int("IMDS_RETRIES").pipe(
    Config.withDefault(2),
    Config.map(AwsImds.retryPolicy)
  ),
});

const ImdsLive = AwsImds.layerFetch.pipe(Layer.provide(ImdsConfig));

const instanceInfo = Effect.gen(function* instanceInfo() {
  const [document, instanceType, availabilityZone, localIpv4, spotAction] =
    yield* Effect.all(
      [
        AwsImds.identityDocument,
        AwsImds.get("/latest/meta-data/instance-type"),
        AwsImds.get("/latest/meta-data/placement/availability-zone"),
        AwsImds.get("/latest/meta-data/local-ipv4"),
        // Present only while a spot interruption is pending.
        AwsImds.get("/latest/meta-data/spot/instance-action").pipe(
          AwsImds.optional,
          Effect.map(Option.getOrNull)
        ),
      ],
      { concurrency: 5 }
    );

  return {
    accountId: document.accountId,
    architecture: document.architecture,
    availabilityZone,
    instanceId: document.instanceId,
    instanceType,
    launchedAt: document.pendingTime.toISOString(),
    localIpv4,
    region: document.region,
    spotInstanceAction: spotAction,
  };
});

const report = (failure: {
  readonly error: "config" | "metadata" | "token";
  readonly message: string;
  readonly path?: string | undefined;
  readonly status?: number | undefined;
}) => Console.error(JSON.stringify(failure)).pipe(Effect.as(1));

// Provide before recovering, so failures building the layer (such as invalid
// configuration) are reported too.
const program = instanceInfo.pipe(
  Effect.flatMap((info) =>
    Console.log(JSON.stringify(info, null, 2)).pipe(Effect.as(0))
  ),
  Effect.provide(ImdsLive),
  Effect.catchTags({
    AwsImdsMetadataError: (failure) =>
      report({
        error: "metadata",
        message: failure.message,
        path: failure.path,
        status: failure.status,
      }),
    AwsImdsTokenError: (failure) =>
      report({
        error: "token",
        message: failure.message,
        status: failure.status,
      }),
    ConfigError: (failure) =>
      report({ error: "config", message: failure.message }),
  })
);

process.exitCode = await Effect.runPromise(program);
