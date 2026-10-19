import { createFileRoute, useHydrated } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";
import { useEffect, useRef, useState } from "react";

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

const presets = [
  {
    count: "41",
    description: "Decode a string into a number.",
    label: "Valid greeting",
    name: "Ada",
  },
  {
    count: "not-a-number",
    description: "Reject a non-numeric count.",
    label: "Invalid number",
    name: "Ada",
  },
  {
    count: "0",
    description: "Reject a count that is not positive.",
    label: "Zero count",
    name: "Ada",
  },
  {
    count: "2",
    description: "Reject an empty name.",
    label: "Empty name",
    name: "",
  },
];

interface GreetingInput {
  count: string;
  name: string;
}

type Attempt = { input: GreetingInput; style: typeof Style.Type } & (
  | { state: "pending" }
  | { state: "success"; payload: string }
  | { state: "failure"; payload: string; message: string }
);

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
    const [attempt, setAttempt] = useState<Attempt | null>(null);
    const responsePanel = useRef<HTMLElement>(null);
    const [browser, setBrowser] = useState("");
    const pending = attempt?.state === "pending";

    useEffect(() => {
      if (attempt) {
        responsePanel.current?.scrollIntoView({ block: "nearest" });
      }
    }, [attempt]);

    const runGreeting = async (input: GreetingInput) => {
      setAttempt({ input, state: "pending", style });

      try {
        const value = await greet({ data: input });
        setResult(value);
        setAttempt({
          input,
          payload: JSON.stringify(value, null, 2),
          state: "success",
          style,
        });
      } catch (error) {
        const failure = Schema.is(Failure)(error)
          ? { ...error, message: error.message }
          : { message: String(error) };

        setAttempt({
          input,
          message: failure.message,
          payload: JSON.stringify(failure, null, 2),
          state: "failure",
          style,
        });
      }
    };

    return (
      <>
        <header className="page-heading">
          <p className="eyebrow">Basic example / Schema + Effect</p>
          <h1>Effect greeting</h1>
          <p>
            Send real server requests. See what gets decoded, what succeeds, and
            exactly what comes back when validation fails.
          </p>
        </header>

        <section aria-labelledby="presets-heading">
          <h2 id="presets-heading">Try a scenario</h2>
          <p>
            Each button fills the form and immediately runs the selected
            composition.
          </p>
          <div className="presets">
            {presets.map((preset) => (
              <button
                aria-label={preset.label}
                className="preset"
                disabled={!hydrated || pending}
                key={preset.label}
                onClick={() => {
                  setName(preset.name);
                  setCount(preset.count);

                  return runGreeting({
                    count: preset.count,
                    name: preset.name,
                  });
                }}
                type="button"
              >
                <strong>{preset.label}</strong>
                <span>{preset.description}</span>
              </button>
            ))}
          </div>
        </section>

        <div className="workspace">
          <section className="panel" aria-labelledby="request-heading">
            <h2 id="request-heading">Build a request</h2>
            <p>
              All five compositions use the same input Schema and return the
              same shape.
            </p>
            <form
              onSubmit={async (event) => {
                event.preventDefault();
                await runGreeting({ count, name });
              }}
            >
              <fieldset disabled={!hydrated || pending}>
                <legend className="sr-only">Greeting input</legend>
                <label>
                  Composition
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
                <label>
                  Name
                  <input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    aria-describedby="name-help"
                  />
                </label>
                <small id="name-help">
                  A non-empty string. Empty input is intentionally allowed here
                  to test the server.
                </small>
                <label>
                  Count
                  <input
                    value={count}
                    onChange={(event) => setCount(event.target.value)}
                    aria-describedby="count-help"
                  />
                </label>
                <small id="count-help">
                  Sent as a string; decoded to a finite number greater than
                  zero.
                </small>
                <button className="primary" type="submit">
                  Greet
                </button>
              </fieldset>
            </form>
          </section>

          <section
            className="panel response"
            ref={responsePanel}
            aria-labelledby="response-heading"
            aria-busy={pending}
            data-state={attempt?.state ?? "idle"}
          >
            <div className="panel-heading">
              <h2 id="response-heading">Latest request</h2>
              <span className="badge" role="status" aria-label="Request status">
                {attempt
                  ? {
                      failure: "Failure",
                      pending: "Running…",
                      success: "Success",
                    }[attempt.state]
                  : "Ready"}
              </span>
            </div>
            {attempt ? (
              <>
                <p>
                  <code>GET · {attempt.style}</code>
                </p>
                <h3>Submitted input</h3>
                <pre aria-label="Submitted input">
                  {JSON.stringify(attempt.input, null, 2)}
                </pre>
                {attempt.state === "pending" ? (
                  <p>Waiting for the server response…</p>
                ) : (
                  <>
                    <h3>
                      {attempt.state === "failure"
                        ? "Client-visible error"
                        : "Returned value"}
                    </h3>
                    {attempt.state === "failure" && (
                      <p className="error-message" role="alert">
                        {attempt.message}
                      </p>
                    )}
                    <pre aria-label="Response payload">{attempt.payload}</pre>
                    <p className="hint">
                      {attempt.state === "failure"
                        ? "Validation failures reject before the handler runs. Schema diagnostics stay on the server; this panel shows the client-visible rejection."
                        : "The count is now a number, not a string. This is the exact value returned to the client."}
                    </p>
                  </>
                )}
              </>
            ) : (
              <p className="empty-state">
                Choose a scenario or submit your own input. The actual response
                will appear here.
              </p>
            )}
          </section>
        </div>

        <section className="panel" aria-labelledby="ssr-heading">
          <h2 id="ssr-heading">Server rendering & last success</h2>
          <p>
            Rendered on the {initial.environment}: {initial.message}
          </p>
          <p className="hint">
            A failed request does not replace the last successful greeting
            below.
          </p>
          <p role="status" aria-label="Greeting result">
            {result.message} Count + 1 = {result.count + 1}
          </p>
        </section>

        <section className="panel" aria-labelledby="utilities-heading">
          <h2 id="utilities-heading">Native framework utilities</h2>
          <p>
            Run client-only Effects without an RPC, or follow a native server
            redirect.
          </p>
          <div className="actions">
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
            </button>
            <button
              type="button"
              disabled={!hydrated}
              onClick={() => goToAbout()}
            >
              Server redirect
            </button>
          </div>
          <output aria-label="Browser utilities">{browser}</output>
        </section>
      </>
    );
  },
  loader: () => getGreeting({ data: { count: "1", name: "SSR" } }),
});
