import { defineContract } from "@rat-stack/capability/contract";
import { Schema } from "effect";

import { QueryFailureSchema } from "../contracts/errors.js";
import { IsoTimestampSchema } from "../model/common.js";
import { USAGE_DIMENSIONS, USAGE_METRICS } from "./query.js";

export const USAGE_CONTRACT_VERSION = "dx.usage.v1" as const;

export const UsageDimensionSchema = Schema.Literals(USAGE_DIMENSIONS);

export const UsageMetricSchema = Schema.Literals(USAGE_METRICS);

export const TimeBucketSchema = Schema.Literals(["day", "week", "month"]);

const valuesOf = (description: string) =>
  Schema.optional(
    Schema.Array(Schema.String).annotate({
      description: `${description}; any of the listed values matches. "(none)" matches a missing value.`,
    })
  );

export const DxUsageInput = Schema.Struct({
  agent: valuesOf("Agent types or ids"),
  attribution: valuesOf(
    "How the branch was found (harness-recorded, hook, git-at-time, session-recorded, tool-calls, cwd-inferred, subagent-split, unassigned)"
  ),
  branch: valuesOf("Branch names"),
  bucket: Schema.optional(
    TimeBucketSchema.annotate({
      description: "Time bucket of the series (default day)",
    })
  ),
  channel: valuesOf("Channels (session-file, hooks, usage-api, ...)"),
  effort: valuesOf("Reasoning effort levels"),
  groupBy: Schema.optional(
    UsageDimensionSchema.annotate({ description: "One dimension to group by" })
  ),
  limit: Schema.optional(
    Schema.Int.check(Schema.isBetween({ maximum: 500, minimum: 1 })).annotate({
      description:
        "Most groups to list; the rest are summed into one Other row (default 10)",
    })
  ),
  metrics: Schema.optional(
    Schema.Array(UsageMetricSchema).annotate({
      description:
        "Measures to return (default tokens, requests, estimate, billed, toolFigure). Money ledgers stay separate and are never added together.",
    })
  ),
  model: valuesOf("Normalized model names"),
  parentSession: valuesOf("Parent session ids"),
  provider: valuesOf("Model makers (anthropic, openai, ...)"),
  repo: valuesOf(
    'Repository paths or git common dirs; "(no repo)" for usage outside a repo'
  ),
  scope: valuesOf(
    "request (default) or account-bucket; account buckets are only counted when listed here"
  ),
  session: valuesOf("Session ids"),
  since: Schema.optional(
    Schema.String.annotate({
      description:
        "Start of the window: a duration such as 7d, 24h, 30m, 2w, an ISO timestamp, or a date (midnight in tz)",
    })
  ),
  sortBy: Schema.optional(
    UsageMetricSchema.annotate({
      description: "Measure that orders groups (default the first metric)",
    })
  ),
  stackBy: Schema.optional(
    UsageDimensionSchema.annotate({
      description: "Dimension that splits each series bucket (default tool)",
    })
  ),
  tool: valuesOf(
    "Tools (cursor, claude-code, codex, opencode, pi, omp, deepseek)"
  ),
  tz: Schema.optional(
    Schema.String.annotate({
      description:
        "IANA time zone for day, week and month buckets (default the system zone)",
    })
  ),
  until: Schema.optional(
    Schema.String.annotate({
      description:
        "End of the window (exclusive), same forms as since; default now",
    })
  ),
  via: valuesOf("Gateways or local runtimes (openrouter, ollama, ...)"),
  worktree: valuesOf("Worktree paths"),
});

export type DxUsageInputType = typeof DxUsageInput.Type;

const ValuesSchema = Schema.Record(Schema.String, Schema.NullOr(Schema.Finite));

export const UsageRowSchema = Schema.Struct({
  facts: Schema.Int,
  key: Schema.String,
  values: ValuesSchema,
});

export const UsageOtherRowSchema = Schema.Struct({
  facts: Schema.Int,
  groups: Schema.Int,
  key: Schema.String,
  values: ValuesSchema,
});

export const UsageSeriesPointSchema = Schema.Struct({
  bucket: Schema.String,
  stacks: Schema.Array(UsageRowSchema),
  values: ValuesSchema,
});

export const UsageDisagreementCountSchema = Schema.Struct({
  count: Schema.Int,
  field: Schema.String,
  tool: Schema.NullOr(Schema.String),
});

export const UsageCoverageSchema = Schema.Struct({
  accountBuckets: UsageRowSchema,
  derivationVersion: Schema.Int,
  derivedAt: Schema.NullOr(IsoTimestampSchema),
  disagreements: Schema.Array(UsageDisagreementCountSchema),
  facts: Schema.Int,
  matched: Schema.Int,
  tools: Schema.Array(Schema.String),
  unpriced: Schema.Int,
  unresolved: Schema.Int,
  withoutTime: Schema.Int,
});

export const DxUsageOutput = Schema.Struct({
  asOf: IsoTimestampSchema,
  bucket: TimeBucketSchema,
  contractVersion: Schema.Literal(USAGE_CONTRACT_VERSION),
  coverage: UsageCoverageSchema,
  groupBy: Schema.NullOr(UsageDimensionSchema),
  groups: Schema.Array(UsageRowSchema),
  limit: Schema.Int,
  metrics: Schema.Array(UsageMetricSchema),
  notes: Schema.Array(Schema.String),
  other: Schema.NullOr(UsageOtherRowSchema),
  series: Schema.Array(UsageSeriesPointSchema),
  sortBy: UsageMetricSchema,
  stackBy: Schema.NullOr(UsageDimensionSchema),
  total: UsageRowSchema,
  unattributed: Schema.NullOr(UsageRowSchema),
  window: Schema.Struct({
    since: Schema.NullOr(IsoTimestampSchema),
    tz: Schema.String,
    until: Schema.NullOr(IsoTimestampSchema),
  }),
});

export type DxUsageOutputType = typeof DxUsageOutput.Type;

export const dxUsageContract = defineContract("dx_usage", {
  annotations: { idempotent: true, readOnly: true },
  description:
    "AI usage across tools, one deduplicated row per request: filter by tool, provider, via, model, effort, repo, branch, worktree or session, group by one of them or by day, week or month, and read tokens, requests and each money ledger (estimate, billed, tool's figure) separately",
  failure: QueryFailureSchema,
  input: DxUsageInput,
  output: DxUsageOutput,
});
