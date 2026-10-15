import { createFileRoute, useHydrated } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";
import { useState } from "react";

import { browserPath, environment } from "../environment.ts";
import {
  getDoGreeting,
  getFlowGreeting,
  getFnGreeting,
  getGreeting,
  getPipedGreeting,
  visitAbout,
} from "../greeting.functions.ts";

const Failure = Schema.Struct({ message: Schema.String });
const Style = Schema.Literals(["gen", "pipe", "flow", "fn", "do"]);

const greetings = {
  do: getDoGreeting,
  flow: getFlowGreeting,
  fn: getFnGreeting,
  gen: getGreeting,
  pipe: getPipedGreeting,
};

export const Route = createFileRoute("/")({
  component: () => {
    const hydrated = useHydrated();
    const initial = Route.useLoaderData();
    const [style, setStyle] = useState<typeof Style.Type>("gen");
    const greet = useServerFn(greetings[style]);
    const goToAbout = useServerFn(visitAbout);
    const [name, setName] = useState("Ada");
    const [count, setCount] = useState("2");
    const [result, setResult] = useState(initial);
    const [errorMessage, setError] = useState("");
    const [pending, setPending] = useState(false);
    const [browser, setBrowser] = useState("");

    return (
      <>
        <h1>Effect greeting</h1>
        <p>
          Rendered on the {initial.environment}: {initial.message}
        </p>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setPending(true);
            setError("");

            try {
              setResult(await greet({ data: { count, name } }));
            } catch (error) {
              setError(
                Schema.is(Failure)(error)
                  ? error.message
                  : "Unexpected response"
              );
            } finally {
              setPending(false);
            }
          }}
        >
          <p>
            <label>
              Composition{" "}
              <select
                value={style}
                onChange={(event) => {
                  const { value } = event.target;

                  if (Schema.is(Style)(value)) {
                    setStyle(value);
                  }
                }}
              >
                <option value="gen">Effect.gen</option>
                <option value="pipe">pipe + flatMap + map</option>
                <option value="flow">flow + Effect.all</option>
                <option value="fn">Effect.fn</option>
                <option value="do">Do + bind + let</option>
              </select>
            </label>
          </p>
          <p>
            <label>
              Name{" "}
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
          </p>
          <p>
            <label>
              Count{" "}
              <input
                value={count}
                onChange={(event) => setCount(event.target.value)}
              />
            </label>
          </p>
          <button type="submit" disabled={!hydrated || pending}>
            Greet
          </button>
        </form>
        <p role="status" aria-label="Greeting result">
          {result.message} Count + 1 = {result.count + 1}
        </p>
        {errorMessage && <p role="alert">{errorMessage}</p>}
        <p>
          <button
            type="button"
            disabled={!hydrated}
            onClick={async () => {
              const value = await Effect.runPromise(
                Effect.gen(function* checkBrowser() {
                  return `${yield* environment()} ${yield* browserPath()}`;
                })
              );

              setBrowser(value);
            }}
          >
            Check browser utilities
          </button>{" "}
          <output aria-label="Browser utilities">{browser}</output>
        </p>
        <button type="button" disabled={!hydrated} onClick={() => goToAbout()}>
          Server redirect
        </button>
      </>
    );
  },
  loader: () => getGreeting({ data: { count: "1", name: "SSR" } }),
});
