import {
  createFileRoute,
  useHydrated,
  useRouter,
} from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Schema } from "effect";
import { useState } from "react";

import {
  getNote,
  renameNote,
  renameNoteIfPresent,
} from "../notes.functions.ts";

const Failure = Schema.Struct({ message: Schema.String });

export const Route = createFileRoute("/")({
  component: () => {
    const hydrated = useHydrated();
    const note = Route.useLoaderData();
    const router = useRouter();
    const [recoverMissing, setRecoverMissing] = useState(false);

    const rename = useServerFn(
      recoverMissing ? renameNoteIfPresent : renameNote
    );

    const [id, setId] = useState(note.id);
    const [title, setTitle] = useState(note.title);
    const [errorMessage, setError] = useState("");
    const [status, setStatus] = useState("");
    const [pending, setPending] = useState(false);

    return (
      <>
        <h1>Effect notes</h1>
        <p>One application-owned ManagedRuntime serves every request.</p>
        <p>
          Saved title: <output aria-label="Saved title">{note.title}</output>
        </p>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setPending(true);
            setError("");
            setStatus("");

            try {
              const outcome = await rename({ data: { id, title } });
              await router.invalidate();
              setStatus(outcome.saved ? "Saved" : "Skipped missing note");
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
              Note ID{" "}
              <input
                value={id}
                onChange={(event) => setId(event.target.value)}
              />
            </label>
          </p>
          <p>
            <label>
              Title{" "}
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
          </p>
          <p>
            <label>
              <input
                type="checkbox"
                checked={recoverMissing}
                onChange={(event) => setRecoverMissing(event.target.checked)}
              />{" "}
              Recover missing notes with catchTag
            </label>
          </p>
          <button type="submit" disabled={!hydrated || pending}>
            Save note
          </button>
        </form>
        {status && (
          <p role="status" aria-label="Save status">
            {status}
          </p>
        )}
        {errorMessage && <p role="alert">{errorMessage}</p>}
        <p>
          Try a missing ID for an approved error, an empty title for invalid
          input, or the title <code>crash</code> for a sanitized defect.
        </p>
      </>
    );
  },
  loader: () => getNote(),
});
