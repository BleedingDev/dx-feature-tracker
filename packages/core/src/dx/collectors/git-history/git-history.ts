// @effect-diagnostics nodeBuiltinImport:off -- The git history collector shells out to the local git binary read-only and hashes evidence.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

import { DateTime, Effect } from "effect";

import type { InvalidInput } from "../../contracts/error-invalid-input.js";
import { SourceUnavailable } from "../../contracts/error-source-unavailable.js";
import type { CollectInput, DxCollector } from "../../contracts/services.js";
import { CONTRACT_VERSION } from "../../contracts/version.js";
import type { Acquisition, Origin } from "../../model/common.js";
import type { SourceGap } from "../../model/coverage.js";
import type { ModuleDescriptor } from "../../model/descriptor.js";
import { EVENT_SCHEMA_VERSION, emptyEventIdentity } from "../../model/event.js";
import type {
  DxEventEnvelope,
  EventBatch,
  EventKind,
  FieldSemantics,
  FlightContext,
} from "../../model/event.js";
import { DescriptorIdSchema, EventIdSchema } from "../../model/ids.js";
import {
  LOG_FORMAT,
  branchCreatedFrom,
  parseLog,
  parseNumstat,
  parseReflog,
  summarizeNumstat,
} from "./parse.js";
import type { ParsedCommit, ReflogEntry } from "./parse.js";

export const GIT_HISTORY_ADAPTER_ID = "git-history";

export const GIT_HISTORY_ADAPTER_VERSION = "1.0.0";

export const GIT_HISTORY_MAX_COMMITS = 2000;

export const GIT_HISTORY_FIXTURE_IDS = [
  "b03-log-numstat",
  "b03-live-temp-repo",
] as const;

export type GitRunner = (
  cwd: string,
  args: readonly string[]
) => Effect.Effect<string, SourceUnavailable>;

export const nodeGitRunner: GitRunner = (cwd, args) =>
  Effect.try({
    catch: (error) =>
      new SourceUnavailable({
        adapterId: GIT_HISTORY_ADAPTER_ID,
        message: `git ${args[0] ?? ""} failed: ${String(error).split("\n")[0] ?? "unknown error"}`,
      }),
    try: () =>
      execFileSync("git", ["--no-pager", "-c", "core.quotepath=off", ...args], {
        cwd,
        encoding: "utf-8",
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      }),
  });

export const gitHistoryDescriptor: ModuleDescriptor = {
  contractVersion: CONTRACT_VERSION,
  fixtureIds: [...GIT_HISTORY_FIXTURE_IDS],
  gaps: [
    {
      code: "commit-time-rewritable",
      message:
        "Author/committer dates are source-reported by git and rewritten by rebase/amend; they are not recorder observations.",
    },
    {
      code: "backfill-not-first-observed",
      message:
        "observedAt is the collection time of a backfill, not the moment the commit was created; first-observed ordering requires the store or B04 observation.",
    },
    {
      code: "branch-creation-reflog-only",
      message:
        "Branch creation time comes only from the local reflog; expired or absent reflog leaves it unavailable.",
    },
  ],
  id: DescriptorIdSchema.make("collector.git-history"),
  kind: "collector",
  owner: "B03",
  readiness: "ready",
  requiredInputs: ["repo path (selectedInput or context.worktreePath)"],
  supportedFields: [
    "git.commit.sha",
    "git.commit.parents",
    "git.commit.authoredAt",
    "git.commit.committedAt",
    "git.commit.filesChanged",
    "git.commit.linesAdded",
    "git.commit.linesDeleted",
    "git.commit.binaryFiles",
    "git.commit.paths",
    "git.diff.worktree.filesChanged",
    "git.diff.worktree.linesAdded",
    "git.diff.worktree.linesDeleted",
    "git.diff.worktree.untrackedFiles",
    "git.observation.branchCreatedAt",
    "git.observation.reflogOldestAt",
  ],
  version: GIT_HISTORY_ADAPTER_VERSION,
};

const sha256 = (text: string): string =>
  `sha256:${createHash("sha256").update(text).digest("hex")}`;

export const eventIdFor = (
  adapterId: string,
  upstreamKey: string,
  kind: EventKind
) =>
  EventIdSchema.make(sha256(`${adapterId}\u0000${upstreamKey}\u0000${kind}`));

interface EventDraft {
  readonly commitSha: string | null;
  readonly fieldSemantics: readonly FieldSemantics[];
  readonly kind: EventKind;
  readonly occurredAt: string | null;
  readonly payload: DxEventEnvelope["payload"];
  readonly ref: string;
  readonly upstreamKey: string;
}

interface EnvelopeEnv {
  readonly acquisition: Acquisition;
  readonly context: FlightContext;
  readonly observedAt: string;
  readonly origin: Origin;
  readonly sourceVersion: string | null;
}

const toEnvelope = (env: EnvelopeEnv, draft: EventDraft): DxEventEnvelope => ({
  acquisition: env.acquisition,
  adapterId: GIT_HISTORY_ADAPTER_ID,
  adapterVersion: GIT_HISTORY_ADAPTER_VERSION,
  context: env.context,
  eventId: eventIdFor(GIT_HISTORY_ADAPTER_ID, draft.upstreamKey, draft.kind),
  evidence: {
    bounded: true,
    hash: sha256(JSON.stringify(draft.payload)),
    ref: draft.ref,
  },
  fieldSemantics: draft.fieldSemantics,
  identity: { ...emptyEventIdentity, commitSha: draft.commitSha },
  kind: draft.kind,
  observedAt: env.observedAt,
  occurredAt: draft.occurredAt,
  occurredAtPrecision: draft.occurredAt === null ? "unknown" : "second",
  origin: env.origin,
  payload: draft.payload,
  schemaVersion: EVENT_SCHEMA_VERSION,
  sourceVersion: env.sourceVersion,
  upstreamKey: draft.upstreamKey,
});

const sem = (
  field: string,
  method: FieldSemantics["method"],
  unit: string | null,
  rawName: string | null,
  note: string | null
): FieldSemantics => ({ field, method, note, rawName, unit });

const OBSERVED_AT_NOTE =
  "observedAt is recorder collection time (backfill), never the commit creation time";

const COMMIT_SEMANTICS: readonly FieldSemantics[] = [
  sem(
    "authoredAt",
    "source-reported",
    "iso8601",
    "%aI",
    "git author date; user-settable and preserved across rebase"
  ),
  sem(
    "committedAt",
    "source-reported",
    "iso8601",
    "%cI",
    "git committer date; rewritten by rebase/amend"
  ),
  sem(
    "linesAdded",
    "observed",
    "lines",
    "numstat.added",
    "binary files excluded"
  ),
  sem(
    "linesDeleted",
    "observed",
    "lines",
    "numstat.deleted",
    "binary files excluded"
  ),
  sem("filesChanged", "observed", "files", "numstat", null),
  sem("observedAt", "observed", "iso8601", null, OBSERVED_AT_NOTE),
];

const WORKTREE_SEMANTICS: readonly FieldSemantics[] = [
  sem("linesAdded", "observed", "lines", "diff --numstat HEAD", null),
  sem("linesDeleted", "observed", "lines", "diff --numstat HEAD", null),
  sem("filesChanged", "observed", "files", "diff --numstat HEAD", null),
  sem(
    "untrackedFiles",
    "observed",
    "files",
    "ls-files --others --exclude-standard",
    null
  ),
  sem(
    "observedAt",
    "observed",
    "iso8601",
    null,
    "snapshot of uncommitted state at collection time; occurredAt unknown"
  ),
];

const REFLOG_SEMANTICS: readonly FieldSemantics[] = [
  sem(
    "branchCreatedAt",
    "observed",
    "iso8601",
    "reflog 'branch: Created from'",
    "local reflog entry; unavailable when expired or branch was fetched"
  ),
  sem(
    "reflogOldestAt",
    "observed",
    "iso8601",
    "reflog oldest entry",
    "earliest locally observed ref update"
  ),
];

export const commitDraft = (
  commit: ParsedCommit,
  branchKey: string,
  baseSha: string | null
): EventDraft => {
  const summary = summarizeNumstat(commit.files);

  return {
    commitSha: commit.sha,
    fieldSemantics: COMMIT_SEMANTICS,
    kind: "git.commit",
    occurredAt: commit.committedAt,
    payload: {
      authoredAt: commit.authoredAt,
      baseSha,
      binaryFiles: summary.binaryFiles,
      committedAt: commit.committedAt,
      filesChanged: summary.filesChanged,
      isMerge: commit.parents.length > 1,
      linesAdded: summary.linesAdded,
      linesDeleted: summary.linesDeleted,
      numstatAvailable: commit.parents.length <= 1,
      observationMode: "backfill",
      parents: commit.parents,
      paths: summary.paths,
      pathsTruncated: summary.pathsTruncated,
      sha: commit.sha,
      timeBasis: "git-committer-date",
    },
    ref: `git:commit:${commit.sha}`,
    upstreamKey: `branch:${branchKey}:commit:${commit.sha}`,
  };
};

export const worktreeDraft = (
  numstatText: string,
  untrackedCount: number,
  branchKey: string,
  headSha: string
): EventDraft => {
  const summary = summarizeNumstat(parseNumstat(numstatText));
  const digest = sha256(`${numstatText}\u0000${untrackedCount}`);

  return {
    commitSha: headSha,
    fieldSemantics: WORKTREE_SEMANTICS,
    kind: "git.diff",
    occurredAt: null,
    payload: {
      binaryFiles: summary.binaryFiles,
      diffBase: "HEAD",
      filesChanged: summary.filesChanged,
      headSha,
      linesAdded: summary.linesAdded,
      linesDeleted: summary.linesDeleted,
      observationMode: "snapshot",
      paths: summary.paths,
      pathsTruncated: summary.pathsTruncated,
      scope: "uncommitted-worktree",
      untrackedFiles: untrackedCount,
    },
    ref: `git:worktree:${headSha}`,
    upstreamKey: `branch:${branchKey}:worktree:${headSha}:${digest}`,
  };
};

export const reflogDraft = (
  entries: readonly ReflogEntry[],
  branchKey: string
): EventDraft | null => {
  const oldest = entries.at(-1);

  if (oldest === undefined) {
    return null;
  }

  const createdFrom = branchCreatedFrom(oldest.subject);

  return {
    commitSha: oldest.sha,
    fieldSemantics: REFLOG_SEMANTICS,
    kind: "git.observation",
    occurredAt: oldest.at,
    payload: {
      branchCreatedAt: createdFrom === null ? null : oldest.at,
      branchCreatedAtReason:
        createdFrom === null
          ? "oldest reflog entry is not a branch creation (expired, fetched or renamed)"
          : null,
      createdFrom,
      observation: createdFrom === null ? "reflog-oldest" : "branch-created",
      reflogEntries: entries.length,
      reflogOldestAt: oldest.at,
      startSha: oldest.sha,
    },
    ref: `git:reflog:${branchKey}`,
    upstreamKey: `branch:${branchKey}:reflog-oldest:${oldest.sha}:${oldest.at ?? "unknown"}`,
  };
};

const trim = (text: string): string => text.trim();

const optional = (
  effect: Effect.Effect<string, SourceUnavailable>
): Effect.Effect<string | null> =>
  effect.pipe(
    Effect.map(trim),
    Effect.map((text) => (text === "" ? null : text)),
    Effect.orElseSucceed(() => null)
  );

const BASE_CANDIDATES = [
  "refs/remotes/origin/HEAD",
  "refs/heads/main",
  "refs/heads/master",
  "refs/remotes/origin/main",
  "refs/remotes/origin/master",
] as const;

export interface GitHistoryOptions {
  readonly baseRef?: string | null;
  readonly observedAt?: string;
  readonly runner?: GitRunner;
}

const resolveBase = (
  git: (args: readonly string[]) => Effect.Effect<string, SourceUnavailable>,
  explicit: string | null,
  branch: string | null
) =>
  Effect.gen(function* resolve() {
    const candidates =
      explicit === null
        ? BASE_CANDIDATES.filter((ref) => ref !== `refs/heads/${branch ?? ""}`)
        : [explicit];

    for (const ref of candidates) {
      const sha = yield* optional(
        git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])
      );

      if (sha !== null) {
        return { ref, sha };
      }
    }

    return null;
  });

type Git = (
  args: readonly string[]
) => Effect.Effect<string, SourceUnavailable>;

const unbornBatch = (): EventBatch => ({
  coverage: {
    adapterId: GIT_HISTORY_ADAPTER_ID,
    expectedItems: 0,
    gaps: [{ code: "unborn-head", message: "repository has no commits" }],
    observedItems: 0,
    state: "none",
    watermark: null,
    windowFrom: null,
    windowTo: null,
  },
  cursor: null,
  events: [],
});

const readEnv = (git: Git, input: CollectInput, observedAt: string) =>
  Effect.gen(function* read() {
    const topLevel = trim(yield* git(["rev-parse", "--show-toplevel"]));

    const commonDir = trim(
      yield* git(["rev-parse", "--path-format=absolute", "--git-common-dir"])
    );

    const versionText = yield* optional(git(["version"]));
    const headSha = yield* optional(git(["rev-parse", "--verify", "HEAD"]));

    const detectedBranch = yield* optional(
      git(["symbolic-ref", "--quiet", "--short", "HEAD"])
    );

    const branch = input.context.branch ?? detectedBranch;

    const env: EnvelopeEnv = {
      acquisition: "git",
      context: {
        ...input.context,
        branch,
        headSha: input.context.headSha ?? headSha,
        repoCommonDir: input.context.repoCommonDir ?? commonDir,
        worktreePath: input.context.worktreePath ?? topLevel,
      },
      observedAt,
      origin: input.origin,
      sourceVersion: versionText?.replace(/^git version /u, "") ?? null,
    };

    return { branch, env, headSha };
  });

const collectCommits = (
  git: Git,
  headSha: string,
  mergeBase: string | null,
  branchKey: string
) =>
  Effect.gen(function* commits() {
    const gaps: SourceGap[] = [];
    const range = mergeBase === null ? [headSha] : [`${mergeBase}..${headSha}`];

    const logText = yield* git([
      "log",
      "--no-color",
      "--no-renames",
      "--numstat",
      `--max-count=${GIT_HISTORY_MAX_COMMITS + 1}`,
      `--format=${LOG_FORMAT}`,
      ...range,
      "--",
    ]);

    const parsed = parseLog(logText);
    const truncated = parsed.length > GIT_HISTORY_MAX_COMMITS;
    const kept = parsed.slice(0, GIT_HISTORY_MAX_COMMITS);

    if (truncated) {
      gaps.push({
        code: "history-truncated",
        message: `more than ${GIT_HISTORY_MAX_COMMITS} commits; oldest omitted`,
      });
    }

    if (kept.some((commit) => commit.parents.length > 1)) {
      gaps.push({
        code: "merge-numstat-omitted",
        message:
          "merge commits carry no numstat; their line counts are not attributed",
      });
    }

    const drafts = kept.map((commit) =>
      commitDraft(commit, branchKey, mergeBase)
    );

    return { drafts, gaps, kept, truncated };
  });

const collectWorktree = (git: Git, branchKey: string, headSha: string) =>
  Effect.gen(function* worktree() {
    const numstat = yield* optional(
      git(["diff", "--no-color", "--no-renames", "--numstat", "HEAD", "--"])
    );

    const untracked = yield* optional(
      git(["ls-files", "--others", "--exclude-standard"])
    );

    const untrackedCount =
      untracked === null ? 0 : untracked.split("\n").filter(Boolean).length;

    if (numstat === null && untrackedCount === 0) {
      return null;
    }

    return worktreeDraft(numstat ?? "", untrackedCount, branchKey, headSha);
  });

const collectReflog = (git: Git, branch: string, branchKey: string) =>
  optional(
    git([
      "reflog",
      "show",
      "--date=iso-strict",
      "--format=%H%x1f%gd%x1f%gs",
      `refs/heads/${branch}`,
      "--",
    ])
  ).pipe(Effect.map((text) => reflogDraft(parseReflog(text ?? ""), branchKey)));

const TOLERATED_GAPS = new Set(["merge-numstat-omitted", "reflog-unavailable"]);

const batchFrom = (
  env: EnvelopeEnv,
  headSha: string,
  drafts: readonly EventDraft[],
  gaps: readonly SourceGap[],
  commits: {
    readonly kept: readonly ParsedCommit[];
    readonly truncated: boolean;
  }
): EventBatch => {
  const times = commits.kept
    .map((commit) => commit.committedAt)
    .filter((at): at is string => at !== null)
    .toSorted();

  return {
    coverage: {
      adapterId: GIT_HISTORY_ADAPTER_ID,
      expectedItems: commits.truncated ? null : commits.kept.length,
      gaps,
      observedItems: commits.kept.length,
      state: gaps.every((gap) => TOLERATED_GAPS.has(gap.code))
        ? "complete"
        : "partial",
      watermark: headSha,
      windowFrom: times[0] ?? null,
      windowTo: times.at(-1) ?? null,
    },
    cursor: { adapterId: GIT_HISTORY_ADAPTER_ID, value: headSha },
    events: drafts.map((draft) => toEnvelope(env, draft)),
  };
};

export const collectGitHistory = (
  input: CollectInput,
  options: GitHistoryOptions = {}
): Effect.Effect<EventBatch, SourceUnavailable | InvalidInput> =>
  Effect.gen(function* collect() {
    const runner = options.runner ?? nodeGitRunner;
    const cwd = input.selectedInput ?? input.context.worktreePath ?? "";

    if (cwd === "") {
      return yield* new SourceUnavailable({
        adapterId: GIT_HISTORY_ADAPTER_ID,
        message: "no repository path selected (pass --repo or --input)",
      });
    }

    const git: Git = (args) => runner(cwd, args);

    const { branch, env, headSha } = yield* readEnv(
      git,
      input,
      options.observedAt ?? DateTime.formatIso(yield* DateTime.now)
    );

    if (headSha === null) {
      return unbornBatch();
    }

    const branchKey = branch ?? `detached:${headSha}`;
    const base = yield* resolveBase(git, options.baseRef ?? null, branch);

    const mergeBase =
      base === null
        ? null
        : yield* optional(git(["merge-base", base.sha, headSha]));

    const gaps: SourceGap[] = [];

    if (mergeBase === null) {
      gaps.push({
        code: "no-base-ref",
        message:
          "no base branch resolved; history is bounded by max count and may include pre-branch commits",
      });
    }

    const commits = yield* collectCommits(git, headSha, mergeBase, branchKey);
    const drafts: EventDraft[] = [...commits.drafts];
    const worktree = yield* collectWorktree(git, branchKey, headSha);

    if (worktree !== null) {
      drafts.push(worktree);
    }

    const reflog =
      branch === null ? null : yield* collectReflog(git, branch, branchKey);

    if (reflog === null) {
      gaps.push({
        code: branch === null ? "detached-head" : "reflog-unavailable",
        message:
          "branch creation time unavailable (detached HEAD or no reflog)",
      });
    } else {
      drafts.push(reflog);
    }

    return batchFrom(env, headSha, drafts, [...gaps, ...commits.gaps], commits);
  });

export const gitHistoryCollector: DxCollector = {
  collect: (input) => collectGitHistory(input),
  descriptor: gitHistoryDescriptor,
};
