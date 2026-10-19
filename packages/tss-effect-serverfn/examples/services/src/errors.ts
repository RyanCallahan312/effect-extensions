import { Schema } from "effect";

// oxlint-disable-next-line unicorn/throw-new-error -- TaggedError is a class factory.
export class NoteMissing extends Schema.TaggedError<NoteMissing>()(
  "NoteMissing",
  { message: Schema.String }
) {}
