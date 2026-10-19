import { Cache, Context, Duration, Effect, Layer, Schema } from "effect";

import { AwsImds, decodeAt } from "./aws-imds.ts";
import type { AwsImdsError } from "./aws-imds.ts";
import { IdentityDocument } from "./identity-document.ts";
import { cacheOnSuccess } from "./internal.ts";

const IDENTITY_DOCUMENT_PATH = "/latest/dynamic/instance-identity/document";

const decodeDocument = decodeAt(
  IDENTITY_DOCUMENT_PATH,
  Schema.fromJsonString(IdentityDocument)
);

/**
 * The decoded instance identity document, memoized after the first success.
 * Failures are not cached. Provide a fixed document with `Layer.succeed` to
 * test code that depends on it without any HTTP.
 *
 * @since 0.1.0
 */
class InstanceIdentity extends Context.Service<
  InstanceIdentity,
  {
    readonly document: Effect.Effect<IdentityDocument, AwsImdsError>;
    readonly invalidate: Effect.Effect<void>;
  }
>()("@rc312/effect-aws-imds/InstanceIdentity") {
  /** Reads the document through `AwsImds`. */
  static readonly layer: Layer.Layer<InstanceIdentity, never, AwsImds> =
    Layer.effect(
      InstanceIdentity,
      Effect.gen(function* make() {
        const imds = yield* AwsImds;

        const resolve = imds
          .get(IDENTITY_DOCUMENT_PATH)
          .pipe(
            Effect.flatMap(decodeDocument),
            Effect.withSpan("InstanceIdentity.resolve")
          );

        const documents = yield* Cache.makeWith(() => resolve, {
          capacity: 1,
          timeToLive: cacheOnSuccess(Duration.infinity),
        });

        return InstanceIdentity.of({
          document: Cache.get(documents, IDENTITY_DOCUMENT_PATH),
          invalidate: Cache.invalidate(documents, IDENTITY_DOCUMENT_PATH),
        });
      })
    );
}

/**
 * The memoized, decoded instance identity document.
 *
 * @since 0.1.0
 */
const identityDocument = InstanceIdentity.use((identity) => identity.document);

export { identityDocument, InstanceIdentity };
