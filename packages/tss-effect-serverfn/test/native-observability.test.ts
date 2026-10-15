import { Effect, ErrorReporter, Layer, Logger, ManagedRuntime } from "effect";
import { expect, it } from "vitest";

import { fallback, runProgram } from "./effect-fixture.ts";

it("preserves native log annotations and error reporter attributes", async () => {
  const features: string[] = [];

  const logger = Logger.make((options) => {
    features.push(
      String(Logger.formatStructured.log(options).annotations.feature)
    );
  });

  let reports = 0;

  const reporter = ErrorReporter.make(({ attributes, severity }) => {
    reports += 1;
    expect(severity).toBe("Warn");
    expect(attributes).toEqual({ feature: "notes" });
  });

  const runtime = ManagedRuntime.make(
    Layer.merge(Logger.layer([logger]), ErrorReporter.layer([reporter]))
  );

  const error = Object.assign(new Error("private"), {
    [ErrorReporter.attributes]: { feature: "notes" },
    [ErrorReporter.severity]: "Warn",
  });

  try {
    const output = await runProgram(
      runtime,
      Effect.gen(function* rename() {
        yield* Effect.logInfo("renaming");

        return yield* Effect.fail(error);
      }).pipe(Effect.annotateLogs({ feature: "notes" }))
    );

    expect(output.error).toEqual(fallback);
    expect(features).toEqual(["notes"]);
    expect(reports).toBe(1);
  } finally {
    await runtime.dispose();
  }
});
