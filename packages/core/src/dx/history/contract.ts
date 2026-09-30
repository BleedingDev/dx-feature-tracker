import { defineContract } from "@rat-stack/capability/contract";
import { Schema } from "effect";

import { QueryFailureSchema } from "../contracts/errors.js";
import {
  IsoTimestampSchema,
  MeasurementStateSchema,
  ValueMethodSchema,
} from "../model/common.js";

export const HISTORY_CONTRACT_VERSION = "dx.history.v1" as const;

export const DxHistoryInput = Schema.Struct({
  allRepos: Schema.optional(
    Schema.Boolean.annotate({
      description: "Include every repository in the store, not only --repo",
    })
  ),
  repo: Schema.optional(
    Schema.String.annotate({ description: "Repository path (default: cwd)" })
  ),
  since: Schema.optional(
    Schema.String.annotate({
      description:
        "Only flights with activity since this point: a duration such as 7d, 24h, 30m, 2w, or an ISO timestamp",
    })
  ),
});

export type DxHistoryInputType = typeof DxHistoryInput.Type;

export const HistoryMeasureSchema = Schema.Struct({
  measurement: MeasurementStateSchema,
  method: ValueMethodSchema,
  metricId: Schema.String,
  reason: Schema.NullOr(Schema.String),
  unit: Schema.String,
  value: Schema.NullOr(Schema.Finite),
});

export type HistoryMeasure = typeof HistoryMeasureSchema.Type;

export const FlightStatusSchema = Schema.Literals([
  "open",
  "merged",
  "deleted",
  "unknown",
]);

export type FlightStatus = typeof FlightStatusSchema.Type;

export const FlightStatusReportSchema = Schema.Struct({
  reason: Schema.NullOr(Schema.String),
  value: FlightStatusSchema,
});

export type FlightStatusReport = typeof FlightStatusReportSchema.Type;

export const TokenMeasureSchema = Schema.Struct({
  category: Schema.String,
  measure: HistoryMeasureSchema,
});

export const MoneyLedgersSchema = Schema.Struct({
  billed: HistoryMeasureSchema,
  estimatedPriceTable: HistoryMeasureSchema,
  estimatedSource: HistoryMeasureSchema,
  metered: HistoryMeasureSchema,
});

export type MoneyLedgers = typeof MoneyLedgersSchema.Type;

export const FlightHistoryRowSchema = Schema.Struct({
  activeTime: HistoryMeasureSchema,
  agentTime: HistoryMeasureSchema,
  branch: Schema.NullOr(Schema.String),
  branchAge: HistoryMeasureSchema,
  chats: HistoryMeasureSchema,
  commits: HistoryMeasureSchema,
  events: Schema.Int,
  firstActivityAt: Schema.NullOr(IsoTimestampSchema),
  lastActivityAt: Schema.NullOr(IsoTimestampSchema),
  money: MoneyLedgersSchema,
  repoCommonDir: Schema.NullOr(Schema.String),
  requests: HistoryMeasureSchema,
  status: FlightStatusReportSchema,
  tokens: Schema.Array(TokenMeasureSchema),
  worktree: Schema.optionalKey(
    Schema.NullOr(Schema.String).annotate({
      description:
        "Worktree of the branch's latest activity; each linked worktree gets its own row through its branch",
    })
  ),
  worktrees: Schema.Array(Schema.String),
});

export type FlightHistoryRow = typeof FlightHistoryRowSchema.Type;

export const DxHistoryOutput = Schema.Struct({
  allRepos: Schema.Boolean,
  asOf: IsoTimestampSchema,
  contractVersion: Schema.Literal(HISTORY_CONTRACT_VERSION),
  notes: Schema.Array(Schema.String),
  repoCommonDir: Schema.NullOr(Schema.String),
  rows: Schema.Array(FlightHistoryRowSchema),
  since: Schema.NullOr(IsoTimestampSchema),
});

export type DxHistoryOutputType = typeof DxHistoryOutput.Type;

export const dxHistoryContract = defineContract("dx_history", {
  annotations: { idempotent: true, readOnly: true },
  description:
    "List feature flights (repo, branch) with activity, agent time, requests, tokens, commits and every money ledger shown separately",
  failure: QueryFailureSchema,
  input: DxHistoryInput,
  output: DxHistoryOutput,
});
