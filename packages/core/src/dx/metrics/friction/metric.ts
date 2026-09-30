import type {
  DxMetric,
  MetricOutput,
  StoreSnapshot,
} from "../../contracts/services.js";
import { CONTRACT_VERSION } from "../../contracts/version.js";
import type { AttributionState, MeasurementState } from "../../model/common.js";
import type { SourceCoverage } from "../../model/coverage.js";
import type { ModuleDescriptor } from "../../model/descriptor.js";
import type { DxEventEnvelope } from "../../model/event.js";
import type { EvidenceId, MetricId } from "../../model/ids.js";
import {
  DescriptorIdSchema,
  EvidenceIdSchema,
  MetricIdSchema,
} from "../../model/ids.js";
import type {
  FindingCandidate,
  FindingSeverity,
  MetricDefinitionRef,
  MetricResult,
} from "../../model/metric.js";
import type { FrictionSignals } from "./signals.js";
import { extractFrictionSignals } from "./signals.js";
import {
  count,
  FRICTION_TEMPLATES,
  percent,
  renderTemplate,
} from "./templates.js";

export const FRICTION_METRIC_VERSION = "1.0.0" as const;

export const FRICTION_THRESHOLDS = {
  commandRepeatedFailures: 2,
  fileReworkEdits: 5,
  fileReworkEditsHigh: 10,
  maxFindings: 10,
  testFailureRate: 0.5,
  testFailureRateMinRuns: 3,
  testRepeatedFailures: 2,
  toolFailureRate: 0.2,
  toolFailureRateMinFailures: 3,
} as const;

const definition = (
  id: string,
  unit: string,
  description: string
): MetricDefinitionRef => ({
  description,
  id: MetricIdSchema.make(id),
  unit,
  version: FRICTION_METRIC_VERSION,
});

export const testRunsDefinition = definition(
  "dx.friction.test-runs",
  "runs",
  "Local test runs (test.result events) observed in the snapshot."
);

export const testFailuresDefinition = definition(
  "dx.friction.test-failures",
  "runs",
  "Local test runs whose reported counts, status or exit outcome show a failure."
);

export const testFailureRateDefinition = definition(
  "dx.friction.test-failure-rate",
  "ratio",
  "Failed local test runs divided by test runs with a known outcome."
);

export const toolCallFailureRateDefinition = definition(
  "dx.friction.tool-call-failure-rate",
  "ratio",
  "Failed agent tool calls (postToolUseFailure or failed status) divided by observed agent tool calls."
);

export const failedCommandsDefinition = definition(
  "dx.friction.failed-commands",
  "runs",
  "Captured command runs with a non-zero exit code or spawn error."
);

export const reworkedFilesDefinition = definition(
  "dx.friction.reworked-files",
  "files",
  `Files edited by the agent at least ${FRICTION_THRESHOLDS.fileReworkEdits} times (observable rework).`
);

export const frictionDefinitions: readonly MetricDefinitionRef[] = [
  testRunsDefinition,
  testFailuresDefinition,
  testFailureRateDefinition,
  toolCallFailureRateDefinition,
  failedCommandsDefinition,
  reworkedFilesDefinition,
];

export const FRICTION_FIXTURE_IDS = [
  "b34-repeated-failures",
  "b34-clean-branch",
  "b34-no-evidence",
] as const;

export const frictionDescriptor: ModuleDescriptor = {
  contractVersion: CONTRACT_VERSION,
  fixtureIds: [...FRICTION_FIXTURE_IDS],
  gaps: [
    {
      code: "no-causal-savings",
      message:
        "Findings cite repeated evidence and suggest an inspectable experiment; they never estimate time or money saved.",
    },
    {
      code: "test-overlap",
      message:
        "When more than one adapter reports test results for the same run (local-test report and shell-command exit), runs may be double counted; the result is then marked partial/provisional.",
    },
    {
      code: "rework-proxy",
      message:
        "Rework is only the count of agent edit events per file (ai.tool-edit); human rewrites and line-level churn are not observed here.",
    },
  ],
  id: DescriptorIdSchema.make("dx.metric.friction"),
  kind: "metric",
  owner: "B34",
  readiness: "ready",
  requiredInputs: ["test.result", "command.run", "ai.tool-edit", "other"],
  supportedFields: [
    "test.result.status",
    "test.result.outcome",
    "test.result.failed",
    "test.result.errors",
    "test.result.failingTests",
    "command.run.exitCode",
    "command.run.spawnError",
    "hook.toolCall",
    "hook.hookEvent",
    "hook.status",
    "hook.toolName",
    "ai.tool-edit.filePath",
  ],
  version: FRICTION_METRIC_VERSION,
};

const evidenceOf = (
  events: readonly DxEventEnvelope[]
): readonly EvidenceId[] =>
  [...new Set(events.map((event) => event.eventId))]
    .toSorted()
    .map((id) => EvidenceIdSchema.make(id));

const coverageFor = (
  snapshot: StoreSnapshot,
  events: readonly DxEventEnvelope[]
): readonly SourceCoverage[] => {
  const adapters = new Set(events.map((event) => event.adapterId));

  return snapshot.coverage.filter((item) => adapters.has(item.adapterId));
};

const incompleteCoverage = (coverage: readonly SourceCoverage[]): boolean =>
  coverage.some((item) => item.state !== "complete");

interface ResultInput {
  readonly attribution?: AttributionState;
  readonly definition: MetricDefinitionRef;
  readonly denominator?: number | null;
  readonly events: readonly DxEventEnvelope[];
  readonly numerator?: number | null;
  readonly partialReason?: string | null;
  readonly unavailableReason: string;
  readonly value: number | null;
}

const makeResult = (
  snapshot: StoreSnapshot,
  input: ResultInput
): MetricResult => {
  const coverage = coverageFor(snapshot, input.events);
  const unavailable = input.value === null;

  const coverageGap = incompleteCoverage(coverage)
    ? "source coverage is incomplete"
    : null;

  const partialReason = input.partialReason ?? coverageGap;
  let measurement: MeasurementState = "measured";

  if (unavailable) {
    measurement = "unavailable";
  } else if (partialReason !== null) {
    measurement = "partial";
  }

  return {
    asOf: snapshot.manifest.createdAt,
    attribution: input.attribution ?? "not-applicable",
    checkpoint: null,
    coverage: unavailable ? snapshot.coverage : coverage,
    definition: input.definition,
    denominator: input.denominator ?? null,
    evidenceIds: evidenceOf(input.events),
    measurement,
    method: "observed",
    metricId: input.definition.id,
    numerator: input.numerator ?? null,
    reason: unavailable ? input.unavailableReason : partialReason,
    unit: input.definition.unit,
    value: input.value,
  };
};

const groupBy = <T>(
  items: readonly T[],
  keyOf: (item: T) => string
): Map<string, T[]> => {
  const groups = new Map<string, T[]>();

  for (const item of items) {
    const key = keyOf(item);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }

  return groups;
};

const branchSuffix = (events: readonly DxEventEnvelope[]): string => {
  const branches = new Set(events.map((event) => event.context.branch));

  if (branches.size !== 1) {
    return "";
  }

  const [branch] = branches;

  return branch === null || branch === undefined ? "" : ` on ${branch}`;
};

interface Draft {
  readonly evidence: readonly DxEventEnvelope[];
  readonly experiment: string;
  readonly findingId: string;
  readonly metricIds: readonly MetricId[];
  readonly severity: FindingSeverity;
  readonly summary: string;
  readonly weight: number;
}

const compareText = (a: string, b: string): number => {
  if (a === b) {
    return 0;
  }

  return a < b ? -1 : 1;
};

const SEVERITY_ORDER: Readonly<Record<FindingSeverity, number>> = {
  high: 3,
  info: 0,
  low: 1,
  medium: 2,
};

const testFindings = (signals: FrictionSignals): Draft[] => {
  const drafts: Draft[] = [];
  const perTest = new Map<string, DxEventEnvelope[]>();

  for (const run of signals.testRuns) {
    for (const name of new Set(run.failingTests)) {
      perTest.set(name, [...(perTest.get(name) ?? []), run.event]);
    }
  }

  for (const [test, events] of perTest) {
    if (events.length >= FRICTION_THRESHOLDS.testRepeatedFailures) {
      const values = {
        branchSuffix: branchSuffix(events),
        count: count(events.length),
        test,
      };

      drafts.push({
        evidence: events,
        experiment: renderTemplate(
          FRICTION_TEMPLATES.testRepeatedFailure.experiment,
          values
        ),
        findingId: `friction.test-repeated-failure:${test}`,
        metricIds: [testFailuresDefinition.id],
        severity: "high",
        summary: renderTemplate(
          FRICTION_TEMPLATES.testRepeatedFailure.summary,
          values
        ),
        weight: events.length,
      });
    }
  }

  const known = signals.testRuns.filter((run) => run.outcome !== "unknown");
  const failed = known.filter((run) => run.outcome === "failed");
  const rate = known.length === 0 ? null : failed.length / known.length;

  if (
    rate !== null &&
    known.length >= FRICTION_THRESHOLDS.testFailureRateMinRuns &&
    rate >= FRICTION_THRESHOLDS.testFailureRate
  ) {
    const events = failed.map((run) => run.event);

    const values = {
      branchSuffix: branchSuffix(events),
      failures: count(failed.length),
      rate: percent(rate),
      runs: count(known.length),
    };

    drafts.push({
      evidence: events,
      experiment: renderTemplate(
        FRICTION_TEMPLATES.testFailureRate.experiment,
        values
      ),
      findingId: "friction.test-failure-rate",
      metricIds: [testFailureRateDefinition.id],
      severity: "medium",
      summary: renderTemplate(
        FRICTION_TEMPLATES.testFailureRate.summary,
        values
      ),
      weight: failed.length,
    });
  }

  return drafts;
};

const toolFindings = (signals: FrictionSignals): Draft[] => {
  const failed = signals.toolCalls.filter((call) => call.failed);
  const calls = signals.toolCalls.length;
  const rate = calls === 0 ? null : failed.length / calls;

  if (
    rate === null ||
    failed.length < FRICTION_THRESHOLDS.toolFailureRateMinFailures ||
    rate < FRICTION_THRESHOLDS.toolFailureRate
  ) {
    return [];
  }

  const byTool = [
    ...groupBy(failed, (call) => call.toolName ?? "").entries(),
  ].toSorted((a, b) => b[1].length - a[1].length || compareText(a[0], b[0]));

  const topTool = byTool[0]?.[0] ?? "";
  const events = failed.map((call) => call.event);

  const values = {
    branchSuffix: branchSuffix(events),
    calls: count(calls),
    failures: count(failed.length),
    rate: percent(rate),
    tool: topTool === "" ? null : topTool,
  };

  return [
    {
      evidence: events,
      experiment: renderTemplate(
        FRICTION_TEMPLATES.toolFailureRate.experiment,
        values
      ),
      findingId: "friction.tool-failure-rate",
      metricIds: [toolCallFailureRateDefinition.id],
      severity: "medium",
      summary: renderTemplate(
        FRICTION_TEMPLATES.toolFailureRate.summary,
        values
      ),
      weight: failed.length,
    },
  ];
};

const commandFindings = (signals: FrictionSignals): Draft[] =>
  [...groupBy(signals.commandFailures, (item) => item.commandKey)].flatMap(
    ([command, items]): Draft[] => {
      if (items.length < FRICTION_THRESHOLDS.commandRepeatedFailures) {
        return [];
      }

      const events = items.map((item) => item.event);

      const values = {
        branchSuffix: branchSuffix(events),
        command,
        count: count(items.length),
      };

      return [
        {
          evidence: events,
          experiment: renderTemplate(
            FRICTION_TEMPLATES.commandRepeatedFailure.experiment,
            values
          ),
          findingId: `friction.command-repeated-failure:${command}`,
          metricIds: [failedCommandsDefinition.id],
          severity: "medium",
          summary: renderTemplate(
            FRICTION_TEMPLATES.commandRepeatedFailure.summary,
            values
          ),
          weight: items.length,
        },
      ];
    }
  );

const reworkGroups = (signals: FrictionSignals) =>
  [...groupBy(signals.fileEdits, (edit) => edit.filePath)].filter(
    ([, edits]) => edits.length >= FRICTION_THRESHOLDS.fileReworkEdits
  );

const reworkFindings = (signals: FrictionSignals): Draft[] =>
  reworkGroups(signals).map(([file, edits]) => {
    const events = edits.map((edit) => edit.event);

    const values = {
      branchSuffix: branchSuffix(events),
      count: count(edits.length),
      file,
    };

    return {
      evidence: events,
      experiment: renderTemplate(
        FRICTION_TEMPLATES.fileRework.experiment,
        values
      ),
      findingId: `friction.file-rework:${file}`,
      metricIds: [reworkedFilesDefinition.id],
      severity:
        edits.length >= FRICTION_THRESHOLDS.fileReworkEditsHigh
          ? "medium"
          : "low",
      summary: renderTemplate(FRICTION_TEMPLATES.fileRework.summary, values),
      weight: edits.length,
    };
  });

export const rankFindings = (
  drafts: readonly Draft[]
): readonly FindingCandidate[] =>
  [...drafts]
    .toSorted(
      (a, b) =>
        SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] ||
        b.weight - a.weight ||
        compareText(a.findingId, b.findingId)
    )
    .slice(0, FRICTION_THRESHOLDS.maxFindings)
    .map((draft, index) => ({
      evidenceIds: evidenceOf(draft.evidence),
      experiment: draft.experiment,
      findingId: draft.findingId,
      metricIds: [...draft.metricIds],
      rank: index + 1,
      severity: draft.severity,
      summary: draft.summary,
    }));

const testResults = (
  snapshot: StoreSnapshot,
  signals: FrictionSignals
): MetricResult[] => {
  const runEvents = signals.testRuns.map((run) => run.event);
  const testAdapters = new Set(runEvents.map((event) => event.adapterId));

  const overlap =
    testAdapters.size > 1
      ? "test results from more than one adapter may describe the same run"
      : null;

  const attribution: AttributionState =
    overlap === null ? "not-applicable" : "provisional";

  const noTests = "no local test results in the snapshot";
  const known = signals.testRuns.filter((run) => run.outcome !== "unknown");
  const failed = known.filter((run) => run.outcome === "failed");
  const unknownCount = signals.testRuns.length - known.length;

  const unknownReason =
    unknownCount > 0 ? `${unknownCount} test runs have no known outcome` : null;

  return [
    makeResult(snapshot, {
      attribution,
      definition: testRunsDefinition,
      events: runEvents,
      partialReason: overlap,
      unavailableReason: noTests,
      value: runEvents.length === 0 ? null : runEvents.length,
    }),
    makeResult(snapshot, {
      attribution,
      definition: testFailuresDefinition,
      events: failed.map((run) => run.event),
      partialReason: overlap ?? unknownReason,
      unavailableReason:
        runEvents.length === 0
          ? noTests
          : "no test run reports a known outcome",
      value: known.length === 0 ? null : failed.length,
    }),
    makeResult(snapshot, {
      attribution,
      definition: testFailureRateDefinition,
      denominator: known.length === 0 ? null : known.length,
      events: known.map((run) => run.event),
      numerator: known.length === 0 ? null : failed.length,
      partialReason: overlap ?? unknownReason,
      unavailableReason:
        runEvents.length === 0
          ? noTests
          : "zero test runs with a known outcome (denominator is zero)",
      value: known.length === 0 ? null : failed.length / known.length,
    }),
  ];
};

export const computeFriction = (snapshot: StoreSnapshot): MetricOutput => {
  const signals = extractFrictionSignals(snapshot.events);
  const failedCalls = signals.toolCalls.filter((call) => call.failed);
  const calls = signals.toolCalls.length;
  const editedFiles = new Set(signals.fileEdits.map((edit) => edit.filePath));
  const reworked = reworkGroups(signals);

  const results: MetricResult[] = [
    ...testResults(snapshot, signals),
    makeResult(snapshot, {
      definition: toolCallFailureRateDefinition,
      denominator: calls === 0 ? null : calls,
      events: signals.toolCalls.map((call) => call.event),
      numerator: calls === 0 ? null : failedCalls.length,
      unavailableReason:
        "no agent tool-call hook events in the snapshot (denominator is zero)",
      value: calls === 0 ? null : failedCalls.length / calls,
    }),
    makeResult(snapshot, {
      definition: failedCommandsDefinition,
      denominator:
        signals.commandRuns.length === 0 ? null : signals.commandRuns.length,
      events: signals.commandFailures.map((item) => item.event),
      numerator:
        signals.commandRuns.length === 0
          ? null
          : signals.commandFailures.length,
      unavailableReason: "no captured command runs in the snapshot",
      value:
        signals.commandRuns.length === 0
          ? null
          : signals.commandFailures.length,
    }),
    makeResult(snapshot, {
      definition: reworkedFilesDefinition,
      denominator: editedFiles.size === 0 ? null : editedFiles.size,
      events: reworked.flatMap(([, edits]) => edits.map((edit) => edit.event)),
      numerator: editedFiles.size === 0 ? null : reworked.length,
      unavailableReason: "no agent file-edit events in the snapshot",
      value: editedFiles.size === 0 ? null : reworked.length,
    }),
  ];

  const findings = rankFindings([
    ...testFindings(signals),
    ...toolFindings(signals),
    ...commandFindings(signals),
    ...reworkFindings(signals),
  ]);

  return { findings, results };
};

export const frictionMetric: DxMetric = {
  compute: computeFriction,
  definitions: frictionDefinitions,
  descriptor: frictionDescriptor,
};
