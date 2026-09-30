import { Schema } from "effect";

export class Cancelled extends Schema.TaggedError<Cancelled>()("Cancelled", {
  message: Schema.String,
}) {}
