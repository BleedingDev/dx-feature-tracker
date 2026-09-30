import { Schema } from "effect";

export class ContractMismatch extends Schema.TaggedError<ContractMismatch>()(
  "ContractMismatch",
  { actual: Schema.String, expected: Schema.String, message: Schema.String }
) {}
