import { createMiddleware } from "@tanstack/react-start";
import {
  Cause,
  Context,
  Effect,
  Layer,
  ManagedRuntime,
  Schema,
  SchemaTransformation,
} from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";

import { effectHandler, prepareInput } from "../src/compiler-runtime.ts";
import { createEffectServerFn } from "../src/create-effect-server-fn.ts";
import { createEffectMiddleware } from "../src/effect-middleware.ts";
import type { ExecutionCapability } from "../src/execution.ts";
import { getServerFnFailureCause } from "../src/provenance.server.ts";
import { execute } from "./tanstack-start-fixture.ts";

class Notes extends Context.Service<
  Notes,
  { readonly rename: (id: string, title: string) => Effect.Effect<string> }
>()("test/Notes") {}

const NotesLive = Layer.succeed(
  Notes,
  Notes.of({ rename: (id, title) => Effect.succeed(`${id}:${title}`) })
);

const missing = () => createEffectServerFn().handler;

describe("native Effect endpoint", () => {
  it("infers the exact schema/Effect handler surface", async () => {
    const runtime = ManagedRuntime.make(NotesLive);

    const middleware = createEffectMiddleware({
      fallbackFailure: { code: "INTERNAL" },
      resolve: () => ({ runPromiseExit: runtime.runPromiseExit }),
    });

    const factory = createEffectServerFn().middleware([middleware]);

    // Native .handler is compiler-only at runtime; this closure is a compile-time fixture.
    const define = () =>
      factory({ method: "POST" })
        .validator(
          Schema.Struct({
            id: Schema.NonEmptyString,
            title: Schema.NonEmptyString,
          })
        )
        .handler(({ data }) =>
          Effect.gen(function* rename() {
            expectTypeOf(data).toEqualTypeOf<{
              readonly id: string;
              readonly title: string;
            }>();
            const notes = yield* Notes;

            return yield* notes.rename(data.id, data.title);
          }).pipe(Effect.annotateLogs({ action: "rename", feature: "notes" }))
        );

    expectTypeOf<ReturnType<ReturnType<typeof define>>>().toEqualTypeOf<
      Promise<string>
    >();

    const transformed = () =>
      factory()
        .validator(Schema.Struct({ count: Schema.FiniteFromString }))
        .handler(({ data }) => {
          expectTypeOf(data.count).toEqualTypeOf<number>();

          return Effect.succeed(data.count);
        });

    expectTypeOf<
      Parameters<ReturnType<typeof transformed>>[0]["data"]
    >().toEqualTypeOf<{ readonly count: string }>();

    expectTypeOf<ReturnType<typeof missing>>().toEqualTypeOf<never>();

    const empty = ManagedRuntime.make(Layer.empty);

    const emptyFactory = createEffectServerFn().middleware([
      createEffectMiddleware({
        fallbackFailure: { code: "INTERNAL" },
        resolve: () => ({ runPromiseExit: empty.runPromiseExit }),
      }),
    ]);

    const invalidService = () =>
      emptyFactory().handler(() =>
        // @ts-expect-error Notes is not provided by this runtime.
        // @effect-diagnostics-next-line missingEffectContext:off
        Notes.pipe(Effect.map(() => "value"))
      );

    const invalidOutput = () =>
      factory().handler(() =>
        // @ts-expect-error Functions cannot cross the native transport.
        Effect.succeed(() => "private")
      );

    const response = () =>
      factory().handler(() => Effect.succeed(new Response("ok")));

    expectTypeOf<ReturnType<ReturnType<typeof response>>>().toEqualTypeOf<
      Promise<Response>
    >();

    const scoped = () =>
      factory().handler(() =>
        Effect.gen(function* scopedWork() {
          yield* Effect.acquireRelease(
            Effect.succeed("resource"),
            () => Effect.void
          );
          yield* Effect.forkScoped(Effect.never);

          return "scoped";
        })
      );

    expectTypeOf<ReturnType<ReturnType<typeof scoped>>>().toEqualTypeOf<
      Promise<string>
    >();

    const unchecked = () =>
      factory({ strict: false }).handler(() => Effect.succeed(() => "local"));

    expectTypeOf<ReturnType<ReturnType<typeof unchecked>>>().toEqualTypeOf<
      Promise<() => "local">
    >();

    const auth = createMiddleware({ type: "function" }).server(({ next }) =>
      next({ context: { userId: "trusted" } })
    );

    const nested = createEffectServerFn().middleware([factory, auth]);

    const nestedHandler = () =>
      nested().handler(({ context }) => {
        expectTypeOf(context.userId).toEqualTypeOf<string>();

        return Effect.succeed(context.userId);
      });

    expectTypeOf<ReturnType<ReturnType<typeof nestedHandler>>>().toEqualTypeOf<
      Promise<string>
    >();

    const ServiceInput = Schema.String.pipe(
      Schema.decodeTo(
        Schema.String,
        SchemaTransformation.transformEffect({
          decode: (value: string) => Notes.pipe(Effect.map(() => value)),
          encode: (value: string) => Effect.succeed(value),
        })
      )
    );

    const missingDecoder = () => emptyFactory().validator(ServiceInput).handler;
    expectTypeOf<ReturnType<typeof missingDecoder>>().toEqualTypeOf<never>();

    const publicSchema = Schema.Struct({ message: Schema.String }).pipe(
      Schema.decodeTo(
        Schema.Struct({ message: Schema.String }),
        SchemaTransformation.transformEffect({
          decode: Effect.succeed,
          encode: (value: { readonly message: string }) =>
            Notes.pipe(Effect.as(value)),
        })
      )
    );

    const missingEncoder = () =>
      createEffectMiddleware({
        fallbackFailure: { code: "INTERNAL" },
        resolve: () => ({
          // @ts-expect-error Encoding requires Notes, which the runtime does not provide.
          publicError: publicSchema,
          runPromiseExit: empty.runPromiseExit,
        }),
      });

    const unsafeError = () =>
      createEffectMiddleware({
        fallbackFailure: { code: "INTERNAL" },
        resolve: () => ({
          // @ts-expect-error Function values are not serializable public failures.
          publicError: Schema.Struct({ callback: Schema.instanceOf(Function) }),
          runPromiseExit: empty.runPromiseExit,
        }),
      });

    expect([missingEncoder, unsafeError]).toHaveLength(2);

    const postForm = () =>
      factory({ method: "POST" })
        .validator(Schema.instanceOf(FormData))
        .handler(() => Effect.succeed("ok"));

    expectTypeOf<
      Parameters<ReturnType<typeof postForm>>[0]["data"]
    >().toEqualTypeOf<FormData>();

    const getForm = () =>
      factory({ method: "GET" })
        // @ts-expect-error FormData is a native POST-only input.
        .validator(Schema.instanceOf(FormData));

    expect([invalidService, invalidOutput, getForm]).toHaveLength(3);
    await empty.dispose();
    await runtime.dispose();
  });

  it("decodes and finalizes before native middleware unwinds", async () => {
    const runtime = ManagedRuntime.make(NotesLive);
    const events: string[] = [];

    const boundary = createEffectMiddleware({
      fallbackFailure: { code: "INTERNAL" },
      resolve: () => ({ runPromiseExit: runtime.runPromiseExit }),
    });

    const after = createMiddleware({ type: "function" }).server(
      async ({ next: continueMiddleware }) => {
        events.push("before");
        const output = await continueMiddleware();
        events.push("after");
        expect("data" in output && output.data).toEqual({ count: 42 });

        return output;
      }
    );

    const handler = effectHandler(
      ({ data }: { data: unknown; context: ExecutionCapability<Notes> }) =>
        Effect.gen(function* executeHandler() {
          yield* Effect.acquireRelease(
            Effect.sync(() => events.push("acquire")),
            () =>
              Effect.sync(() => {
                events.push("release");
              })
          );
          events.push("business");

          return data;
        })
    );

    const leaf = createMiddleware({ type: "function" })
      .middleware([boundary])
      .validator(
        prepareInput(Schema.Struct({ count: Schema.FiniteFromString }))
      )
      .server(async (context) => {
        const result = await handler(context);

        return { ...(await context.next()), data: context.data, result };
      });

    try {
      const result = await execute([boundary, after, leaf], undefined, {
        count: "42",
      });

      expect(result.error).toBeUndefined();
      expect(result.result).toEqual({ count: 42 });
      expect(events).toEqual([
        "before",
        "acquire",
        "business",
        "release",
        "after",
      ]);
    } finally {
      await runtime.dispose();
    }
  });

  it.each(["service", "defect", "interrupt"])(
    "decodes %s input inside the application runtime",
    async (kind) => {
      const runtime = ManagedRuntime.make(NotesLive);
      let calls = 0;

      const schema = Schema.String.pipe(
        Schema.decodeTo(
          Schema.String,
          SchemaTransformation.transformEffect({
            decode: (value: string) =>
              Effect.gen(function* decode() {
                yield* Effect.yieldNow;

                if (kind === "defect") {
                  return yield* Effect.die("private decoder fault");
                }

                if (kind === "interrupt") {
                  return yield* Effect.interrupt;
                }

                const notes = yield* Notes;

                return yield* notes.rename(value, "decoded");
              }),
            encode: (value: string) => Effect.succeed(value),
          })
        )
      );

      const boundary = createEffectMiddleware({
        fallbackFailure: { code: "INTERNAL" },
        resolve: () => ({ runPromiseExit: runtime.runPromiseExit }),
      });

      const handler = effectHandler(
        ({ data }: { data: unknown; context: ExecutionCapability<Notes> }) =>
          Effect.sync(() => {
            calls += 1;

            return data;
          })
      );

      const endpoint = createMiddleware({ type: "function" })
        .middleware([boundary])
        .validator(prepareInput(schema))
        .server(async (context) => {
          const result = await handler(context);

          return { ...(await context.next()), result };
        });

      try {
        const output = await execute([endpoint], undefined, "input");

        if (kind === "service") {
          expect(output.result).toBe("input:decoded");
          expect(calls).toBe(1);
        } else {
          expect(calls).toBe(0);
          const cause = getServerFnFailureCause(output.error) ?? Cause.empty;
          expect(
            kind === "interrupt"
              ? Cause.hasInterruptsOnly(cause)
              : Cause.hasDies(cause)
          ).toBe(true);

          if (kind === "defect") {
            expect(output.error).toEqual({ code: "INTERNAL" });
          }
        }
      } finally {
        await runtime.dispose();
      }
    }
  );
});
