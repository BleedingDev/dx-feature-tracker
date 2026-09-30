import { Schema } from "effect";

export class InvalidInput extends Schema.TaggedError<InvalidInput>()(
  "InvalidInput",
  { field: Schema.NullOr(Schema.String), message: Schema.String }
) {}
