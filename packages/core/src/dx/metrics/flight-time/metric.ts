import { DateTime, Option } from "effect";

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
import type { ModuleDescriptor } from "../../model/descriptor.js";
import type { EvidenceId } from "../../model/ids.js";
import { DescriptorIdSchema, MetricIdSchema } from "../../model/ids.js";
import type { IntervalUnionResult } from "../../model/interval.js";
import type { MetricDefinitionRef, MetricResult } from "../../model/metric.js";
import {
  closeOpenIntervalAt,
  intervalHelpers,
} from "../intervals/intervals.js";
import { IDLE_GAP_MS, collectFlightSignals } from "./signals.js";
import type { FlightSignals } from "./signals.js";

export const FLIGHT_TIME_METRIC_VERSION = "1.0.0" as const;

const MAX_EVIDENCE = 200;

const definition = (
  id: string,
  unit: string,
  description: string
): MetricDefinitionRef => ({
  description,
  id: MetricIdSchema.make(id),
  unit,
  version: FLIGHT_TIME_METRIC_VERSION,
});

export const branchAgeDefinition = definition(
  "dx.flight.branch-age.ms",
  "ms",
  "Branch lifetime from creation (reflog creation entry, else the earliest of first branch-only commit, oldest reflog entry or first observed activity) until PR merge, else until the snapshot as-of time."
);

export const activeDefinition = definition(
  "dx.flight.active.ms",
  "ms",
  `Union of active development intervals: activity bursts (commits, AI, markers, commands; split at idle gaps over ${IDLE_GAP_MS / 60_000} min) merged with agent intervals; overlaps count once.`
);

export const activeIntervalsDefinition = definition(
  "dx.flight.active.intervals",
  "intervals",
  "Number of merged active development intervals on the branch."
);

export const agentDefinition = definition(
  "dx.flight.agent.ms",
  "ms",
  `Union of AI agent intervals: explicit turn/run durations (durationMs, startedAt/completedAt) plus per-session activity spans split at idle gaps over ${IDLE_GAP_MS / 60_000} min; overlapping sessions and sources count once.`
);

export const toolCallsDefinition = definition(
  "dx.flight.tool-calls",
  "calls",
  "AI tool calls, deduplicated across sources by request/turn match keys; per key group the highest-precedence source wins. Session-level totals are used only for sessions with no per-turn data."
);

export const commitsDefinition = definition(
  "dx.flight.commits",
  "commits",
  "Distinct commits observed on the branch."
);

export const firstCommitDefinition = definition(
  "dx.flight.first-commit-at",
  "epoch-ms",
  "Earliest commit time on the branch (author date, else committer date)."
);

export const lastCommitDefinition = definition(
  "dx.flight.last-commit-at",
  "epoch-ms",
  "Latest commit time on the branch (author date, else committer date)."
);

export const flightTimeDefinitions: readonly MetricDefinitionRef[] = [
  branchAgeDefinition,
  activeDefinition,
  activeIntervalsDefinition,
  agentDefinition,
  toolCallsDefinition,
  commitsDefinition,
  firstCommitDefinition,
  lastCommitDefinition,
];

export const flightTimeDescriptor: ModuleDescriptor = {
  contractVersion: CONTRACT_VERSION,
  fixtureIds: [
    "core-golden-flight",
    "b05.agent-turns",
    "b10-cursor-cli-stream-json",
  ],
  gaps: [
    {
      code: "branch-start-lower-bound",
      message:
        "Without a reflog creation entry the branch start is the earliest commit or observed activity, so branch age is a lower bound.",
    },
    {
      code: "idle-gap-heuristic",
      message: `Activity and session spans split at idle gaps over ${IDLE_GAP_MS / 60_000} minutes; point events alone produce zero-length intervals.`,
    },
    {
      code: "tool-call-key-match",
      message:
        "Tool calls from different sources collapse only when they share a request or turn key; unkeyed reports are counted as-is.",
    },
  ],
  id: DescriptorIdSchema.make("dx.metric.flight-time"),
  kind: "metric",
  owner: "flight-time",
  readiness: "ready",
  requiredInputs: [],
  supportedFields: flightTimeDefinitions.map((d) => d.id),
  version: FLIGHT_TIME_METRIC_VERSION,
};

interface Frame {
  readonly asOf: string;
  readonly checkpoint: string | null;
  readonly signals: FlightSignals;
}

interface Value {
  readonly attribution?: AttributionState;
  readonly evidenceIds: readonly EvidenceId[];
  readonly measurement: MeasurementState;
  readonly method: ValueMethod;
  readonly notes: readonly string[];
  readonly value: number;
}

const branchNotes = (signals: FlightSignals): readonly string[] =>
  signals.excludedOtherBranch > 0
    ? [
        `${signals.excludedOtherBranch} event(s) from other or unknown branches excluded`,
      ]
    : [];

const baseOf = (frame: Frame, def: MetricDefinitionRef) => ({
  asOf: frame.asOf,
  checkpoint: frame.checkpoint,
  coverage: frame.signals.coverage,
  definition: def,
  denominator: null,
  metricId: def.id,
  numerator: null,
  unit: def.unit,
});

const missing = (
  frame: Frame,
  def: MetricDefinitionRef,
  reason: string
): MetricResult => ({
  ...baseOf(frame, def),
  attribution: "not-applicable",
  evidenceIds: [],
  measurement: "unavailable",
  method: "derived",
  reason,
  value: null,
});

const result = (
  frame: Frame,
  def: MetricDefinitionRef,
  value: Value
): MetricResult => {
  const notes = [...value.notes, ...branchNotes(frame.signals)];

  return {
    ...baseOf(frame, def),
    attribution: value.attribution ?? "not-applicable",
    evidenceIds: [...new Set(value.evidenceIds)].slice(0, MAX_EVIDENCE),
    measurement: value.measurement,
    method: value.method,
    reason: notes.length === 0 ? null : notes.join("; "),
    value: value.value,
  };
};

const iso = (ms: number): string =>
  Option.match(DateTime.make(ms), {
    onNone: () => `${ms}ms`,
    onSome: DateTime.formatIso,
  });

const branchAge = (frame: Frame): MetricResult => {
  const { end, start } = frame.signals;

  if (start === null) {
    return missing(
      frame,
      branchAgeDefinition,
      "no branch creation evidence: no reflog entry, branch commit or observed activity in selection"
    );
  }

  if (end === null) {
    return missing(
      frame,
      branchAgeDefinition,
      "no merge time and no snapshot as-of time to close the branch interval"
    );
  }

  const closed = closeOpenIntervalAt(
    {
      endMs: end.method === "merged" ? end.atMs : null,
      evidenceIds: [...start.evidenceIds, ...end.evidenceIds],
      label: `branch:${start.method}`,
      startMs: start.atMs,
    },
    end.atMs
  );

  const union = intervalHelpers.union([closed]);

  if (union.totalMs === null) {
    return missing(
      frame,
      branchAgeDefinition,
      `branch start ${iso(start.atMs)} is after its end ${iso(end.atMs)}; clock error`
    );
  }

  return result(frame, branchAgeDefinition, {
    evidenceIds: closed.evidenceIds,
    measurement:
      start.method === "reflog-branch-created" && end.method === "merged"
        ? "measured"
        : "partial",
    method: start.method === "reflog-branch-created" ? "observed" : "derived",
    notes: [
      `start=${start.method}@${iso(start.atMs)}`,
      `end=${end.method}@${iso(end.atMs)}`,
      ...(start.method === "reflog-branch-created"
        ? []
        : ["no reflog creation entry; value is a lower bound"]),
      ...(end.method === "as-of"
        ? ["branch not merged; open until as-of"]
        : []),
    ],
    value: union.totalMs,
  });
};

const unionNotes = (union: IntervalUnionResult): readonly string[] => [
  ...(union.censored > 0
    ? [`${union.censored} censored interval(s) excluded; lower bound`]
    : []),
  ...(union.clockErrors > 0
    ? [`${union.clockErrors} clock-error interval(s) excluded; lower bound`]
    : []),
];

const unionState = (union: IntervalUnionResult): MeasurementState =>
  union.censored > 0 || union.clockErrors > 0 ? "partial" : "measured";

const mergedEvidence = (union: IntervalUnionResult): readonly EvidenceId[] =>
  union.merged.flatMap((m) => m.evidenceIds);

const activeResults = (frame: Frame): readonly MetricResult[] => {
  const union = intervalHelpers.union([
    ...frame.signals.activityPoints,
    ...frame.signals.agentIntervals,
  ]);

  if (union.totalMs === null) {
    const reason =
      "no timestamped commits, AI events, markers or commands on the branch";

    return [
      missing(frame, activeDefinition, reason),
      missing(frame, activeIntervalsDefinition, reason),
    ];
  }

  const notes = [
    `${union.merged.length} interval(s); idle gap ${IDLE_GAP_MS / 60_000} min`,
    ...unionNotes(union),
  ];

  const value = (v: number): Value => ({
    evidenceIds: mergedEvidence(union),
    measurement: unionState(union),
    method: "derived",
    notes,
    value: v,
  });

  return [
    result(frame, activeDefinition, value(union.totalMs)),
    result(frame, activeIntervalsDefinition, value(union.merged.length)),
  ];
};

const agentResult = (frame: Frame): MetricResult => {
  const intervals = frame.signals.agentIntervals;
  const union = intervalHelpers.union(intervals);

  if (union.totalMs === null) {
    return missing(
      frame,
      agentDefinition,
      "no AI duration evidence on the branch: no turn/run durations and no session with two or more timestamped events (hooks, cursor-cli, transcripts, sessions)"
    );
  }

  const summed = intervalHelpers.sum(intervals).totalMs ?? 0;

  return result(frame, agentDefinition, {
    attribution: "provisional",
    evidenceIds: mergedEvidence(union),
    measurement: unionState(union),
    method: "derived",
    notes: [
      `${intervals.length} source interval(s) merged into ${union.merged.length}`,
      ...(summed > union.totalMs
        ? [`${summed - union.totalMs} ms of overlap counted once`]
        : []),
      ...unionNotes(union),
    ],
    value: union.totalMs,
  });
};

const toolCallsResult = (frame: Frame): MetricResult => {
  const tally = frame.signals.toolCalls;

  if (tally.total === null) {
    return missing(
      frame,
      toolCallsDefinition,
      "no tool-call evidence on the branch (hooks postToolUse, cursor-cli toolCalls, transcripts, sessions)"
    );
  }

  return result(frame, toolCallsDefinition, {
    attribution: "provisional",
    evidenceIds: tally.evidenceIds,
    measurement: tally.sessionAggregatesUsed > 0 ? "partial" : "measured",
    method: "observed",
    notes: [
      `${tally.reports} report(s); ${tally.collapsedReports} duplicate report(s) collapsed`,
      ...(tally.sessionAggregatesUsed > 0
        ? [
            `${tally.sessionAggregatesUsed} session-level total(s) used without per-turn data`,
          ]
        : []),
    ],
    value: tally.total,
  });
};

const commitResults = (frame: Frame): readonly MetricResult[] => {
  const { commits } = frame.signals;

  if (commits.length === 0 && frame.signals.commitHistoryCollected) {
    const reason =
      "git-history collected completely and found no commits beyond the base ref";

    return [
      result(frame, commitsDefinition, {
        evidenceIds: [],
        measurement: "measured",
        method: "observed",
        notes: [reason],
        value: 0,
      }),
      missing(frame, firstCommitDefinition, reason),
      missing(frame, lastCommitDefinition, reason),
    ];
  }

  if (commits.length === 0) {
    const reason =
      "no git.commit events on the branch; run dx collect --source git-history";

    return [
      missing(frame, commitsDefinition, reason),
      missing(frame, firstCommitDefinition, reason),
      missing(frame, lastCommitDefinition, reason),
    ];
  }

  const timed = commits
    .flatMap((c) => (c.atMs === null ? [] : [c]))
    .toSorted((a, b) => (a.atMs ?? 0) - (b.atMs ?? 0));

  const untimed = commits.length - timed.length;
  const [first] = timed;
  const last = timed.at(-1);

  const timeNotes =
    untimed > 0 ? [`${untimed} commit(s) without a timestamp`] : [];

  const point = (
    def: MetricDefinitionRef,
    commit: (typeof timed)[number] | undefined
  ): MetricResult =>
    commit?.atMs === null || commit === undefined
      ? missing(frame, def, "no commit carries a timestamp")
      : result(frame, def, {
          evidenceIds: [commit.evidenceId],
          measurement: untimed > 0 ? "partial" : "measured",
          method: "observed",
          notes: [
            `sha=${commit.sha.slice(0, 12)}@${iso(commit.atMs)}`,
            ...timeNotes,
          ],
          value: commit.atMs,
        });

  return [
    result(frame, commitsDefinition, {
      evidenceIds: commits.map((c) => c.evidenceId),
      measurement: "measured",
      method: "observed",
      notes: [],
      value: commits.length,
    }),
    point(firstCommitDefinition, first),
    point(lastCommitDefinition, last),
  ];
};

export const computeFlightTime = (snapshot: StoreSnapshot): MetricOutput => {
  const signals = collectFlightSignals(snapshot);

  const frame: Frame = {
    asOf: snapshot.manifest.createdAt,
    checkpoint: signals.branch === null ? null : `branch:${signals.branch}`,
    signals,
  };

  return {
    findings: [],
    results: [
      branchAge(frame),
      ...activeResults(frame),
      agentResult(frame),
      toolCallsResult(frame),
      ...commitResults(frame),
    ],
  };
};

export const flightTimeMetric: DxMetric = {
  compute: computeFlightTime,
  definitions: flightTimeDefinitions,
  descriptor: flightTimeDescriptor,
};
