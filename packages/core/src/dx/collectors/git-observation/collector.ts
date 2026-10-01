// @effect-diagnostics-next-line nodeBuiltinImport:off -- Event IDs need a synchronous deterministic sha256 while building envelopes; Effect Crypto is effectful.
import { createHash } from "node:crypto";

import { Clock, DateTime, Effect } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";

import { InvalidInput } from "../../contracts/error-invalid-input.js";
import type { SourceUnavailable } from "../../contracts/error-source-unavailable.js";
import type { CollectInput, DxCollector } from "../../contracts/services.js";
import { CONTRACT_VERSION } from "../../contracts/version.js";
import {
  loadCheckoutRefs,
  reflogArgs,
} from "../../correlation/branch-at-time/git.js";
import type { CheckoutRefs } from "../../correlation/branch-at-time/git.js";
import {
  isHeadTransition,
  isoOf,
  parseReflogLines,
} from "../../correlation/branch-at-time/timeline.js";
import type { RawReflogEntry } from "../../correlation/branch-at-time/timeline.js";
import type { Origin } from "../../model/common.js";
import type { SourceCoverage, SourceGap } from "../../model/coverage.js";
import type { ModuleDescriptor } from "../../model/descriptor.js";
import type {
  DxEventEnvelope,
  EventBatch,
  EventIdentity,
  FieldSemantics,
  FlightContext,
} from "../../model/event.js";
import { EVENT_SCHEMA_VERSION, emptyEventIdentity } from "../../model/event.js";
import { DescriptorIdSchema, EventIdSchema } from "../../model/ids.js";
import { GIT_OBSERVATION_ADAPTER_ID, spawnerGitRunner } from "./git-runner.js";
import type { GitRunner } from "./git-runner.js";
import {
  parseNumstat,
  parseReflog,
  parseStatusPaths,
  parseStatusPorcelainV2,
} from "./parse.js";
import type { DiffTotals, ReflogEntry, WorkingTreeState } from "./parse.js";

export const GIT_OBSERVATION_ADAPTER_VERSION = "1.0.0";

export const GIT_OBSERVATION_FIXTURE_IDS = [
  "b04/porcelain-dirty-feature",
  "b04/live-temp-repo",
] as const;

const REFLOG_LIMIT = 500;

const FINGERPRINT_PATH_LIMIT = 200;

export const GIT_OBSERVATION_GAPS: readonly SourceGap[] = [
  {
    code: "observation-not-history",
    message:
      "Working-tree state is sampled only when collect runs; edits made and reverted between observations are not seen.",
  },
  {
    code: "reflog-local-retention",
    message:
      "Branch reflog is local to this clone and expires with git gc; branches fetched or created elsewhere have no creation entry.",
  },
  {
    code: "no-ai-attribution",
    message:
      "Git observation carries no evidence of who or what authored a change; attribution stays unassigned.",
  },
];

export const gitObservationDescriptor: ModuleDescriptor = {
  contractVersion: CONTRACT_VERSION,
  fixtureIds: [...GIT_OBSERVATION_FIXTURE_IDS],
  gaps: [...GIT_OBSERVATION_GAPS],
  id: DescriptorIdSchema.make("collector.git-observation"),
  kind: "collector",
  owner: "B04",
  readiness: "ready",
  requiredInputs: [
    "explicitly selected local Git worktree path (opt-in); read-only git status/diff/reflog",
  ],
  supportedFields: [
    "branch",
    "headSha",
    "upstream",
    "ahead",
    "behind",
    "trackedChangedFiles",
    "stagedFiles",
    "untrackedFiles",
    "conflictedFiles",
    "uncommittedLinesAdded",
    "uncommittedLinesDeleted",
    "uncommittedBinaryFiles",
    "reflog.action",
    "reflog.createdFrom",
    "reflog.occurredAt",
  ],
  version: GIT_OBSERVATION_ADAPTER_VERSION,
};

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const observed = (field: string, unit: string | null): FieldSemantics => ({
  field,
  method: "observed",
  note: null,
  rawName: null,
  unit,
});

export interface HeadTransition {
  readonly at: string;
  readonly subject: string;
}

interface EventDraft {
  readonly identity: EventIdentity;
  readonly occurredAt: string | null;
  readonly payload: Readonly<
    Record<
      string,
      string | number | null | readonly HeadTransition[] | readonly string[]
    >
  >;
  readonly semantics: readonly FieldSemantics[];
  readonly upstreamKey: string;
}

interface EventFrame {
  readonly context: FlightContext;
  readonly observedAt: string;
  readonly origin: Origin;
  readonly sourceVersion: string | null;
}

const toEnvelope = (frame: EventFrame, draft: EventDraft): DxEventEnvelope => ({
  acquisition: "git",
  adapterId: GIT_OBSERVATION_ADAPTER_ID,
  adapterVersion: GIT_OBSERVATION_ADAPTER_VERSION,
  ai: null,
  context: frame.context,
  eventId: EventIdSchema.make(
    sha256(
      `${GIT_OBSERVATION_ADAPTER_ID}\n${draft.upstreamKey}\ngit.observation`
    )
  ),
  evidence: {
    bounded: true,
    hash: `sha256:${sha256(JSON.stringify(draft.payload))}`,
    ref: `git-observation:${draft.upstreamKey}`,
  },
  fieldSemantics: [...draft.semantics],
  identity: draft.identity,
  kind: "git.observation",
  observedAt: frame.observedAt,
  occurredAt: draft.occurredAt,
  occurredAtPrecision: draft.occurredAt === null ? "unknown" : "second",
  origin: frame.origin,
  payload: { ...draft.payload },
  schemaVersion: EVENT_SCHEMA_VERSION,
  sourceVersion: frame.sourceVersion,
  upstreamKey: draft.upstreamKey,
  usage: null,
});

export const workingTreeDraft = (
  scopeKey: string,
  state: WorkingTreeState,
  diff: DiffTotals | null,
  fingerprint: string | null,
  observedAt: string
): EventDraft => {
  const payload = {
    ahead: state.ahead,
    behind: state.behind,
    branch: state.branch,
    conflictedFiles: state.conflictedFiles,
    headSha: state.headSha,
    observationKind: "working-tree",
    stagedFiles: state.stagedFiles,
    trackedChangedFiles: state.trackedChangedFiles,
    uncommittedBinaryFiles: diff?.binaryFiles ?? null,
    uncommittedLinesAdded: diff?.linesAdded ?? null,
    uncommittedLinesDeleted: diff?.linesDeleted ?? null,
    untrackedFiles: state.untrackedFiles,
    upstream: state.upstream,
    worktreeFingerprint: fingerprint,
  };

  const stateHash = sha256(JSON.stringify(payload)).slice(0, 16);

  return {
    identity: { ...emptyEventIdentity, commitSha: state.headSha },
    occurredAt: observedAt,
    payload,
    semantics: [
      observed("trackedChangedFiles", "files"),
      observed("untrackedFiles", "files"),
      observed("uncommittedLinesAdded", "lines"),
      observed("uncommittedLinesDeleted", "lines"),
      observed("ahead", "commits"),
      observed("behind", "commits"),
    ],
    upstreamKey: `state:${scopeKey}:${state.branch ?? "detached"}:${state.headSha ?? "unborn"}:${stateHash}`,
  };
};

export const reflogDraft = (
  scopeKey: string,
  branch: string,
  entry: ReflogEntry
): EventDraft => ({
  identity: { ...emptyEventIdentity, commitSha: entry.newSha },
  occurredAt: entry.occurredAt,
  payload: {
    action: entry.action,
    branch,
    createdFrom: entry.createdFrom,
    newSha: entry.newSha,
    observationKind: "branch-reflog",
  },
  semantics: [observed("action", null), observed("occurredAt", "iso8601")],
  upstreamKey: `reflog:${scopeKey}:${branch}:${entry.newSha}:${entry.occurredAt ?? "unknown"}:${entry.action}`,
});

const NO_CHECKOUT_REFS: CheckoutRefs = {
  detachedRefs: [],
  localBranches: [],
};

export const headMovesDraft = (
  scopeKey: string,
  branch: string | null,
  entries: readonly RawReflogEntry[],
  observedAt: string,
  { detachedRefs, localBranches }: CheckoutRefs = NO_CHECKOUT_REFS
): EventDraft | null => {
  const [first] = entries;

  if (first === undefined) {
    return null;
  }

  const startedAt = isoOf(first.atMs);

  const transitions = entries.flatMap((entry): readonly HeadTransition[] =>
    isHeadTransition(entry.subject)
      ? [{ at: isoOf(entry.atMs), subject: entry.subject }]
      : []
  );

  const refLists = Object.fromEntries(
    Object.entries({ detachedRefs, localBranches }).filter(
      ([, names]) => names.length > 0
    )
  );

  const moves = { branch, ...refLists, startedAt, transitions };

  const hash = sha256(JSON.stringify(moves)).slice(0, 16);

  return {
    identity: { ...emptyEventIdentity },
    occurredAt: observedAt,
    payload: {
      ...moves,
      observationKind: "head-moves",
    },
    semantics: [
      observed("transitions", null),
      observed("startedAt", "iso8601"),
    ],
    upstreamKey: `head:${scopeKey}:${startedAt}:${hash}`,
  };
};

const nonEmptyLines = (output: string): readonly string[] =>
  output.split("\n").flatMap((line) => {
    const trimmed = line.trim();

    return trimmed.length > 0 ? [trimmed] : [];
  });

const GIT_VERSION_PATTERN = /git version (?<version>\S+)/u;

const sourceVersionOf = (versionOutput: string): string | null =>
  GIT_VERSION_PATTERN.exec(versionOutput)?.groups?.version ?? null;

const oldestTimestamp = (entries: readonly ReflogEntry[]): string | null =>
  entries
    .flatMap((entry) => (entry.occurredAt === null ? [] : [entry.occurredAt]))
    .toSorted()[0] ?? null;

const readReflog = (
  runGit: GitRunner,
  worktree: string,
  branch: string
): Effect.Effect<readonly ReflogEntry[], SourceUnavailable> =>
  Effect.map(
    runGit(worktree, [
      "log",
      "-g",
      `-n${REFLOG_LIMIT}`,
      "--date=iso-strict",
      "--format=%H%x1f%gd%x1f%gs",
      `refs/heads/${branch}`,
      "--",
    ]),
    parseReflog
  );

const fingerprintWorktree = (
  runGit: GitRunner,
  toplevel: string,
  paths: readonly string[]
): Effect.Effect<string | null> =>
  paths.length === 0 || paths.length > FINGERPRINT_PATH_LIMIT
    ? Effect.succeed(paths.length === 0 ? sha256("clean") : null)
    : runGit(toplevel, ["hash-object", "--", ...paths]).pipe(
        Effect.map((hashes) => sha256(`${paths.join("\0")}\n${hashes}`)),
        Effect.orElseSucceed(() => null)
      );

const detailGaps = (
  state: WorkingTreeState,
  diff: DiffTotals | null,
  reflog: readonly ReflogEntry[] | null,
  fingerprint: string | null
): readonly SourceGap[] => [
  ...GIT_OBSERVATION_GAPS,
  ...(fingerprint === null
    ? [
        {
          code: "fingerprint-unavailable",
          message: `Changed-file content fingerprint unavailable (unreadable or more than ${FINGERPRINT_PATH_LIMIT} paths); same-count edits may collapse into one observation.`,
        },
      ]
    : []),
  ...(diff === null
    ? [
        {
          code: "unborn-head",
          message:
            "HEAD has no commit yet; uncommitted line counts unavailable.",
        },
      ]
    : []),
  ...(state.branch === null
    ? [
        {
          code: "detached-head",
          message: "HEAD is detached; no branch reflog observed.",
        },
      ]
    : []),
  ...(state.branch !== null && reflog === null
    ? [
        {
          code: "reflog-unreadable",
          message: "Branch reflog could not be read for this branch.",
        },
      ]
    : []),
  ...(reflog !== null && reflog.length >= REFLOG_LIMIT
    ? [
        {
          code: "reflog-truncated",
          message: `Only the newest ${REFLOG_LIMIT} branch reflog entries were read.`,
        },
      ]
    : []),
];

export const collectGitObservation = Effect.fn("GitObservation.collect")(
  function* collectGitObservation(runGit: GitRunner, input: CollectInput) {
    const worktree = input.selectedInput;

    if (worktree === null || worktree.length === 0) {
      return yield* new InvalidInput({
        field: "selectedInput",
        message:
          "git-observation is opt-in: pass an explicit local worktree path.",
      });
    }

    const sourceVersion = sourceVersionOf(yield* runGit(worktree, ["version"]));

    const [toplevel = null, commonDir = null] = nonEmptyLines(
      yield* runGit(worktree, [
        "rev-parse",
        "--path-format=absolute",
        "--show-toplevel",
        "--git-common-dir",
      ])
    );

    const statusOutput = yield* runGit(worktree, [
      "status",
      "--porcelain=v2",
      "--branch",
      "-z",
      "--untracked-files=all",
    ]);

    const state = parseStatusPorcelainV2(statusOutput);

    const fingerprint = yield* fingerprintWorktree(
      runGit,
      toplevel ?? worktree,
      parseStatusPaths(statusOutput)
    );

    const diff =
      state.headSha === null
        ? null
        : parseNumstat(
            yield* runGit(worktree, ["diff", "HEAD", "--numstat", "-z"])
          );

    const reflog =
      state.branch === null
        ? []
        : yield* readReflog(runGit, worktree, state.branch).pipe(
            Effect.orElseSucceed(() => null)
          );

    const reflogEntries = reflog ?? [];

    const headEntries = parseReflogLines(
      yield* runGit(worktree, reflogArgs("HEAD")).pipe(
        Effect.orElseSucceed(() => "")
      )
    );

    const checkoutRefs = yield* loadCheckoutRefs(runGit, worktree, headEntries);

    const observedAt = DateTime.formatIso(
      DateTime.makeUnsafe(yield* Clock.currentTimeMillis)
    );

    const scopeKey = sha256(
      `${commonDir ?? ""}\n${toplevel ?? worktree}`
    ).slice(0, 16);

    const frame: EventFrame = {
      context: {
        ...input.context,
        branch: state.branch,
        headSha: state.headSha,
        repoCommonDir: commonDir,
        worktreePath: toplevel,
      },
      observedAt,
      origin: input.origin,
      sourceVersion,
    };

    const events = [
      workingTreeDraft(scopeKey, state, diff, fingerprint, observedAt),
      ...reflogEntries.map((entry) =>
        reflogDraft(scopeKey, state.branch ?? "detached", entry)
      ),
      ...[
        headMovesDraft(
          scopeKey,
          state.branch,
          headEntries,
          observedAt,
          checkoutRefs
        ),
      ].flatMap((draft) => (draft === null ? [] : [draft])),
    ].map((draft) => toEnvelope(frame, draft));

    const coverage: SourceCoverage = {
      adapterId: GIT_OBSERVATION_ADAPTER_ID,
      expectedItems: null,
      gaps: [...detailGaps(state, diff, reflog, fingerprint)],
      observedItems: events.length,
      state: "partial",
      watermark: observedAt,
      windowFrom: oldestTimestamp(reflogEntries) ?? observedAt,
      windowTo: observedAt,
    };

    const batch: EventBatch = {
      coverage,
      cursor: { adapterId: GIT_OBSERVATION_ADAPTER_ID, value: observedAt },
      events,
    };

    return batch;
  }
);

export const makeGitObservationCollector = (
  runGit: GitRunner
): DxCollector => ({
  collect: (input) => collectGitObservation(runGit, input),
  descriptor: gitObservationDescriptor,
});

export const gitObservationCollector: DxCollector<ChildProcessSpawner.ChildProcessSpawner> =
  {
    collect: (input) =>
      spawnerGitRunner.pipe(
        Effect.flatMap((runGit) => collectGitObservation(runGit, input))
      ),
    descriptor: gitObservationDescriptor,
  };
