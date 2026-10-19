import { redirect } from "@tanstack/react-router";
import { Effect, flow, pipe, Schema } from "effect";

import { createEffectServerFn } from "./effect-server-fn.ts";
import { environment, greeting } from "./environment.ts";

const Input = Schema.Struct({
  count: Schema.FiniteFromString.pipe(Schema.check(Schema.isGreaterThan(0))),
  name: Schema.NonEmptyString,
});

export const getGreeting = createEffectServerFn({ method: "GET" })
  .validator(Input)
  .handler(({ data }) =>
    Effect.gen(function* greet() {
      return {
        count: data.count,
        environment: yield* environment(),
        message: yield* greeting(data.name),
      };
    })
  );

export const getPipedGreeting = createEffectServerFn({ method: "GET" })
  .validator(Input)
  .handler(({ data }) =>
    pipe(
      greeting(data.name),
      Effect.flatMap((message) =>
        environment().pipe(
          Effect.map((value) => ({
            count: data.count,
            environment: value,
            message,
          }))
        )
      ),
      Effect.withSpan("Greeting.pipe")
    )
  );

const greetTogether = (data: typeof Input.Type) =>
  Effect.all(
    {
      count: Effect.succeed(data.count),
      environment: environment(),
      message: greeting(data.name),
    },
    { concurrency: 2 }
  );

export const getFlowGreeting = createEffectServerFn({ method: "GET" })
  .validator(Input)
  .handler(
    flow(
      ({ data }: { data: typeof Input.Type }) => data,
      greetTogether,
      Effect.withSpan("Greeting.flow")
    )
  );

export const getFnGreeting = createEffectServerFn({ method: "GET" })
  .validator(Input)
  .handler(
    Effect.fn("Greeting.fn")(
      function* greet({ data }: { data: typeof Input.Type }) {
        return {
          count: data.count,
          environment: yield* environment(),
          message: yield* greeting(data.name),
        };
      },
      Effect.annotateLogs({ feature: "greeting" })
    )
  );

export const getDoGreeting = createEffectServerFn({ method: "GET" })
  .validator(Input)
  .handler(({ data }) =>
    Effect.Do.pipe(
      Effect.bind("message", () => greeting(data.name)),
      Effect.bind("environment", () => environment()),
      Effect.let("count", () => data.count)
    )
  );

export const visitAbout = createEffectServerFn().handler(() =>
  Effect.fail(redirect({ to: "/about" }))
);
