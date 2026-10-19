import { Config, Context, Duration, Effect, Layer, Schedule } from "effect";

const RETRY_BASE_DELAY = Duration.millis(50);

/**
 * The default retry policy: jittered exponential backoff from 50 ms, bounded
 * to `times` retries after the first attempt.
 *
 * @since 0.1.0
 */
const retryPolicy = (times: number) =>
  Schedule.exponential(RETRY_BASE_DELAY).pipe(
    Schedule.jittered,
    Schedule.upTo({ times })
  );

/**
 * Resolved settings read by every IMDS layer.
 *
 * @since 0.1.0
 */
interface AwsImdsSettings {
  /** Base URL of the metadata service. */
  readonly endpoint: string;
  /**
   * Requested session token lifetime. The value sent to IMDS is rounded down
   * to whole seconds and clamped to 1 second through 6 hours.
   */
  readonly tokenTtl: Duration.Duration;
  /** Timeout for each individual HTTP attempt. */
  readonly attemptTimeout: Duration.Duration;
  /**
   * Policy for retrying timeouts, transport errors, and transient statuses.
   * It is the only bound on retries, so it must stop on its own, for example
   * with `Schedule.upTo`.
   */
  readonly retrySchedule: Schedule.Schedule<unknown>;
}

/**
 * Partial settings for `AwsImdsConfig.layer` and `AwsImdsConfig.layerConfig`.
 * Omitted fields keep their defaults.
 *
 * @since 0.1.0
 */
interface AwsImdsOptions {
  /** Defaults to `http://169.254.169.254`; use `http://[fd00:ec2::254]` on IPv6-only instances. */
  readonly endpoint?: string | undefined;
  /** Defaults to 6 hours. */
  readonly tokenTtl?: Duration.Input | undefined;
  /** Defaults to 1 second. */
  readonly attemptTimeout?: Duration.Input | undefined;
  /** Defaults to `retryPolicy(2)`. Must be bounded, for example with `Schedule.upTo`. */
  readonly retrySchedule?: Schedule.Schedule<unknown> | undefined;
}

const defaults: AwsImdsSettings = {
  attemptTimeout: Duration.seconds(1),
  endpoint: "http://169.254.169.254",
  retrySchedule: retryPolicy(2),
  tokenTtl: Duration.hours(6),
};

const resolve = (options: AwsImdsOptions): AwsImdsSettings => ({
  attemptTimeout: Duration.fromInputUnsafe(
    options.attemptTimeout ?? defaults.attemptTimeout
  ),
  endpoint: options.endpoint ?? defaults.endpoint,
  retrySchedule: options.retrySchedule ?? defaults.retrySchedule,
  tokenTtl: Duration.fromInputUnsafe(options.tokenTtl ?? defaults.tokenTtl),
});

/**
 * Settings for the IMDS layers, with defaults when nothing provides them.
 *
 * Provide an override to the layers with `Layer.provide`; merging it beside
 * them has no effect on how they are built.
 *
 * @since 0.1.0
 */
class AwsImdsConfig extends Context.Reference<AwsImdsSettings>(
  "@rc312/effect-aws-imds/AwsImdsConfig",
  { defaultValue: () => defaults }
) {
  /** Overrides the given settings and keeps defaults for the rest. */
  static readonly layer = (options: AwsImdsOptions) =>
    Layer.sync(AwsImdsConfig, () => resolve(options));

  /** Reads settings from `Config`, field by field or as one `Config`. */
  static readonly layerConfig = (config: Config.Wrap<AwsImdsOptions>) =>
    Layer.effect(AwsImdsConfig, Effect.map(Config.unwrap(config), resolve));
}

export { AwsImdsConfig, retryPolicy };

export type { AwsImdsOptions, AwsImdsSettings };
