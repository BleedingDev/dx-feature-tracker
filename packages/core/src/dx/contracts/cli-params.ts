import { Schema } from "effect";

export const DEFAULT_STORE_RELATIVE = ".dft/dft.db" as const;

export const DEFAULT_REPLAY_STORE_RELATIVE = ".dft/replay.db" as const;

export const STORE_ENV_VAR = "DX_STORE" as const;

export const DxCliParamsSchema = Schema.Struct({
  asOf: Schema.optional(Schema.String),
  flight: Schema.optional(Schema.String),
  input: Schema.optional(Schema.String),
  replay: Schema.optional(Schema.Boolean),
  repo: Schema.optional(Schema.String),
  snapshotId: Schema.optional(Schema.String),
  source: Schema.optional(Schema.String),
  store: Schema.optional(Schema.String),
});

export type DxCliParams = typeof DxCliParamsSchema.Type;
