import type {
  DxMetric,
  MetricOutput,
  StoreSnapshot,
} from "../../contracts/services.js";
import { CONTRACT_VERSION } from "../../contracts/version.js";
import type { LedgerKind, TokenCategory } from "../../model/ai.js";
import type { MeasurementState, ValueMethod } from "../../model/common.js";
import type { ModuleDescriptor } from "../../model/descriptor.js";
import type { EvidenceId } from "../../model/ids.js";
import { DescriptorIdSchema, MetricIdSchema } from "../../model/ids.js";
import type {
  FindingCandidate,
  MetricDefinitionRef,
  MetricResult,
} from "../../model/metric.js";
import type { AiUsageAccount, LedgerTotal } from "./ledger.js";
import { accountAiUsage } from "./ledger.js";

export const AI_USAGE_METRIC_VERSION = "1.0.0" as const;

const definition = (
  id: string,
  unit: string,
  description: string
): MetricDefinitionRef => ({
  description,
  id: MetricIdSchema.make(id),
  unit,
  version: AI_USAGE_METRIC_VERSION,
});

const TOKEN_CATEGORIES: readonly TokenCategory[] = [
  "input",
  "cached-input",
  "cache-write",
  "output",
  "reasoning",
  "total",
];

const MONEY_LEDGERS: readonly {
  readonly ledger: LedgerKind;
  readonly description: string;
}[] = [
  { description: "Source-reported billed charge in USD.", ledger: "charge" },
  {
    description:
      "Source-reported metered usage value in USD; not necessarily billed.",
    ledger: "metered",
  },
  {
    description:
      "List-price estimate in USD (method=estimated); never a billed charge.",
    ledger: "list-price-estimate",
  },
  {
    description: "Source-reported USD amounts whose billing status is unknown.",
    ledger: "unallocated",
  },
];

const tokenDefinition = (category: TokenCategory) =>
  definition(
    `dx.ai-usage.tokens.${category}`,
    "tokens",
    `AI ${category} tokens after request/turn deduplication and source precedence; aggregate and unresolved ledgers excluded.`
  );

const moneyDefinition = (ledger: LedgerKind, description: string) =>
  definition(`dx.ai-usage.money.${ledger}`, "usd", description);

export const requestsDefinition = definition(
  "dx.ai-usage.requests",
  "requests",
  "Distinct AI requests/turns carrying usage after overlap collapse."
);

export const duplicatesDefinition = definition(
  "dx.ai-usage.duplicate-rows-collapsed",
  "rows",
  "Usage rows dropped because another source or emission reported the same request/turn with equal or higher precedence."
);

export const uncoveredDefinition = definition(
  "dx.ai-usage.uncovered-events",
  "events",
  "Usage-bearing events that could not be accounted (unverified semantics or unknown source)."
);

export const unresolvedDefinition = definition(
  "dx.ai-usage.unresolved-rows",
  "rows",
  "Overlap groups without a request/turn key kept unassigned instead of summed."
);

export const aggregateTokensDefinition = definition(
  "dx.ai-usage.alternative.tokens.total",
  "tokens",
  "Sum of all token categories in aggregate ledgers (usage export/provider buckets). Alternative view; never added to detail totals."
);

export const aiUsageDefinitions: readonly MetricDefinitionRef[] = [
  ...TOKEN_CATEGORIES.map(tokenDefinition),
  ...MONEY_LEDGERS.map((entry) =>
    moneyDefinition(entry.ledger, entry.description)
  ),
  requestsDefinition,
  duplicatesDefinition,
  uncoveredDefinition,
  unresolvedDefinition,
  aggregateTokensDefinition,
];

export const aiUsageDescriptor: ModuleDescriptor = {
  contractVersion: CONTRACT_VERSION,
  fixtureIds: [
    "b30/hook-db-entire-duplicate",
    "b30/sdk-csv-overlap",
    "b30/cursor-local-db-branch",
  ],
  gaps: [
    {
      code: "hook-usage-unverified",
      message:
        "Cursor stop-hook usage stays uncovered until its field semantics are verified (payload.semanticsVerified).",
    },
    {
      code: "cumulative-not-differenced",
      message:
        "Cumulative usage windows are never differenced; rows are summed only as emitted per request/turn.",
    },
    {
      code: "aggregate-branch-allocation",
      message:
        "Aggregate ledgers (usage CSV, provider buckets) carry no branch; they are alternatives, not branch totals.",
    },
  ],
  id: DescriptorIdSchema.make("dx.metrics.ai-usage"),
  kind: "metric",
  owner: "B30",
  readiness: "ready",
  requiredInputs: ["ai.usage", "ai.turn"],
  supportedFields: [
    ...TOKEN_CATEGORIES.map((category) => `tokens.${category}`),
    ...MONEY_LEDGERS.map((entry) => `money.${entry.ledger}`),
    "requests",
    "duplicates",
    "uncovered",
    "unresolved",
    "alternative-ledgers",
  ],
  version: AI_USAGE_METRIC_VERSION,
};

interface Context {
  readonly account: AiUsageAccount;
  readonly asOf: string;
  readonly snapshot: StoreSnapshot;
}

const stateFor = (
  methods: readonly ValueMethod[],
  account: AiUsageAccount
): MeasurementState => {
  if (methods.includes("estimated")) {
    return "estimated";
  }

  return account.uncovered.length > 0 || account.unresolved.length > 0
    ? "partial"
    : "measured";
};

const allEvidence = (account: AiUsageAccount): EvidenceId[] =>
  [...new Set(account.totals.flatMap((total) => total.evidenceIds))].toSorted();

const result = (
  ctx: Context,
  def: MetricDefinitionRef,
  fields: Pick<
    MetricResult,
    "evidenceIds" | "measurement" | "method" | "reason" | "value"
  >
): MetricResult => ({
  asOf: ctx.asOf,
  attribution: fields.value === null ? "not-applicable" : "strong",
  checkpoint: null,
  coverage: ctx.snapshot.coverage,
  definition: def,
  denominator: null,
  metricId: def.id,
  numerator: null,
  unit: def.unit,
  ...fields,
});

const fromTotal = (
  ctx: Context,
  def: MetricDefinitionRef,
  total: LedgerTotal | undefined,
  missing: string
): MetricResult => {
  if (total === undefined) {
    return result(ctx, def, {
      evidenceIds: [],
      measurement: "unavailable",
      method: "source-reported",
      reason: missing,
      value: null,
    });
  }

  const method = total.methods.includes("estimated")
    ? "estimated"
    : (total.methods[0] ?? "source-reported");

  return result(ctx, def, {
    evidenceIds: total.evidenceIds,
    measurement: stateFor(total.methods, ctx.account),
    method,
    reason: null,
    value: total.value,
  });
};

const tokenResults = (ctx: Context): MetricResult[] =>
  TOKEN_CATEGORIES.map((category) =>
    fromTotal(
      ctx,
      tokenDefinition(category),
      ctx.account.totals.find(
        (total) => total.ledger === "tokens" && total.category === category
      ),
      `no selected source reported ${category} tokens`
    )
  );

const moneyResults = (ctx: Context): MetricResult[] =>
  MONEY_LEDGERS.map((entry) =>
    fromTotal(
      ctx,
      moneyDefinition(entry.ledger, entry.description),
      ctx.account.totals.find(
        (total) =>
          total.ledger === entry.ledger &&
          (total.currency === "USD" || total.currency === null)
      ),
      `no selected source reported a ${entry.ledger} amount in USD`
    )
  );

const countResult = (
  ctx: Context,
  def: MetricDefinitionRef,
  value: number,
  evidenceIds: readonly EvidenceId[]
): MetricResult =>
  ctx.account.usageEvents === 0
    ? result(ctx, def, {
        evidenceIds: [],
        measurement: "unavailable",
        method: "derived",
        reason: "snapshot contains no AI usage events",
        value: null,
      })
    : result(ctx, def, {
        evidenceIds,
        measurement: "measured",
        method: "derived",
        reason: null,
        value,
      });

const aggregateResult = (ctx: Context): MetricResult => {
  const totals = ctx.account.alternatives.flatMap((alt) =>
    alt.totals.filter(
      (total) => total.ledger === "tokens" && total.category !== "total"
    )
  );

  if (totals.length === 0) {
    return result(ctx, aggregateTokensDefinition, {
      evidenceIds: [],
      measurement: "unavailable",
      method: "source-reported",
      reason: "no aggregate usage ledger selected",
      value: null,
    });
  }

  return result(ctx, aggregateTokensDefinition, {
    evidenceIds: [
      ...new Set(totals.flatMap((total) => total.evidenceIds)),
    ].toSorted(),
    measurement: "measured",
    method: "source-reported",
    reason: null,
    value: totals.reduce((sum, total) => sum + total.value, 0),
  });
};

const findings = (account: AiUsageAccount): FindingCandidate[] =>
  account.uncovered.length === 0
    ? []
    : [
        {
          evidenceIds: account.uncovered.map((entry) => entry.evidenceId),
          experiment: null,
          findingId: "dx.ai-usage.uncovered",
          metricIds: [uncoveredDefinition.id],
          rank: 1,
          severity: "low",
          summary: `${String(account.uncovered.length)} AI usage event(s) could not be accounted; totals are partial.`,
        },
      ];

export const computeAiUsage = (snapshot: StoreSnapshot): MetricOutput => {
  const account = accountAiUsage(snapshot.events);

  const ctx: Context = {
    account,
    asOf: snapshot.manifest.createdAt,
    snapshot,
  };

  return {
    findings: findings(account),
    results: [
      ...tokenResults(ctx),
      ...moneyResults(ctx),
      countResult(
        ctx,
        requestsDefinition,
        account.requestCount,
        allEvidence(account)
      ),
      countResult(
        ctx,
        duplicatesDefinition,
        account.duplicateRowsCollapsed,
        account.groups
          .filter((group) => group.resolution === "collapsed")
          .flatMap((group) => group.memberEvidenceIds)
      ),
      countResult(
        ctx,
        uncoveredDefinition,
        account.uncovered.length,
        account.uncovered.map((entry) => entry.evidenceId)
      ),
      countResult(
        ctx,
        unresolvedDefinition,
        account.groups.filter((group) => group.resolution === "unresolved")
          .length,
        account.unresolved.flatMap((total) => total.evidenceIds)
      ),
      aggregateResult(ctx),
    ],
  };
};

export const aiUsageMetric: DxMetric = {
  compute: computeAiUsage,
  definitions: aiUsageDefinitions,
  descriptor: aiUsageDescriptor,
};
