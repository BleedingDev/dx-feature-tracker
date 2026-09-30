import { Schema } from "effect";

export class StoreError extends Schema.TaggedError<StoreError>()("StoreError", {
  message: Schema.String,
  operation: Schema.String,
}) {}
