import { notFound, redirect } from "@tanstack/router-core";
import {
  Context,
  Deferred,
  Effect,
  Layer,
  ManagedRuntime,
  Schema,
} from "effect";

export const Notes = Context.Service("http-fixture/Notes");

export const PublicError = Schema.Struct({
  code: Schema.Literal("MISSING"),
  message: Schema.String,
});

const entered = Deferred.makeUnsafe();
const released = Deferred.makeUnsafe();

export const runtime = ManagedRuntime.make(
  Layer.succeed(Notes, {
    rename: (id, title) => {
      if (id === "response") {
        return Effect.succeed(new Response("raw", { status: 201 }));
      }

      if (id === "denied") {
        return Effect.fail(new Response("denied", { status: 403 }));
      }

      if (id === "redirect") {
        return Effect.fail(redirect({ href: "/login" }));
      }

      if (id === "notFound") {
        return Effect.fail(notFound());
      }

      if (id === "wait-entered") {
        return Deferred.await(entered).pipe(Effect.as("entered"));
      }

      if (id === "wait-released") {
        return Deferred.await(released).pipe(Effect.as("released"));
      }

      if (id === "wait") {
        return Effect.gen(function* wait() {
          yield* Effect.acquireRelease(Effect.void, () =>
            Deferred.succeed(released, true)
          );
          yield* Deferred.succeed(entered, true);

          return yield* Effect.never;
        });
      }

      if (id === "missing") {
        return Effect.fail({
          code: "MISSING",
          message: "Not found",
          privateValue: "never-send-this",
        });
      }

      if (id === "defect") {
        return Effect.die(new Error("never-send-this"));
      }

      return Effect.succeed({ id, title });
    },
  })
);
