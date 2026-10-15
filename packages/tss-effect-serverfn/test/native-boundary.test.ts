import { describe, it } from "@effect/vitest";
import { createMiddleware } from "@tanstack/react-start";
import { notFound, redirect } from "@tanstack/router-core";
import {
  Cause,
  Context,
  Deferred,
  Effect,
  ErrorReporter,
  Exit,
  Layer,
  ManagedRuntime,
  Option,
  Schema,
  SchemaTransformation,
  Tracer,
} from "effect";
import { HttpServerRequest } from "effect/http";
import { TestClock } from "effect/testing";
import { expect } from "vitest";

import { createEffectMiddleware } from "../src/effect-middleware.ts";
import type { FailureReport } from "../src/effect-middleware.ts";
import { executionKey } from "../src/execution.ts";
import {
  acceptServerFnErrorEvent,
  getServerFnFailureCause,
  getServerFnFailureDisposition,
} from "../src/provenance.server.ts";
import { fallback, runProgram } from "./effect-fixture.ts";
import { execute, leaf } from "./tanstack-start-fixture.ts";

// oxlint-disable-next-line unicorn/throw-new-error -- Effect's TaggedError is a class factory, not an Error constructor.
class Missing extends Schema.TaggedError<
  Missing,
  { readonly brand: unique symbol }
>()("Missing", { message: Schema.String }) {}

describe("native execution boundary", () => {
  it("encodes native tagged errors and keeps their Cause server-local", async () => {
    const runtime = ManagedRuntime.make(Layer.empty);
    const original = new Missing({ message: "Not found" });

    try {
      const first = await runProgram(runtime, Effect.fail(original), {
        publicError: Missing,
      });

      const second = await runProgram(runtime, Effect.fail(original), {
        publicError: Missing,
      });

      expect(first.error).toEqual(Schema.encodeSync(Missing)(original));
      expect(second.error).not.toBe(first.error);
      expect(
        Cause.findErrorOption(
          getServerFnFailureCause(first.error) ?? Cause.empty
        )
      ).toEqual(Option.some(original));
      expect(getServerFnFailureDisposition(first.error)).toEqual({
        capture: true,
        handled: false,
      });
      expect(acceptServerFnErrorEvent(first.error)).toBe(true);
      expect(acceptServerFnErrorEvent(first.error)).toBe(false);
      expect(acceptServerFnErrorEvent(second.error)).toBe(true);
    } finally {
      await runtime.dispose();
    }
  });

  it("never publishes arbitrary tags, defects, or competing Causes", async () => {
    const runtime = ManagedRuntime.make(Layer.empty);
    const original = new Missing({ message: "private" });

    const causes = [
      Cause.die(original),
      Cause.combine(Cause.fail(original), Cause.die("private")),
      Cause.combine(Cause.fail(original), Cause.interrupt()),
    ];

    try {
      const unapproved = await runProgram(runtime, Effect.fail(original));
      expect(unapproved.error).toEqual(fallback);

      await Promise.all(
        causes.map(async (cause) => {
          const result = await runProgram(runtime, Effect.failCause(cause), {
            publicError: Missing,
          });

          expect(result.error).toEqual(fallback);
          const observed = getServerFnFailureCause(result.error) ?? Cause.empty;
          expect(observed.reasons).toHaveLength(cause.reasons.length);
          expect(Cause.findErrorOption(observed)).toEqual(
            Cause.findErrorOption(cause)
          );
          expect(Cause.hasDies(observed)).toBe(Cause.hasDies(cause));
          expect(Cause.hasInterrupts(observed)).toBe(
            Cause.hasInterrupts(cause)
          );
        })
      );
    } finally {
      await runtime.dispose();
    }
  });

  it("does not expose runtime acquisition failures through the business codec", async () => {
    const original = new Missing({ message: "private layer acquisition" });

    const runtime = ManagedRuntime.make(
      Layer.effectDiscard(Effect.fail(original))
    );

    try {
      const result = await runProgram(runtime, Effect.succeed(42), {
        publicError: Missing,
      });

      expect(result.error).toEqual(fallback);
      expect(getServerFnFailureCause(result.error)).toEqual(
        Cause.fail(original)
      );
    } finally {
      await runtime.dispose();
    }
  });

  it.each([false, true])(
    "encodes with application services after cleanup (fault=%s)",
    async (fault) => {
      const Messages = Context.Service<"messages", string>("messages");
      const runtime = ManagedRuntime.make(Layer.succeed(Messages, "Approved"));
      const original = new Missing({ message: "private source" });
      const reports: FailureReport[] = [];
      let closed = false;

      const codec = Schema.Struct({
        code: Schema.String,
        message: Schema.String,
      }).pipe(
        Schema.decodeTo(
          Missing,
          SchemaTransformation.transformEffect({
            decode: (encoded: {
              readonly code: string;
              readonly message: string;
            }) =>
              Effect.succeed(
                Schema.encodeSync(Missing)(
                  new Missing({ message: encoded.message })
                )
              ),
            encode: () =>
              Effect.gen(function* encodePublic() {
                expect(closed).toBe(true);

                if (fault) {
                  return yield* Effect.die("private encoding failure");
                }

                const message = yield* Messages;

                return { code: "MISSING", message };
              }),
          })
        )
      );

      const program = Effect.gen(function* businessFailure() {
        yield* Effect.acquireRelease(Effect.void, () =>
          Effect.sync(() => {
            closed = true;
          })
        );

        return yield* original;
      });

      try {
        const output = await runProgram(runtime, program, {
          publicError: codec,
          reportFailure: (report) =>
            Effect.sync(() => {
              reports.push(report);
            }),
        });

        expect(output.error).toEqual(
          fault ? fallback : { code: "MISSING", message: "Approved" }
        );
        expect(
          Cause.findErrorOption(
            getServerFnFailureCause(output.error) ?? Cause.empty
          )
        ).toEqual(Option.some(original));
        expect(reports).toHaveLength(1);
        expect(Cause.hasDies(reports[0]?.processingCause ?? Cause.empty)).toBe(
          fault
        );
      } finally {
        await runtime.dispose();
      }
    }
  );

  it.each([
    new Response("Denied", { status: 403 }),
    redirect({ href: "/login" }),
    notFound(),
  ])("preserves native typed control flow", async (flow) => {
    const reports: FailureReport[] = [];
    const runtime = ManagedRuntime.make(Layer.empty);

    try {
      const result = await runProgram(runtime, Effect.fail(flow), {
        reportFailure: (report) =>
          Effect.sync(() => {
            reports.push(report);
          }),
      });

      expect(result.error).toBe(flow);
      expect(reports).toEqual([]);
      const defect = await runProgram(runtime, Effect.die(flow));
      expect(defect.error).toEqual(fallback);
    } finally {
      await runtime.dispose();
    }
  });

  it.each(["execution", "preparation"])(
    "guards hostile %s failures without losing diagnostics",
    async (phase) => {
      const fault = {
        get isNotFound(): boolean {
          throw new Error("private getter");
        },
      };

      const runtime = ManagedRuntime.make(Layer.empty);

      try {
        const boundary = createEffectMiddleware({
          fallbackFailure: fallback,
          resolve: () => ({ runPromiseExit: runtime.runPromiseExit }),
        });

        const result =
          phase === "execution"
            ? await runProgram(runtime, Effect.fail(fault))
            : await execute([
                boundary,
                createMiddleware({ type: "function" }).server(() => {
                  throw fault;
                }),
              ]);

        expect(result.error).toEqual(fallback);
        const reason = getServerFnFailureCause(result.error)?.reasons[0];
        expect(
          reason && Cause.isFailReason(reason) ? reason.error : undefined
        ).toBe(fault);
      } finally {
        await runtime.dispose();
      }
    }
  );

  it("does not acquire a runtime for native preparation failure or replacement output", async () => {
    let resolves = 0;
    const runtime = ManagedRuntime.make(Layer.empty);

    const boundary = createEffectMiddleware({
      fallbackFailure: fallback,
      resolve: () => {
        resolves += 1;

        return { runPromiseExit: runtime.runPromiseExit };
      },
    });

    try {
      const invalid = await execute([
        boundary,
        createMiddleware({ type: "function" }).server(() => {
          throw new Error("native validation");
        }),
      ]);

      expect(invalid.error).toEqual(fallback);
      const replacement = await execute([boundary, leaf("replacement")]);
      expect(replacement.result).toBe("replacement");
      expect(resolves).toBe(0);
    } finally {
      await runtime.dispose();
    }
  });

  it.each(["configuration", "runner", "middleware"])(
    "allows native control flow only from middleware, not %s faults",
    async (stage) => {
      const controlFlow = redirect({ href: "/private" });
      const runtime = ManagedRuntime.make(Layer.empty);
      let executed = false;

      const boundary = createEffectMiddleware({
        fallbackFailure: fallback,
        resolve: () => {
          if (stage === "configuration") {
            throw controlFlow;
          }

          return {
            runPromiseExit:
              stage === "runner"
                ? (): Promise<never> => Promise.reject(controlFlow)
                : runtime.runPromiseExit,
          };
        },
      });

      const handler = createMiddleware({ type: "function" })
        .middleware([boundary])
        .server(async ({ context, next }) => {
          if (stage === "middleware") {
            throw controlFlow;
          }

          const result = await context[executionKey].run(
            Effect.sync(() => {
              executed = true;

              return "executed";
            })
          );

          return { ...(await next()), result };
        });

      try {
        const output = await execute([handler]);
        expect(executed).toBe(false);

        if (stage === "middleware") {
          expect(output.error).toBe(controlFlow);
        } else {
          expect(output.error).toEqual(fallback);
          const cause = getServerFnFailureCause(output.error) ?? Cause.empty;
          expect(Cause.squash(cause)).toBe(controlFlow);
          expect(Cause.hasDies(cause)).toBe(stage === "runner");
        }
      } finally {
        await runtime.dispose();
      }
    }
  );

  it("rejects conflicting owners and missing lowering before executing business work", async () => {
    let executed = false;
    const runtime = ManagedRuntime.make(Layer.empty);

    const make = () =>
      createEffectMiddleware({
        fallbackFailure: fallback,
        resolve: () => ({ runPromiseExit: runtime.runPromiseExit }),
      });

    try {
      const conflict = await execute([
        make(),
        make(),
        leaf(
          Effect.sync(() => {
            executed = true;
          })
        ),
      ]);

      expect(conflict.error).toEqual(fallback);

      const missing = await execute([
        make(),
        leaf(
          Effect.sync(() => {
            executed = true;
          })
        ),
      ]);

      expect(missing.error).toEqual(fallback);
      expect(
        Cause.pretty(getServerFnFailureCause(missing.error) ?? Cause.empty)
      ).toContain("effectServerFns");
      expect(executed).toBe(false);
    } finally {
      await runtime.dispose();
    }
  });

  it("provides isolated native HTTP request services", async () => {
    const runtime = ManagedRuntime.make(Layer.empty);

    const program = HttpServerRequest.HttpServerRequest.pipe(
      Effect.map((request) => request.headers["x-request-id"])
    );

    try {
      const result = await Promise.all(
        ["first", "second"].map((id) =>
          runProgram(
            runtime,
            program,
            {},
            new Request("http://localhost", { headers: { "x-request-id": id } })
          )
        )
      );

      expect(result.map((output) => output.result)).toEqual([
        "first",
        "second",
      ]);
    } finally {
      await runtime.dispose();
    }
  });

  it("shares runtime acquisition when one waiting request aborts", async () => {
    const ready = Promise.withResolvers<boolean>();
    const release = Promise.withResolvers<boolean>();
    const Service = Context.Service<"initialization", number>("initialization");
    let acquired = 0;
    let disposed = 0;

    const runtime = ManagedRuntime.make(
      Layer.effect(
        Service,
        Effect.acquireRelease(
          Effect.gen(function* initialize() {
            acquired += 1;
            ready.resolve(true);
            yield* Effect.tryPromise(() => release.promise);

            return 42;
          }),
          () =>
            Effect.sync(() => {
              disposed += 1;
            })
        )
      )
    );

    const controller = new AbortController();

    const first = runProgram(
      runtime,
      Service,
      {},
      new Request("http://localhost", { signal: controller.signal })
    );

    try {
      await ready.promise;
      const second = runProgram(runtime, Service);
      controller.abort();
      release.resolve(true);
      const [cancelled, success] = await Promise.all([first, second]);
      expect(success.result).toBe(42);
      expect(
        Cause.hasInterruptsOnly(
          getServerFnFailureCause(cancelled.error) ?? Cause.empty
        )
      ).toBe(true);
      expect(acquired).toBe(1);
      expect(disposed).toBe(0);
    } finally {
      release.resolve(true);
      await runtime.dispose();
    }

    expect(disposed).toBe(1);
  });

  it("does not execute already aborted requests", async () => {
    const runtime = ManagedRuntime.make(Layer.empty);
    let ran = false;

    try {
      const result = await runProgram(
        runtime,
        Effect.sync(() => {
          ran = true;
        }),
        {},
        new Request("http://localhost", { signal: AbortSignal.abort() })
      );

      expect(ran).toBe(false);
      expect(
        Cause.hasInterruptsOnly(
          getServerFnFailureCause(result.error) ?? Cause.empty
        )
      ).toBe(true);
    } finally {
      await runtime.dispose();
    }
  });

  it("interrupts foreign work and awaits scoped finalization", async () => {
    const runtime = ManagedRuntime.make(Layer.empty);
    const controller = new AbortController();
    const entered = Promise.withResolvers<AbortSignal>();
    const finalizing = Promise.withResolvers<boolean>();
    const release = await runtime.runPromise(Deferred.make<boolean>());
    let settled = false;

    const program = Effect.gen(function* program() {
      yield* Effect.acquireRelease(Effect.void, () =>
        Effect.sync(() => finalizing.resolve(true)).pipe(
          Effect.andThen(Deferred.await(release))
        )
      );

      return yield* Effect.tryPromise((signal) => {
        entered.resolve(signal);

        return Promise.withResolvers<never>().promise;
      });
    });

    const pending = (async () => {
      const result = await runProgram(
        runtime,
        program,
        {},
        new Request("http://localhost", { signal: controller.signal })
      );

      settled = true;

      return result;
    })();

    try {
      const signal = await entered.promise;
      controller.abort();
      await finalizing.promise;
      expect(signal.aborted).toBe(true);
      expect(settled).toBe(false);
      await runtime.runPromise(Deferred.succeed(release, true));
      const output = await pending;
      expect(
        Cause.hasInterruptsOnly(
          getServerFnFailureCause(output.error) ?? Cause.empty
        )
      ).toBe(true);
    } finally {
      controller.abort();
      await runtime.runPromise(Deferred.succeed(release, true));
      await pending;
      await runtime.dispose();
    }
  });

  it("keeps finalizer defects in the terminal Cause", async () => {
    const runtime = ManagedRuntime.make(Layer.empty);
    const original = new Missing({ message: "Not found" });

    const program = Effect.gen(function* program() {
      yield* Effect.acquireRelease(Effect.void, () =>
        Effect.die("private cleanup")
      );

      return yield* original;
    });

    try {
      const output = await runProgram(runtime, program, {
        publicError: Missing,
      });

      expect(output.error).toEqual(fallback);
      expect(
        Cause.hasDies(getServerFnFailureCause(output.error) ?? Cause.empty)
      ).toBe(true);
    } finally {
      await runtime.dispose();
    }
  });

  it("uses native reporter layers and object-wide ignore semantics", async () => {
    const reports: Cause.Cause<unknown>[] = [];

    const reporter = ErrorReporter.make(({ cause }) => {
      reports.push(cause);
    });

    const runtime = ManagedRuntime.make(ErrorReporter.layer([reporter]));
    const original = new Missing({ message: "Not found" });

    try {
      await runProgram(
        runtime,
        Effect.fail(original).pipe(Effect.withErrorReporting),
        { publicError: Missing }
      );
      expect(reports).toHaveLength(1);

      const ignored = await runProgram(
        runtime,
        Effect.fail(
          Object.assign(new Missing({ message: "Expected" }), {
            [ErrorReporter.ignore]: true,
          })
        ),
        { publicError: Missing }
      );

      expect(reports).toHaveLength(1);
      expect(getServerFnFailureDisposition(ignored.error)).toEqual({
        capture: false,
        handled: true,
      });
      expect(acceptServerFnErrorEvent(new Error("unrelated"))).toBe(true);
    } finally {
      await runtime.dispose();
    }
  });

  it("runs awaited reporting with application services after cleanup", async () => {
    const Reporter = Context.Service<
      "test/Reporter",
      { readonly record: () => void }
    >("test/Reporter");

    const events: string[] = [];

    const runtime = ManagedRuntime.make(
      Layer.succeed(
        Reporter,
        Reporter.of({
          record: () => {
            events.push("report");
          },
        })
      )
    );

    const program = Effect.gen(function* program() {
      yield* Effect.acquireRelease(Effect.void, () =>
        Effect.sync(() => {
          events.push("cleanup");
        })
      );

      return yield* Effect.die("private");
    });

    try {
      const output = await runProgram(runtime, program, {
        reportFailure: () =>
          Effect.gen(function* reportFailure() {
            const reporter = yield* Reporter;
            reporter.record();
          }),
      });

      expect(output.error).toEqual(fallback);
      expect(events).toEqual(["cleanup", "report"]);
      expect(getServerFnFailureDisposition(output.error)).toEqual({
        capture: true,
        handled: true,
      });
    } finally {
      await runtime.dispose();
    }
  });

  it("lets an explicit reporter override own failures ignored by native reporters", async () => {
    const reports: FailureReport[] = [];
    const runtime = ManagedRuntime.make(Layer.empty);

    const original = Object.assign(new Missing({ message: "Expected" }), {
      [ErrorReporter.ignore]: true,
    });

    try {
      const output = await runProgram(runtime, Effect.fail(original), {
        publicError: Missing,
        reportFailure: (report) =>
          Effect.sync(() => {
            reports.push(report);
          }),
      });

      expect(output.error).toEqual(Schema.encodeSync(Missing)(original));
      expect(reports).toHaveLength(1);
      expect(getServerFnFailureDisposition(output.error)).toEqual({
        capture: true,
        handled: true,
      });
      expect(acceptServerFnErrorEvent(output.error)).toBe(true);
      expect(acceptServerFnErrorEvent(output.error)).toBe(false);
    } finally {
      await runtime.dispose();
    }
  });

  it.each(["throw", "die"])("contains %s reporting faults", async (kind) => {
    const runtime = ManagedRuntime.make(Layer.empty);

    try {
      const output = await runProgram(runtime, Effect.die("business"), {
        reportFailure: () => {
          if (kind === "throw") {
            throw new Error("reporter");
          }

          return Effect.die("reporter");
        },
      });

      expect(output.error).toEqual(fallback);
      const reason = getServerFnFailureCause(output.error)?.reasons[0];
      expect(
        reason && Cause.isDieReason(reason) ? reason.defect : undefined
      ).toBe("business");
      expect(getServerFnFailureDisposition(output.error)).toEqual({
        capture: true,
        handled: false,
      });
    } finally {
      await runtime.dispose();
    }
  });

  it("ends the native operation span with the original failure", async () => {
    const spans: Tracer.NativeSpan[] = [];

    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);

        return span;
      },
    });

    const runtime = ManagedRuntime.make(Layer.succeed(Tracer.Tracer, tracer));
    const original = new Missing({ message: "Not found" });

    try {
      await runProgram(runtime, Effect.fail(original), {
        publicError: Missing,
      });
      expect(spans).toHaveLength(1);
      const status = spans[0]?.status;

      if (!status || !("exit" in status) || !Exit.isFailure(status.exit)) {
        throw new Error("Operation span did not end with a failure");
      }

      expect(Cause.findErrorOption(status.exit.cause)).toEqual(
        Option.some(original)
      );
    } finally {
      await runtime.dispose();
    }
  });

  it("bounds awaited reporting with application virtual time and aborts foreign work", async () => {
    const runtime = ManagedRuntime.make(TestClock.layer());
    const entered = Promise.withResolvers<AbortSignal>();

    const pending = runProgram(runtime, Effect.die("business"), {
      reportFailure: () =>
        Effect.tryPromise((signal) => {
          entered.resolve(signal);

          return Promise.withResolvers<never>().promise;
        }),
    });

    try {
      const signal = await entered.promise;
      expect(signal.aborted).toBe(false);
      await runtime.runPromise(TestClock.adjust("5 seconds"));
      const output = await pending;
      expect(output.error).toEqual(fallback);
      expect(signal.aborted).toBe(true);
      expect(getServerFnFailureDisposition(output.error)).toEqual({
        capture: true,
        handled: false,
      });
    } finally {
      await runtime.dispose();
    }
  });
});
