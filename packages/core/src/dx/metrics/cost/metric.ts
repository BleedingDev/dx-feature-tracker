import type {
  DxMetric,
  MetricOutput,
  StoreSnapshot,
} from "../../contracts/services.js";
import { CONTRACT_VERSION } from "../../contracts/version.js";
import type {
  AttributionState,
  MeasurementState,
  ValueMethod,
} from "../../model/common.js";
import type { SourceCoverage } from "../../model/coverage.js";
import type { ModuleDescriptor } from "../../model/descriptor.js";
import {
  DescriptorIdSchema,
  EvidenceIdSchema,
  MetricIdSchema,
} from "../../model/ids.js";
import type { MetricDefinitionRef, MetricResult } from "../../model/metric.js";
import { assignedBranches } from "../ai-usage/ledger.js";
import type { PriceTable, UnpricedReason } from "./price-table.js";
import { priceMethodLabel, priceReading } from "./price-table.js";
import type {
  ExtractedReadings,
  MoneyLedger,
  MoneyReading,
  ReadingBase,
  TokenReading,
} from "./readings.js";
import {
  extractReadings,
  MoneyLedgerSchema,
  selectPreferredSource,
} from "./readings.js";

export const COST_METRIC_VERSION = "1.0.0" as const;

const definition = (id: string, description: string): MetricDefinitionRef => ({
  description,
  id: MetricIdSchema.make(id),
  unit: "USD",
  version: COST_METRIC_VERSION,
});

export const chargeDefinition = definition(
  "dx.cost.charge.usd",
  "Billed charges reported by the source (usage export or dashboard). Never includes metered, estimated or allocated amounts."
);

export const meteredDefinition = definition(
  "dx.cost.metered.usd",
  "Source-reported metered value (for example Cursor local usageData cents or Included usage rows). Not a billed charge."
);

export const sourceEstimateDefinition = definition(
  "dx.cost.list-price-estimate.source.usd",
  "List-price estimate computed by the source client itself (for example Claude Code costUSD). An estimate, never a charge."
);

export const priceTableEstimateDefinition = definition(
  "dx.cost.list-price-estimate.price-table.usd",
  "Recorder estimate: source-reported tokens times a selected versioned price table. Method discriminator price-table:<id>@<version> is in reason."
);

export const subscriptionAllocationDefinition = definition(
  "dx.cost.subscription-allocation.usd",
  "Share of a user-declared subscription amount allocated by observed usage basis in the plan period. Derived, not billed per request."
);

export const unallocatedDefinition = definition(
  "dx.cost.unallocated.usd",
  "Source money amounts whose ledger (billed, included or not charged) the source does not state."
);

export const costDefinitions: readonly MetricDefinitionRef[] = [
  chargeDefinition,
  meteredDefinition,
  sourceEstimateDefinition,
  priceTableEstimateDefinition,
  subscriptionAllocationDefinition,
  unallocatedDefinition,
];

export interface SubscriptionPlan {
  readonly amountUsd: number;
  readonly basis: "requests" | "tokens";
  readonly periodFrom: string;
  readonly periodTo: string;
  readonly periodUsageTotal: number | null;
  readonly planId: string;
}

export interface CostOptions {
  readonly priceTable: PriceTable | null;
  readonly subscription: SubscriptionPlan | null;
}

export const NO_COST_OPTIONS: CostOptions = {
  priceTable: null,
  subscription: null,
};

interface ResultSpec {
  readonly attribution: AttributionState;
  readonly coverage: readonly SourceCoverage[];
  readonly def: MetricDefinitionRef;
  readonly denominator: number | null;
  readonly evidence: readonly ReadingBase[];
  readonly measurement: MeasurementState;
  readonly method: ValueMethod;
  readonly numerator: number | null;
  readonly reason: string | null;
  readonly value: number | null;
}

interface GroupContext {
  readonly asOf: string;
  readonly coverage: readonly SourceCoverage[];
}

const round = (value: number) => Math.round(value * 1_000_000) / 1_000_000;

const result = (ctx: GroupContext, spec: ResultSpec): MetricResult => ({
  asOf: ctx.asOf,
  attribution: spec.attribution,
  checkpoint: null,
  coverage: spec.coverage,
  definition: spec.def,
  denominator: spec.denominator,
  evidenceIds: [...new Set(spec.evidence.map((item) => item.eventId))].map(
    (id) => EvidenceIdSchema.make(id)
  ),
  measurement: spec.measurement,
  method: spec.method,
  metricId: spec.def.id,
  numerator: spec.numerator,
  reason: spec.reason,
  unit: spec.def.unit,
  value: spec.value === null ? null : round(spec.value),
});

const attributionOf = (items: readonly ReadingBase[]): AttributionState => {
  const assigned = items.filter((item) => item.branch !== null).length;

  if (items.length === 0) {
    return "not-applicable";
  }

  if (assigned === items.length) {
    return "strong";
  }

  return assigned === 0 ? "unassigned" : "provisional";
};

const coverageFor = (
  ctx: GroupContext,
  items: readonly ReadingBase[]
): readonly SourceCoverage[] => {
  const adapters = new Set(items.map((item) => item.adapterId));
  const matched = ctx.coverage.filter((cov) => adapters.has(cov.adapterId));

  return matched.length > 0 ? matched : ctx.coverage;
};

const sum = (items: readonly MoneyReading[]) =>
  items.reduce((total, item) => total + item.usd, 0);

const ABSENT_REASON: Readonly<Record<MoneyLedger, string>> = {
  charge:
    "No billed charge in the selected sources; import a Cursor usage CSV or dashboard export. Not zero.",
  "list-price-estimate":
    "No source-computed list-price estimate in the selected sources.",
  metered: "No source-reported metered amount in the selected sources.",
  unallocated: "No source amount with an unstated ledger.",
};

const LEDGER_SPEC: Readonly<
  Record<
    MoneyLedger,
    {
      readonly def: MetricDefinitionRef;
      readonly measurement: MeasurementState;
      readonly method: ValueMethod;
      readonly note: string | null;
    }
  >
> = {
  charge: {
    def: chargeDefinition,
    measurement: "measured",
    method: "source-reported",
    note: null,
  },
  "list-price-estimate": {
    def: sourceEstimateDefinition,
    measurement: "estimated",
    method: "estimated",
    note: "Source-computed list-price estimate, not a charge.",
  },
  metered: {
    def: meteredDefinition,
    measurement: "measured",
    method: "source-reported",
    note: "Metered value, not a billed charge.",
  },
  unallocated: {
    def: unallocatedDefinition,
    measurement: "partial",
    method: "source-reported",
    note: "Source did not state whether this amount was billed.",
  },
};

const alternativesNote = (alternatives: readonly string[]) =>
  alternatives.length > 0
    ? `Alternative overlapping source(s) not summed: ${alternatives.join(", ")}.`
    : null;

const ledgerResult = (
  ctx: GroupContext,
  readings: readonly MoneyReading[],
  ledger: MoneyLedger,
  rejected: number,
  superseded: readonly MoneyReading[]
): MetricResult => {
  const selection = selectPreferredSource(
    readings.filter((item) => item.ledger === ledger)
  );

  const items = selection.kept;
  const spec = LEDGER_SPEC[ledger];

  const alternatives = [
    ...new Set([
      ...selection.alternatives,
      ...superseded.flatMap((item) =>
        item.ledger === ledger ? [item.sourceKind ?? "unknown"] : []
      ),
    ]),
  ];

  const supersededNote = alternativesNote(alternatives);

  if (items.length === 0) {
    return result(ctx, {
      attribution: "not-applicable",
      coverage: ctx.coverage,
      def: spec.def,
      denominator: null,
      evidence: [],
      measurement: "unavailable",
      method: spec.method,
      numerator: null,
      reason: [
        rejected > 0 && ledger === "charge"
          ? `${ABSENT_REASON[ledger]} ${String(rejected)} money row(s) excluded (non-USD, unknown unit or not charged).`
          : ABSENT_REASON[ledger],
        supersededNote,
      ]
        .filter((part) => part !== null)
        .join(" "),
      value: null,
    });
  }

  const rejectedNote =
    rejected > 0
      ? `${String(rejected)} money row(s) excluded (non-USD, unknown unit or not charged).`
      : null;

  const reason =
    [spec.note, rejectedNote, supersededNote]
      .filter((part) => part !== null)
      .join(" ") || null;

  return result(ctx, {
    attribution: attributionOf(items),
    coverage: coverageFor(ctx, items),
    def: spec.def,
    denominator: null,
    evidence: items,
    measurement:
      rejected > 0 && spec.measurement === "measured"
        ? "partial"
        : spec.measurement,
    method: spec.method,
    numerator: items.length,
    reason,
    value: sum(items),
  });
};

const tally = (reasons: readonly UnpricedReason[]) => {
  const counts = new Map<string, number>();

  for (const reason of reasons) {
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }

  return [...counts.entries()]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([reason, count]) => `${reason}=${String(count)}`)
    .join(", ");
};

const priceMeasurement = (
  priced: number,
  unpriced: number
): MeasurementState => {
  if (priced === 0) {
    return "unavailable";
  }

  return unpriced > 0 ? "partial" : "estimated";
};

const priceTableResult = (
  ctx: GroupContext,
  tokens: readonly TokenReading[],
  table: PriceTable | null
): MetricResult => {
  const selection = selectPreferredSource(
    tokens.filter((item) => Object.keys(item.tokens).length > 0)
  );

  const withTokens = selection.kept;

  const base = {
    def: priceTableEstimateDefinition,
    method: "estimated" as const,
  };

  if (table === null) {
    return result(ctx, {
      ...base,
      attribution: "not-applicable",
      coverage: ctx.coverage,
      denominator: null,
      evidence: [],
      measurement: "unavailable",
      numerator: null,
      reason:
        "No versioned price table selected; the recorder ships no default prices.",
      value: null,
    });
  }

  const label = `method=${priceMethodLabel(table)}`;

  if (withTokens.length === 0) {
    return result(ctx, {
      ...base,
      attribution: "not-applicable",
      coverage: ctx.coverage,
      denominator: 0,
      evidence: [],
      measurement: "unavailable",
      numerator: 0,
      reason: `${label}; no source-reported token readings in the selected sources.`,
      value: null,
    });
  }

  const priced: TokenReading[] = [];
  const unpriced: UnpricedReason[] = [];
  let usd = 0;

  for (const reading of withTokens) {
    const outcome = priceReading(reading, table);

    if (outcome.kind === "priced") {
      priced.push(reading);
      usd += outcome.usd;
    } else {
      unpriced.push(outcome.reason);
    }
  }

  const unpricedNote =
    unpriced.length > 0 ? `; unpriced readings: ${tally(unpriced)}` : "";

  const altNote = alternativesNote(selection.alternatives);

  return result(ctx, {
    ...base,
    attribution: attributionOf(priced),
    coverage: coverageFor(ctx, withTokens),
    denominator: withTokens.length,
    evidence: priced,
    measurement: priceMeasurement(priced.length, unpriced.length),
    numerator: priced.length,
    reason: `${label}; estimate from source-reported tokens, not a charge${unpricedNote}.${altNote === null ? "" : ` ${altNote}`}`,
    value: priced.length === 0 ? null : usd,
  });
};

const inPeriod = (reading: ReadingBase, plan: SubscriptionPlan) => {
  if (reading.occurredAt === null) {
    return false;
  }

  const at = Date.parse(reading.occurredAt);

  return (
    Number.isFinite(at) &&
    at >= Date.parse(plan.periodFrom) &&
    at < Date.parse(plan.periodTo)
  );
};

const basisOf = (reading: TokenReading, plan: SubscriptionPlan) => {
  if (plan.basis === "requests") {
    return reading.requests;
  }

  const { total, ...rest } = reading.tokens;

  const detailed = Object.values(rest).reduce(
    (acc, value) => acc + (value ?? 0),
    0
  );

  return detailed > 0 ? detailed : (total ?? null);
};

export interface SubscriptionBasis {
  readonly items: TokenReading[];
  readonly total: number;
}

export const subscriptionBasisTotal = (
  tokens: readonly TokenReading[],
  plan: SubscriptionPlan
): SubscriptionBasis => {
  const eligible = tokens.flatMap((reading) => {
    const basis = basisOf(reading, plan);

    return basis !== null && basis > 0 && inPeriod(reading, plan)
      ? [{ ...reading, basis }]
      : [];
  });

  const selected = selectPreferredSource(eligible).kept;

  return {
    items: [...selected],
    total: selected.reduce((acc, item) => acc + item.basis, 0),
  };
};

const subscriptionResult = (
  ctx: GroupContext,
  tokens: readonly TokenReading[],
  plan: SubscriptionPlan | null,
  denominator: number | null
): MetricResult => {
  const base = {
    def: subscriptionAllocationDefinition,
    method: "derived" as const,
  };

  const unavailable = (reason: string) =>
    result(ctx, {
      ...base,
      attribution: "not-applicable",
      coverage: ctx.coverage,
      denominator: null,
      evidence: [],
      measurement: "unavailable",
      numerator: null,
      reason,
      value: null,
    });

  if (plan === null) {
    return unavailable(
      "No subscription plan declared; allocation needs a user-declared plan amount and period."
    );
  }

  if (denominator === null) {
    return unavailable(
      `plan=${plan.planId}; branch-scoped snapshot needs periodUsageTotal (whole-period ${plan.basis}) to allocate.`
    );
  }

  const own = subscriptionBasisTotal(tokens, plan);

  if (denominator <= 0) {
    return unavailable(
      `plan=${plan.planId}; no observed ${plan.basis} in the plan period to allocate by.`
    );
  }

  return result(ctx, {
    ...base,
    attribution: attributionOf(own.items),
    coverage: coverageFor(ctx, own.items),
    denominator,
    evidence: own.items,
    measurement: "estimated",
    numerator: own.total,
    reason: `plan=${plan.planId}; basis=${plan.basis}; period=${plan.periodFrom}..${plan.periodTo}; allocation of a flat subscription, not a per-request charge.`,
    value: (plan.amountUsd * own.total) / denominator,
  });
};

const computeGroup = (
  ctx: GroupContext,
  readings: ExtractedReadings,
  options: CostOptions,
  subscriptionDenominator: number | null,
  superseded: readonly MoneyReading[] = []
): MetricResult[] => {
  const rejected = readings.rejections.length;

  return [
    ledgerResult(ctx, readings.money, "charge", rejected, superseded),
    ledgerResult(ctx, readings.money, "metered", rejected, superseded),
    ledgerResult(ctx, readings.money, "list-price-estimate", 0, superseded),
    priceTableResult(ctx, readings.tokens, options.priceTable),
    subscriptionResult(
      ctx,
      readings.tokens,
      options.subscription,
      subscriptionDenominator
    ),
    ledgerResult(ctx, readings.money, "unallocated", 0, superseded),
  ];
};

const snapshotDenominator = (
  snapshot: StoreSnapshot,
  readings: ExtractedReadings,
  plan: SubscriptionPlan | null
) => {
  if (plan === null) {
    return null;
  }

  if (plan.periodUsageTotal !== null) {
    return plan.periodUsageTotal;
  }

  return snapshot.manifest.selector.branch === null
    ? subscriptionBasisTotal(readings.tokens, plan).total
    : null;
};

export const computeCost = (
  snapshot: StoreSnapshot,
  options: CostOptions = NO_COST_OPTIONS
): MetricOutput => {
  const readings = extractReadings(snapshot.events);

  const ctx: GroupContext = {
    asOf: snapshot.manifest.createdAt,
    coverage: snapshot.coverage,
  };

  return {
    findings: [],
    results: computeGroup(
      ctx,
      readings,
      options,
      snapshotDenominator(snapshot, readings, options.subscription)
    ),
  };
};

export interface BranchCost {
  readonly branch: string | null;
  readonly results: readonly MetricResult[];
}

const byBranch = <T extends ReadingBase>(items: readonly T[]) => {
  const groups = new Map<string | null, T[]>();

  for (const item of items) {
    const list = groups.get(item.branch) ?? [];
    list.push(item);
    groups.set(item.branch, list);
  }

  return groups;
};

export const costByBranch = (
  snapshot: StoreSnapshot,
  options: CostOptions = NO_COST_OPTIONS
): readonly BranchCost[] => {
  const readings = extractReadings(snapshot.events);

  const ctx: GroupContext = {
    asOf: snapshot.manifest.createdAt,
    coverage: snapshot.coverage,
  };

  const assigned = assignedBranches(snapshot.events);

  const branchOf = (eventId: string, own: string | null) =>
    assigned.has(eventId) ? (assigned.get(eventId) ?? null) : own;

  const attribute = <T extends ReadingBase>(items: readonly T[]): T[] =>
    items.map((item) => ({
      ...item,
      branch: branchOf(item.eventId, item.branch),
    }));

  const selectedMoney = MoneyLedgerSchema.literals.flatMap(
    (ledger) =>
      selectPreferredSource(
        readings.money.filter((item) => item.ledger === ledger)
      ).kept
  );

  const kept = new Set(selectedMoney);
  const plan = options.subscription;
  const money = byBranch(attribute(selectedMoney));

  const superseded = byBranch(
    attribute(readings.money.filter((item) => !kept.has(item)))
  );

  const tokens = byBranch(attribute(readings.tokens));

  const denominator =
    plan === null
      ? null
      : (plan.periodUsageTotal ??
        [...tokens.values()].reduce(
          (acc, group) => acc + subscriptionBasisTotal(group, plan).total,
          0
        ));

  const branchOfEvent = new Map<string, string | null>(
    snapshot.events.map((event) => [
      event.eventId,
      branchOf(event.eventId, event.context.branch),
    ])
  );

  const branches = new Set<string | null>([
    ...money.keys(),
    ...superseded.keys(),
    ...tokens.keys(),
  ]);

  return [...branches]
    .toSorted((a, b) => (a ?? "￿").localeCompare(b ?? "￿"))
    .map((branch) => ({
      branch,
      results: computeGroup(
        ctx,
        {
          collapsedDuplicates: 0,
          money: money.get(branch) ?? [],
          rejections: readings.rejections.filter(
            (item) => branchOfEvent.get(item.eventId) === branch
          ),
          tokens: tokens.get(branch) ?? [],
        },
        options,
        denominator,
        superseded.get(branch) ?? []
      ),
    }));
};

export const costDescriptor: ModuleDescriptor = {
  contractVersion: CONTRACT_VERSION,
  fixtureIds: [
    "b31-cursor-mixed-ledgers",
    "b31-price-table-v1",
    "b31-subscription-plan",
  ],
  gaps: [
    {
      code: "no-default-price-table",
      message:
        "The recorder ships no built-in prices; price-table estimates need an explicitly selected versioned table and are otherwise unavailable.",
    },
    {
      code: "charge-needs-billing-export",
      message:
        "Billed charges come only from an imported Cursor usage CSV/dashboard export; local Cursor DB cents are reported as metered, never as charges.",
    },
    {
      code: "hooks-stop-raw-usage",
      message:
        "Cursor stop-hook rawUsage is excluded until its semantics are verified; it never contributes tokens or money.",
    },
    {
      code: "usage-export-branch-unassigned",
      message:
        "Usage export rows carry no branch; their charges stay in the unassigned branch bucket until time-window correlation assigns them.",
    },
  ],
  id: DescriptorIdSchema.make("dx.metric.cost"),
  kind: "metric",
  owner: "B31",
  readiness: "degraded",
  requiredInputs: ["ai.usage", "ai.turn"],
  supportedFields: costDefinitions.map((def) => def.id),
  version: COST_METRIC_VERSION,
};

export const makeCostMetric = (options: CostOptions): DxMetric => ({
  compute: (snapshot) => computeCost(snapshot, options),
  definitions: costDefinitions,
  descriptor: costDescriptor,
});

export const costMetric: DxMetric = makeCostMetric(NO_COST_OPTIONS);
