import { Schema } from "effect";

import { IsoTimestampSchema } from "./common.js";

export const ProbeReceiptSchema = Schema.Struct({
  adapterId: Schema.String,
  itemCount: Schema.NullOr(Schema.Int),
  layout: Schema.NullOr(Schema.String),
  notes: Schema.Array(Schema.String),
  present: Schema.Boolean,
  probeId: Schema.String,
  probedAt: IsoTimestampSchema,
  readable: Schema.Boolean,
  sourceKind: Schema.String,
  version: Schema.NullOr(Schema.String),
});

export type ProbeReceipt = typeof ProbeReceiptSchema.Type;
