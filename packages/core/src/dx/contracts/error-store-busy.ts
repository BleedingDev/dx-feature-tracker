import { Schema } from "effect";

export class StoreBusy extends Schema.TaggedError<StoreBusy>()("StoreBusy", {
  message: Schema.String,
}) {}
