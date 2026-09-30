import { Schema } from "effect";

import { SourceGapSchema } from "./coverage.js";
import { DescriptorIdSchema } from "./ids.js";

export const ModuleKindSchema = Schema.Literals([
  "collector",
  "correlation",
  "metric",
  "report",
  "service",
  "surface",
]);

export type ModuleKind = typeof ModuleKindSchema.Type;

export const ModuleReadinessSchema = Schema.Literals([
  "ready",
  "degraded",
  "unsupported",
  "disabled",
]);

export type ModuleReadiness = typeof ModuleReadinessSchema.Type;

export const ModuleDescriptorSchema = Schema.Struct({
  contractVersion: Schema.String,
  fixtureIds: Schema.Array(Schema.String),
  gaps: Schema.Array(SourceGapSchema),
  id: DescriptorIdSchema,
  kind: ModuleKindSchema,
  owner: Schema.String,
  readiness: ModuleReadinessSchema,
  requiredInputs: Schema.Array(Schema.String),
  supportedFields: Schema.Array(Schema.String),
  version: Schema.String,
});

export type ModuleDescriptor = typeof ModuleDescriptorSchema.Type;
