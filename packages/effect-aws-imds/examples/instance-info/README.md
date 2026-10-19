# instance-info example

A small CLI that consumes `@rc312/effect-aws-imds` through its built package exports and prints the current EC2 instance as JSON. It ships with a strict mock IMDS so you can run it, and its end-to-end tests, anywhere.

## Run it by hand

From the repository root:

```sh
bun install
bun run build
```

In one terminal, start the mock (`healthy`, `flaky`, `expire-tokens`, `hang`, or `malformed`):

```sh
MOCK_IMDS_SCENARIO=healthy bun run --cwd packages/effect-aws-imds/examples/instance-info mock
```

In another, point the CLI at it:

```sh
AWS_EC2_METADATA_SERVICE_ENDPOINT=http://127.0.0.1:1338 \
  bun run --cwd packages/effect-aws-imds/examples/instance-info start
```

On a real EC2 instance, omit `AWS_EC2_METADATA_SERVICE_ENDPOINT` to use the default `http://169.254.169.254`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `AWS_EC2_METADATA_SERVICE_ENDPOINT` | `http://169.254.169.254` | IMDS base URL |
| `IMDS_ATTEMPT_TIMEOUT` | `1 second` | Timeout for each HTTP attempt, as an Effect duration such as `200 millis` |
| `IMDS_RETRIES` | `2` | Retries for transient failures, passed to `AwsImds.retryPolicy` |
| `MOCK_IMDS_PORT` | `1338` | Port for `bun run mock` |
| `MOCK_IMDS_SCENARIO` | `healthy` | Behavior for `bun run mock` |

Failures, including invalid configuration, go to stderr as `{ "error": "config" | "token" | "metadata", "message", "path"?, "status"? }` with exit code 1.

## What the source shows

- [`src/main.ts`](src/main.ts) provides `AwsImdsConfig.layerConfig` to `AwsImds.layerFetch` with `Layer.provide`, building the retry `Schedule` from `IMDS_RETRIES` with `Config.map(AwsImds.retryPolicy)`. It reads the identity document and four metadata paths concurrently, turns a `404` on `spot/instance-action` into `null` with the `AwsImds.optional` combinator, and maps typed failures with `Effect.catchTags` at the program edge.
- [`src/mock-imds.ts`](src/mock-imds.ts) enforces IMDSv2: tokens only from `PUT /latest/api/token` with a TTL of 1–21600 seconds (`400` otherwise), `403` for `X-Forwarded-For`, `401` for missing, unknown, or expired tokens, and `404` for unknown paths.

## End-to-end tests

```sh
bun run --cwd packages/effect-aws-imds/examples/instance-info test
```

They also run as part of `bun run check`. Each test starts a mock IMDS on a free port and runs the built CLI as a separate Node process with a hard timeout.

| Scenario | Proves |
| --- | --- |
| `healthy` | One token `PUT` with the TTL header, every read carries that token, concurrent reads share it, and a `404` path becomes `null`. |
| `flaky` | A `503` token response and a `429` read are retried transparently. |
| `expire-tokens` | A `401` read triggers a token refresh and the read succeeds. |
| `malformed` | An invalid identity document fails with exit code 1 and the document path. |
| `hang` | Per-attempt timeouts and the retry bound end the process in seconds (two `PUT`s with `IMDS_RETRIES=1`). |
| No listener | A refused connection fails with a typed token error and no `status`. |

Two further tests check that the mock itself rejects unauthenticated reads and invalid token requests, so a passing client test cannot come from a lenient mock.
