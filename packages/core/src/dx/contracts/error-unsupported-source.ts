import { Schema } from "effect";

export class UnsupportedSource extends Schema.TaggedError<UnsupportedSource>()(
  "UnsupportedSource",
  {
    adapterId: Schema.String,
    message: Schema.String,
    sourceVersion: Schema.NullOr(Schema.String),
  }
) {}
