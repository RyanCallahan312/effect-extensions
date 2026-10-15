import { Cause } from "effect";

import { ownFailure } from "./provenance.server.ts";

/**
 * Create a safe rejection when the lazy execution boundary cannot be loaded.
 * This eager path depends only on the provenance registry and never initializes
 * application services or invokes an application reporter.
 *
 * @param template - Trusted fallback available before loading application code.
 * @param cause - Original module-loading rejection, retained only on the server.
 * @returns A fresh fallback record eligible for native framework reporting.
 * @internal
 */
export const bootstrapFailure = <P extends object>(
  template: Readonly<P>,
  cause: unknown
): P => {
  const failure = { ...template };

  return ownFailure(failure, "native", Cause.fail(cause));
};
