import {
  createFileRoute,
  useHydrated,
  useRouter,
} from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Schema } from "effect";
import { useEffect, useRef, useState } from "react";

import {
  getNote,
  renameNote,
  renameNoteIfPresent,
} from "../notes.functions.ts";

const Failure = Schema.Struct({ message: Schema.String });

const presets = [
  {
    description: "Update note 1 and refresh the loader.",
    id: "1",
    label: "Successful save",
    recover: false,
    title: "Saved from a preset",
  },
  {
    description: "Reject an empty title before mutation.",
    id: "1",
    label: "Invalid input",
    recover: false,
    title: "",
  },
  {
    description: "Return an approved NoteMissing error.",
    id: "missing",
    label: "Missing note",
    recover: false,
    title: "Missing note example",
  },
  {
    description: "Trigger a defect; receive a safe fallback.",
    id: "1",
    label: "Server defect",
    recover: false,
    title: "crash",
  },
  {
    description: "Use catchTag to return a successful skip.",
    id: "missing",
    label: "Recover missing note",
    recover: true,
    title: "Recovery example",
  },
];

interface RenameInput {
  id: string;
  title: string;
}

type Attempt = { input: RenameInput; recover: boolean } & (
  | { state: "pending" }
  | { state: "success"; payload: string; message: string }
  | { state: "failure"; payload: string; message: string }
);

export const Route = createFileRoute("/")({
  component: () => {
    const hydrated = useHydrated();
    const note = Route.useLoaderData();
    const router = useRouter();
    const [recoverMissing, setRecoverMissing] = useState(false);
    const rename = useServerFn(renameNote);
    const renameIfPresent = useServerFn(renameNoteIfPresent);
    const [id, setId] = useState(note.id);
    const [title, setTitle] = useState(note.title);
    const [attempt, setAttempt] = useState<Attempt | null>(null);
    const responsePanel = useRef<HTMLElement>(null);
    const pending = attempt?.state === "pending";

    useEffect(() => {
      if (attempt) {
        responsePanel.current?.scrollIntoView({ block: "nearest" });
      }
    }, [attempt]);

    const runRename = async (input: RenameInput, recover: boolean) => {
      setAttempt({ input, recover, state: "pending" });

      try {
        const outcome = await (recover ? renameIfPresent : rename)({
          data: input,
        });

        await router.invalidate({ sync: true });
        setAttempt({
          input,
          message: outcome.saved ? "Saved" : "Skipped missing note",
          payload: JSON.stringify(outcome, null, 2),
          recover,
          state: "success",
        });
      } catch (error) {
        const failure = Schema.is(Failure)(error)
          ? { ...error, message: error.message }
          : { message: String(error) };

        setAttempt({
          input,
          message: failure.message,
          payload: JSON.stringify(failure, null, 2),
          recover,
          state: "failure",
        });
      }
    };

    return (
      <>
        <header className="page-heading">
          <p className="eyebrow">Services example / ManagedRuntime + Layer</p>
          <h1>Effect notes</h1>
          <p>
            One application-owned ManagedRuntime serves every request. Compare
            validation failures, public errors, private defects, and typed
            recovery.
          </p>
        </header>

        <section className="saved-note" aria-labelledby="saved-heading">
          <div>
            <p className="eyebrow" id="saved-heading">
              Current service state · Note {note.id}
            </p>
            <p>
              Saved title:{" "}
              <output aria-label="Saved title">{note.title}</output>
            </p>
          </div>
          <p className="hint">
            Shared in memory across requests. Survives page reloads; resets on
            server restart.
          </p>
        </section>

        <section aria-labelledby="presets-heading">
          <h2 id="presets-heading">Try a scenario</h2>
          <p>
            Each button fills the form, sets recovery, and immediately sends a
            real request.
          </p>
          <div className="presets">
            {presets.map((preset) => (
              <button
                aria-label={preset.label}
                className="preset"
                disabled={!hydrated || pending}
                key={preset.label}
                onClick={() => {
                  setId(preset.id);
                  setTitle(preset.title);
                  setRecoverMissing(preset.recover);

                  return runRename(
                    { id: preset.id, title: preset.title },
                    preset.recover
                  );
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
              Only note <code>1</code> exists. Try other IDs, an empty title, or{" "}
              <code>crash</code>.
            </p>
            <form
              onSubmit={async (event) => {
                event.preventDefault();
                await runRename({ id, title }, recoverMissing);
              }}
            >
              <fieldset disabled={!hydrated || pending}>
                <legend className="sr-only">Note input</legend>
                <label>
                  Note ID
                  <input
                    value={id}
                    onChange={(event) => setId(event.target.value)}
                  />
                </label>
                <label>
                  Title
                  <input
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                  />
                </label>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={recoverMissing}
                    onChange={(event) =>
                      setRecoverMissing(event.target.checked)
                    }
                  />
                  Recover missing notes with catchTag
                </label>
                <small>
                  Recovery handles NoteMissing only. Schema rejections and
                  defects still fail.
                </small>
                <button className="primary" type="submit">
                  Save note
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
                  <code>
                    POST ·{" "}
                    {attempt.recover ? "renameNoteIfPresent" : "renameNote"}
                  </code>
                </p>
                <h3>Submitted input</h3>
                <pre aria-label="Submitted input">
                  {JSON.stringify(attempt.input, null, 2)}
                </pre>
                {attempt.state === "pending" ? (
                  <p>Waiting for the server response and loader refresh…</p>
                ) : (
                  <>
                    <h3>
                      {attempt.state === "failure"
                        ? "Client-visible error"
                        : "Returned value"}
                    </h3>
                    {attempt.state === "failure" ? (
                      <p className="error-message" role="alert">
                        {attempt.message}
                      </p>
                    ) : (
                      <p
                        className="success-message"
                        role="status"
                        aria-label="Save status"
                      >
                        {attempt.message}
                      </p>
                    )}
                    <pre aria-label="Response payload">{attempt.payload}</pre>
                    <p className="hint">
                      {attempt.state === "failure"
                        ? "This is the exact public error received by the client. Validation diagnostics and defect details stay on the server. Failed requests do not change the saved note."
                        : "This is the exact value returned to the client. A recovered missing note returns saved: false; it does not modify the existing note."}
                    </p>
                  </>
                )}
              </>
            ) : (
              <p className="empty-state">
                Choose a scenario or save your own title. The actual response
                will appear here.
              </p>
            )}
          </section>
        </div>

        <section className="panel" aria-labelledby="boundary-heading">
          <h2 id="boundary-heading">What crosses the boundary?</h2>
          <dl className="boundary-guide">
            <div>
              <dt>Invalid input</dt>
              <dd>
                Schema rejects before mutation. The client receives{" "}
                <code>INVALID_INPUT</code>, “Invalid input”, and HTTP 400, not
                the private Schema diagnostic.
              </dd>
            </div>
            <div>
              <dt>Approved failure</dt>
              <dd>
                <code>NoteMissing</code> is allowed by the public-error Schema,
                so its tag and message reach the client.
              </dd>
            </div>
            <div>
              <dt>Private defect</dt>
              <dd>
                The deliberate crash becomes <code>INTERNAL</code> / “Something
                went wrong”. The original diagnostic is never sent to the
                browser.
              </dd>
            </div>
            <div>
              <dt>Typed recovery</dt>
              <dd>
                <code>catchTag</code> turns NoteMissing into{" "}
                <code>{'{ "saved": false, "title": null }'}</code>. This is a
                successful result, not an error.
              </dd>
            </div>
          </dl>
        </section>
      </>
    );
  },
  loader: () => getNote(),
});
