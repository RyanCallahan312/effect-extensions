# @rc312/effect-aws-imds

An **Effect-native client for the AWS EC2 Instance Metadata Service** (IMDSv2). It has no runtime dependencies besides its `effect` peer.

```sh
bun add @rc312/effect-aws-imds 'effect@^4.0.5'
```

## Usage

```ts
import * as AwsImds from "@rc312/effect-aws-imds";
import { Effect } from "effect";

const program = Effect.gen(function* () {
  // Yield the Effect to obtain the decoded, memoized document.
  const document = yield* AwsImds.identityDocument;
  // document.instanceType is already available without another request.
  // This extra request demonstrates uncached reads with get(path).
  const instanceType = yield* AwsImds.get("/latest/meta-data/instance-type");

  return {
    accountId: document.accountId,
    region: document.region,
    instanceType,
  };
});

Effect.runPromise(program.pipe(Effect.provide(AwsImds.layerFetch)));
```

`layerFetch` uses the platform `fetch`. Use `AwsImds.layer` instead to supply your own `HttpClient`, such as a Node or Bun platform client or a test double. Both are plain `Layer` values. Build one into your runtime (for example a single `ManagedRuntime` or one composed application layer) so the whole program shares one token cache and one identity document cache; each separate `Effect.provide` builds its own.

## Composition

The package is a small graph of services, each with its own layer:

| Service | Provides | `layer` requires |
| --- | --- | --- |
| `AwsImdsConfig` | Settings (a `Context.Reference` with defaults) | — |
| `AwsImdsToken` | `get`, `invalidate(token)`, and `clear` for IMDSv2 session tokens | `HttpClient` |
| `AwsImds` | `get(path)`: uncached metadata reads with session auth | `HttpClient`, `AwsImdsToken` |
| `InstanceIdentity` | `document` (memoized) and `invalidate` | `AwsImds` |

The top-level `layer` (`AwsImds.layer` with a namespace import) composes the `AwsImdsToken`, `AwsImds`, and `InstanceIdentity` layers with `Layer.provideMerge`, so all three stay available to your program. Those layers read `AwsImdsConfig` while they are built. Each service also has its own `layer` static, such as `AwsImds.AwsImds.layer`, for building a different graph. Replace any one of them to change one concern:

```ts
import * as AwsImds from "@rc312/effect-aws-imds";
import { Effect, Layer, Redacted } from "effect";

// A fixed session token, for example one issued elsewhere.
const StaticToken = Layer.succeed(
  AwsImds.AwsImdsToken,
  AwsImds.AwsImdsToken.of({
    clear: Effect.void,
    get: Effect.succeed(Redacted.make("token-issued-elsewhere")),
    invalidate: () => Effect.void,
  })
);

const Reads = AwsImds.AwsImds.layer.pipe(Layer.provide(StaticToken));
```

### Client combinators

The HTTP policy is exposed as two `HttpClient` combinators, so you can build your own client around them:

- `imdsTransport(settings)` applies the endpoint, buffers successful text bodies within the per-attempt timeout, treats non-2xx statuses as errors, and applies `retrySchedule`, including retries for interrupted body downloads.
- `withSessionToken(token)` resolves a session token from an `AwsImdsToken` before each request, outside that request's timeout and retries, and refreshes it once after a `401`. Apply it after `imdsTransport`.

```ts
import * as AwsImds from "@rc312/effect-aws-imds";
import { Effect } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

// An IMDS client that also tags every request with a trace id.
const tracedImdsClient = (traceId: string) =>
  Effect.gen(function* () {
    const settings = yield* AwsImds.AwsImdsConfig;
    const token = yield* AwsImds.AwsImdsToken;

    return (yield* HttpClient.HttpClient).pipe(
      AwsImds.imdsTransport(settings),
      HttpClient.mapRequest(HttpClientRequest.setHeader("x-trace", traceId)),
      AwsImds.withSessionToken(token)
    );
  });
```

Code that needs only the identity document can depend on `InstanceIdentity` and receive a fixed document from `Layer.succeed` in tests, with no HTTP at all.

### Settings

Provide settings with `Layer.provide`. A settings layer merged beside the IMDS layers is not used to build them, so they silently keep the defaults.

```ts
import * as AwsImds from "@rc312/effect-aws-imds";
import { Config, Layer } from "effect";

const ImdsLive = AwsImds.layerFetch.pipe(
  Layer.provide(
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
```

| Setting | Default | Notes |
| --- | --- | --- |
| `endpoint` | `http://169.254.169.254` | Use `http://[fd00:ec2::254]` on IPv6-only instances. |
| `tokenTtl` | `6 hours` | Clamped to 1 second through 6 hours. |
| `attemptTimeout` | `1 second` | Applies to each HTTP attempt, including reading its response body. Token requests run before a read, outside its timeout. |
| `retrySchedule` | `retryPolicy(2)` | A bounded `Schedule` (for example with `Schedule.upTo`), applied to timeouts, transport errors, and transient statuses (408, 429, 500, 502, 503, 504). It is the only bound on retries: an unbounded schedule retries forever when IMDS is unreachable. |

`AwsImdsConfig.layer(options)` takes the same fields as plain values.

## Reading metadata

| Export | Description |
| --- | --- |
| `get(path)` | The raw text at a path such as `/latest/meta-data/instance-id`. |
| `getSchema(path, codec)` | Reads `path` and decodes the text with `codec`, for example `Schema.fromJsonString(MySchema)`. Decode failures are `AwsImdsMetadataError`s for `path`. |
| `optional` | A combinator that maps a `404` to `Option.none()` and a success to `Option.some`, keeping every other failure: `get(path).pipe(AwsImds.optional)`. |
| `identityDocument` | The decoded instance identity document from `InstanceIdentity`. |
| `clearCache` | Discards the cached session token and identity document. |
| `retryPolicy(times)` | Jittered exponential backoff from 50 ms, bounded to `times` retries. Compose your own `Schedule` instead if you need a different policy. |
| `IdentityDocument` | Schema for the identity document. Unknown keys are ignored. |
| `AwsImdsTokenError` | Failure to obtain a session token, with a `message` and, for non-2xx responses, `status`. |
| `AwsImdsMetadataError` | Failure to read or decode a path, with `path`, a sanitized `message` and, for non-2xx responses, `status`. |

## Behavior

- **IMDSv2 only.** Session tokens come from `PUT /latest/api/token`, are cached until 30 seconds before they expire (or half their TTL, if that is later), and are refreshed once when a read returns `401`. When several concurrent reads are rejected with the same token, only one replacement is requested.
- **Retries.** Retries use jittered exponential backoff starting at 50 ms and honor `Retry-After`.
- **Caching.** Only successful results are cached. A failed lookup is retried the next time it is requested.
- **Outside EC2.** Operations fail with `AwsImdsTokenError` or `AwsImdsMetadataError` instead of returning `undefined`; use `Effect.option` if the value is optional. With the defaults, an endpoint that accepts connections but never answers fails after about 3.2 seconds (three 1-second attempts plus backoff); a refused connection fails within a fraction of a second. Lower `attemptTimeout` or use `retryPolicy(0)` to fail faster.

- **Token handling.** The session token is held as a `Redacted` value. `x-aws-ec2-metadata-token` is added to `Headers.CurrentRedactedNames` for metadata requests, so client spans that capture request headers record it as `<redacted>`. Neither error type keeps the underlying HTTP request or its headers.

## Example and end-to-end tests

[`examples/instance-info`](examples/instance-info) is a CLI that uses the built package against a strict mock IMDS. Its end-to-end tests run the CLI as a real process for the healthy, throttled, token-expiry, malformed-document, unresponsive, and unreachable cases. See its [README](examples/instance-info/README.md) to run it by hand.

## Development

```sh
bun run --cwd packages/effect-aws-imds build
bun run --cwd packages/effect-aws-imds typecheck
bun run --cwd packages/effect-aws-imds test
```

Unit tests use an in-memory `HttpClient`, `TestClock`, and a loopback server; they never contact a real metadata endpoint. The example's end-to-end tests run with `bun run --cwd packages/effect-aws-imds/examples/instance-info test`, and both suites run in `bun run check`.
