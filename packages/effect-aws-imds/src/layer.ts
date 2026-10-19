import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";

import { AwsImds } from "./aws-imds.ts";
import { InstanceIdentity } from "./instance-identity.ts";
import { AwsImdsToken } from "./token.ts";

/**
 * Provides `InstanceIdentity`, `AwsImds`, and `AwsImdsToken` from the
 * `HttpClient` in the environment. Settings come from `AwsImdsConfig`.
 *
 * @since 0.1.0
 */
const layer = InstanceIdentity.layer.pipe(
  Layer.provideMerge(AwsImds.layer),
  Layer.provideMerge(AwsImdsToken.layer)
);

/**
 * `layer` backed by the platform `fetch` through `FetchHttpClient`.
 *
 * @since 0.1.0
 */
const layerFetch = layer.pipe(Layer.provide(FetchHttpClient.layer));

/**
 * Discards the cached session token and identity document.
 *
 * @since 0.1.0
 */
const clearCache = Effect.andThen(
  AwsImdsToken.use((token) => token.clear),
  InstanceIdentity.use((identity) => identity.invalidate)
);

export { clearCache, layer, layerFetch };
