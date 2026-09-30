import { defineContract } from "@rat-stack/capability/contract";
import { Schema } from "effect";

import { SourceCoverageSchema } from "../model/coverage.js";
import {
  AnalyzeReportSchema,
  EvidenceItemSchema,
  ExplainTimelineSchema,
  StatusReportSchema,
} from "../model/report.js";
import {
  CollectFailureSchema,
  MarkFailureSchema,
  QueryFailureSchema,
} from "./errors.js";

export const CapabilityNames = [
  "dx_status",
  "dx_collect",
  "dx_mark",
  "dx_analyze",
  "dx_explain",
  "dx_evidence",
] as const;

export type CapabilityName = (typeof CapabilityNames)[number];

export const DxStatusInput = Schema.Struct({});

export const DxCollectInput = Schema.Struct({
  flight: Schema.optional(Schema.String),
  input: Schema.optional(
    Schema.String.annotate({
      description: "Explicitly selected input path/ref",
    })
  ),
  repo: Schema.optional(Schema.String),
  since: Schema.optional(Schema.String),
  source: Schema.String.annotate({ description: "Adapter/descriptor ID" }),
});

export const DxCollectOutput = Schema.Struct({
  adapterId: Schema.String,
  coverage: SourceCoverageSchema,
  duplicates: Schema.Int,
  inserted: Schema.Int,
});

export const MarkKind = Schema.Literals([
  "start",
  "stop",
  "wait-start",
  "wait-stop",
  "claim",
]);

export const DxMarkInput = Schema.Struct({
  flight: Schema.optional(Schema.String),
  kind: MarkKind,
  label: Schema.optional(Schema.String),
  note: Schema.optional(Schema.String),
  repo: Schema.optional(Schema.String),
});

export const DxMarkOutput = Schema.Struct({
  eventId: Schema.String,
  flightId: Schema.String,
});

export const DxAnalyzeInput = Schema.Struct({
  asOf: Schema.optional(Schema.String),
  flight: Schema.optional(Schema.String),
  repo: Schema.optional(Schema.String),
  snapshotId: Schema.optional(Schema.String),
});

export const DxExplainInput = Schema.Struct({
  asOf: Schema.optional(Schema.String),
  cursor: Schema.optional(Schema.String),
  flight: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Int),
  snapshotId: Schema.optional(Schema.String),
});

export const DxEvidenceInput = Schema.Struct({
  asOf: Schema.optional(Schema.String),
  evidenceIds: Schema.Array(Schema.String),
  snapshotId: Schema.optional(Schema.String),
});

export const DxEvidenceOutput = Schema.Struct({
  items: Schema.Array(EvidenceItemSchema),
});

export const dxStatusContract = defineContract("dx_status", {
  annotations: { idempotent: true, readOnly: true },
  description: "Show DX recorder modules, store and contract version",
  failure: QueryFailureSchema,
  input: DxStatusInput,
  output: StatusReportSchema,
});

export const dxCollectContract = defineContract("dx_collect", {
  annotations: { idempotent: true, readOnly: false },
  description:
    "Record or import evidence from one explicitly selected source into the local store",
  failure: CollectFailureSchema,
  input: DxCollectInput,
  output: DxCollectOutput,
});

export const dxMarkContract = defineContract("dx_mark", {
  annotations: { readOnly: false },
  description:
    "Write an explicit flight start/stop/wait marker or labelled claim",
  failure: MarkFailureSchema,
  input: DxMarkInput,
  output: DxMarkOutput,
});

export const dxAnalyzeContract = defineContract("dx_analyze", {
  annotations: { idempotent: true, readOnly: false },
  description:
    "Analyze a flight from stored evidence; persists snapshot metadata only, never collects",
  failure: QueryFailureSchema,
  input: DxAnalyzeInput,
  output: AnalyzeReportSchema,
});

export const dxExplainContract = defineContract("dx_explain", {
  annotations: { idempotent: true, readOnly: true },
  description: "Explain a flight as an evidence-linked timeline",
  failure: QueryFailureSchema,
  input: DxExplainInput,
  output: ExplainTimelineSchema,
});

export const dxEvidenceContract = defineContract("dx_evidence", {
  annotations: { idempotent: true, readOnly: true },
  description: "Return redacted, bounded evidence items by ID",
  failure: QueryFailureSchema,
  input: DxEvidenceInput,
  output: DxEvidenceOutput,
});
