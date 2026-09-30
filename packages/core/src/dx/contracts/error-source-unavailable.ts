import { Schema } from "effect";

export class SourceUnavailable extends Schema.TaggedError<SourceUnavailable>()(
  "SourceUnavailable",
  { adapterId: Schema.String, message: Schema.String }
) {}
