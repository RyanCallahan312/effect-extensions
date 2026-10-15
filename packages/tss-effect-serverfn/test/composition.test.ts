import {
  Context,
  Effect,
  flow,
  Layer,
  ManagedRuntime,
  pipe,
  Schema,
} from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";

import { createEffectServerFn } from "../src/create-effect-server-fn.ts";
import { createEffectMiddleware } from "../src/effect-middleware.ts";
import { runProgram } from "./effect-fixture.ts";

const Missing = Schema.TaggedStruct("Missing", {
  message: Schema.String,
});

type MissingFailure = typeof Missing.Type;

class Catalog extends Context.Service<
  Catalog,
  {
    readonly lookup: (id: number) => Effect.Effect<string, MissingFailure>;
  }
>()("test/composition/Catalog") {}

const Input = Schema.Struct({
  id: Schema.FiniteFromString.pipe(Schema.check(Schema.isGreaterThan(0))),
});

const lookup = Effect.fn("Catalog.lookup")((data: typeof Input.Type) =>
  pipe(
    Catalog,
    Effect.flatMap((catalog) => catalog.lookup(data.id)),
    Effect.map((title) => ({ id: data.id, title }))
  )
);

describe("native composition", () => {
  it("preserves decoded input, success, error, and services through flow and fn handlers", async () => {
    const runtime = ManagedRuntime.make(
      Layer.succeed(Catalog, {
        lookup: (id) => Effect.succeed(`item-${id}`),
      })
    );

    const factory = createEffectServerFn().middleware([
      createEffectMiddleware({
        fallbackFailure: { code: "INTERNAL" },
        resolve: () => ({ runPromiseExit: runtime.runPromiseExit }),
      }),
    ]);

    const handler = flow(
      ({ data }: { data: typeof Input.Type }) => data,
      lookup,
      Effect.withSpan("Catalog.handler")
    );

    expectTypeOf<ReturnType<typeof handler>>().toEqualTypeOf<
      Effect.Effect<{ id: number; title: string }, MissingFailure, Catalog>
    >();

    const recovered = flow(
      handler,
      Effect.catchTag("Missing", () =>
        Effect.succeed({ id: 0, title: "Unavailable" })
      )
    );

    expectTypeOf<
      Effect.Error<ReturnType<typeof recovered>>
    >().toEqualTypeOf<never>();
    expectTypeOf<
      Effect.Services<ReturnType<typeof recovered>>
    >().toEqualTypeOf<Catalog>();
    expectTypeOf<Effect.Success<ReturnType<typeof recovered>>>().toMatchTypeOf<{
      id: number;
      title: string;
    }>();

    // Native handlers are compiler-only: these declarations verify the public surface without executing it.
    const defineFlow = () => factory().validator(Input).handler(handler);

    const defineFn = () =>
      factory()
        .validator(Input)
        .handler(
          Effect.fn("Catalog.endpoint")(
            function* endpoint({ data }: { data: typeof Input.Type }) {
              return yield* lookup(data);
            },
            Effect.annotateLogs({ feature: "catalog" })
          )
        );

    const defineDo = () =>
      factory()
        .validator(Input)
        .handler(({ data }) =>
          Effect.Do.pipe(
            Effect.bind("item", () => lookup(data)),
            Effect.let("title", ({ item }) => item.title),
            Effect.map(({ title }) => title)
          )
        );

    expectTypeOf<
      Parameters<ReturnType<typeof defineFlow>>[0]["data"]
    >().toEqualTypeOf<{ readonly id: string }>();
    expectTypeOf<ReturnType<ReturnType<typeof defineFlow>>>().toEqualTypeOf<
      Promise<{ id: number; title: string }>
    >();
    expectTypeOf<ReturnType<ReturnType<typeof defineFn>>>().toEqualTypeOf<
      Promise<{ id: number; title: string }>
    >();
    expectTypeOf<ReturnType<ReturnType<typeof defineDo>>>().toEqualTypeOf<
      Promise<string>
    >();

    const emptyFactory = createEffectServerFn().middleware([
      createEffectMiddleware({
        fallbackFailure: { code: "INTERNAL" },
        resolve: () => ({ runPromiseExit: Effect.runPromiseExit }),
      }),
    ]);

    const missingService = () =>
      emptyFactory()
        .validator(Input)
        // @ts-expect-error Composing with flow must not erase the Catalog requirement.
        // @effect-diagnostics-next-line missingEffectContext:off
        .handler(handler);

    expect(missingService).toBeTypeOf("function");

    try {
      const result = await runProgram(runtime, handler({ data: { id: 42 } }));
      expect(result.error).toBeUndefined();
      expect(result.result).toEqual({ id: 42, title: "item-42" });
    } finally {
      await runtime.dispose();
    }
  });

  it.each([false, true])(
    "awaits piped tap and finalizers with recovery=%s",
    async (missing) => {
      const events: string[] = [];

      const runtime = ManagedRuntime.make(
        Layer.succeed(Catalog, {
          lookup: (id) =>
            missing
              ? Effect.fail(Missing.make({ message: "Not found" }))
              : Effect.succeed(`item-${id}`),
        })
      );

      const record = (event: string) =>
        Effect.yieldNow.pipe(
          Effect.andThen(
            Effect.sync(() => {
              events.push(event);
            })
          )
        );

      const program = pipe(
        Effect.acquireRelease(record("acquire"), () => record("release")),
        Effect.flatMap(() => lookup({ id: 7 })),
        Effect.tap(() => record("tap")),
        Effect.as("saved"),
        Effect.catchTag("Missing", () =>
          record("recover").pipe(Effect.as("skipped"))
        ),
        Effect.ensuring(record("ensure"))
      );

      expect(events).toEqual([]);

      try {
        const result = await runProgram(runtime, program);
        expect(result.error).toBeUndefined();
        expect(result.result).toBe(missing ? "skipped" : "saved");
        expect(events).toEqual([
          "acquire",
          missing ? "recover" : "tap",
          "ensure",
          "release",
        ]);
      } finally {
        await runtime.dispose();
      }
    }
  );
});
