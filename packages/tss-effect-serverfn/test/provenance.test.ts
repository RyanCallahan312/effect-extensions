import { describe, it } from "@effect/vitest";
import { Cause } from "effect";
import { expect } from "vitest";

import { bootstrapFailure } from "../src/bootstrap.server.ts";
import {
  acceptServerFnErrorEvent,
  getServerFnFailureCause,
  getServerFnFailureDisposition,
  ownFailure,
} from "../src/provenance.server.ts";

describe("failure provenance", () => {
  it("sanitizes bootstrap faults even outside request scope", () => {
    const fallback = { code: "INTERNAL" };

    const failure = bootstrapFailure(
      fallback,
      new Error("private loader failure")
    );

    expect(failure).toStrictEqual(fallback);
    expect(failure).not.toBe(fallback);
    expect(getServerFnFailureDisposition(failure)).toStrictEqual({
      capture: true,
      handled: false,
    });
    expect(acceptServerFnErrorEvent(failure)).toBe(true);
    expect(acceptServerFnErrorEvent(failure)).toBe(false);
    expect(getServerFnFailureCause(failure)).toEqual(
      expect.objectContaining({
        reasons: expect.arrayContaining([
          expect.objectContaining({ error: expect.any(Error) }),
        ]),
      })
    );
  });

  it("suppresses expected failures while preserving independent event identities", () => {
    const suppressed = ownFailure({ code: "EXPECTED" }, "suppress");

    const reported = ownFailure(
      { code: "UNEXPECTED" },
      "boundary",
      Cause.die("private")
    );

    expect(getServerFnFailureDisposition(suppressed)).toStrictEqual({
      capture: false,
      handled: true,
    });
    expect(acceptServerFnErrorEvent(suppressed)).toBe(false);
    expect(acceptServerFnErrorEvent(reported)).toBe(true);
    expect(acceptServerFnErrorEvent(reported)).toBe(false);
    expect(acceptServerFnErrorEvent(new Error("unrelated"))).toBe(true);
    expect(getServerFnFailureDisposition("primitive")).toBeUndefined();
  });
});
