import { Option, Schema } from "effect";

import type { StoreSnapshot } from "../../contracts/services.js";
import type { SourceCoverage } from "../../model/coverage.js";
import type { DxEventEnvelope } from "../../model/event.js";
import type { EvidenceId } from "../../model/ids.js";
import { EvidenceIdSchema } from "../../model/ids.js";

export const GIT_CHURN_SOURCE_ADAPTER_ID = "git-history";

export const BASE_SHA_DEFINITION =
  "baseSha = the branch fork point recorded by the git-history collector, labelled by baseMethod: explicit (merge-base with the --base ref), reflog (the commit the branch pointed at when the reflog recorded 'branch: Created from <ref>', or the merge-base with that ref when closer), ancestor-branch (the closest merge-base with another local branch tip, used when the reflog is expired or absent) or default (merge-base with the first of origin/HEAD, main, master, origin/main, origin/master that is not the current branch). The default branch itself always uses the default method. Among candidates the one closest to HEAD wins, so a branch that later merged its parent is not over-counted. Branch totals cover commits in baseSha..HEAD; merge commits carry no numstat and contribute no lines.";

export interface CommitFacts {
  readonly baseMethod: string | null;
  readonly baseRef: string | null;
  readonly baseSha: string | null;
  readonly binaryFiles: number;
  readonly evidenceId: EvidenceId;
  readonly filesChanged: number | null;
  readonly isMerge: boolean;
  readonly linesAdded: number | null;
  readonly linesDeleted: number | null;
  readonly numstatAvailable: boolean;
  readonly paths: readonly string[];
  readonly pathsTruncated: boolean;
  readonly sha: string;
}

export interface WorktreeFacts {
  readonly evidenceId: EvidenceId;
  readonly filesChanged: number | null;
  readonly headSha: string | null;
  readonly linesAdded: number | null;
  readonly linesDeleted: number | null;
  readonly untrackedFiles: number | null;
}

export interface GitChurnBase {
  readonly method: string | null;
  readonly ref: string | null;
  readonly sha: string;
}

export interface GitChurnSummary {
  readonly bases: readonly GitChurnBase[];
  readonly baseShas: readonly string[];
  readonly binaryFiles: number;
  readonly branches: readonly string[];
  readonly commitEvidence: readonly EvidenceId[];
  readonly commits: number;
  readonly coverage: readonly SourceCoverage[];
  readonly distinctFiles: number;
  readonly filesRetouched: number;
  readonly headShas: readonly string[];
  readonly linesAdded: number;
  readonly linesDeleted: number;
  readonly mergeCommits: number;
  readonly pathsTruncated: boolean;
  readonly sourcePresent: boolean;
  readonly unmeasuredCommits: number;
  readonly worktree: WorktreeFacts | null;
}

const CommitPayloadSchema = Schema.Struct({
  baseMethod: Schema.optional(Schema.NullOr(Schema.String)),
  baseRef: Schema.optional(Schema.NullOr(Schema.String)),
  baseSha: Schema.optional(Schema.NullOr(Schema.String)),
  binaryFiles: Schema.optional(Schema.NullOr(Schema.Finite)),
  filesChanged: Schema.optional(Schema.NullOr(Schema.Finite)),
  isMerge: Schema.optional(Schema.Boolean),
  linesAdded: Schema.optional(Schema.NullOr(Schema.Finite)),
  linesDeleted: Schema.optional(Schema.NullOr(Schema.Finite)),
  numstatAvailable: Schema.optional(Schema.Boolean),
  paths: Schema.optional(Schema.Array(Schema.String)),
  pathsTruncated: Schema.optional(Schema.Boolean),
  sha: Schema.optional(Schema.NullOr(Schema.String)),
});

const WorktreePayloadSchema = Schema.Struct({
  filesChanged: Schema.optional(Schema.NullOr(Schema.Finite)),
  headSha: Schema.optional(Schema.NullOr(Schema.String)),
  linesAdded: Schema.optional(Schema.NullOr(Schema.Finite)),
  linesDeleted: Schema.optional(Schema.NullOr(Schema.Finite)),
  scope: Schema.Literal("uncommitted-worktree"),
  untrackedFiles: Schema.optional(Schema.NullOr(Schema.Finite)),
});

const decodeCommit = Schema.decodeUnknownOption(CommitPayloadSchema);

const decodeWorktree = Schema.decodeUnknownOption(WorktreePayloadSchema);

const isGitHistory = (event: DxEventEnvelope): boolean =>
  event.adapterId === GIT_CHURN_SOURCE_ADAPTER_ID;

export const commitFacts = (event: DxEventEnvelope): CommitFacts | null =>
  Option.match(decodeCommit(event.payload), {
    onNone: () => null,
    onSome: (payload) => {
      const sha = payload.sha ?? event.identity.commitSha;

      if (sha === null || sha === "") {
        return null;
      }

      const isMerge = payload.isMerge === true;

      return {
        baseMethod: payload.baseMethod ?? null,
        baseRef: payload.baseRef ?? null,
        baseSha: payload.baseSha ?? null,
        binaryFiles: payload.binaryFiles ?? 0,
        evidenceId: EvidenceIdSchema.make(event.eventId),
        filesChanged: payload.filesChanged ?? null,
        isMerge,
        linesAdded: payload.linesAdded ?? null,
        linesDeleted: payload.linesDeleted ?? null,
        numstatAvailable: payload.numstatAvailable !== false && !isMerge,
        paths: payload.paths ?? [],
        pathsTruncated: payload.pathsTruncated === true,
        sha,
      };
    },
  });

const worktreeFacts = (event: DxEventEnvelope): WorktreeFacts | null =>
  Option.match(decodeWorktree(event.payload), {
    onNone: () => null,
    onSome: (payload) => ({
      evidenceId: EvidenceIdSchema.make(event.eventId),
      filesChanged: payload.filesChanged ?? null,
      headSha: payload.headSha ?? event.identity.commitSha,
      linesAdded: payload.linesAdded ?? null,
      linesDeleted: payload.linesDeleted ?? null,
      untrackedFiles: payload.untrackedFiles ?? null,
    }),
  });

const distinct = (values: readonly (string | null)[]): readonly string[] =>
  [
    ...new Set(values.filter((value): value is string => value !== null)),
  ].toSorted();

interface LocatedWorktree {
  readonly event: DxEventEnvelope;
  readonly facts: WorktreeFacts;
}

const newestFirst = (a: LocatedWorktree, b: LocatedWorktree): number => {
  if (a.event.observedAt === b.event.observedAt) {
    return a.event.eventId < b.event.eventId ? 1 : -1;
  }

  return a.event.observedAt < b.event.observedAt ? 1 : -1;
};

const latestWorktree = (
  events: readonly DxEventEnvelope[],
  headShas: readonly string[]
): WorktreeFacts | null => {
  const candidates = events.flatMap((event): LocatedWorktree[] => {
    const facts = event.kind === "git.diff" ? worktreeFacts(event) : null;

    if (facts === null) {
      return [];
    }

    const matchesHead =
      headShas.length === 0 ||
      facts.headSha === null ||
      headShas.includes(facts.headSha);

    return matchesHead ? [{ event, facts }] : [];
  });

  return candidates.toSorted(newestFirst)[0]?.facts ?? null;
};

const dedupeCommits = (
  events: readonly DxEventEnvelope[]
): readonly CommitFacts[] => {
  const bySha = new Map<string, CommitFacts>();

  for (const event of events) {
    if (event.kind !== "git.commit") {
      continue;
    }

    const facts = commitFacts(event);

    if (facts !== null && !bySha.has(facts.sha)) {
      bySha.set(facts.sha, facts);
    }
  }

  return [...bySha.values()];
};

const distinctBases = (
  commits: readonly CommitFacts[]
): readonly GitChurnBase[] => {
  const byKey = new Map<string, GitChurnBase>();

  for (const commit of commits) {
    if (commit.baseSha === null) {
      continue;
    }

    const base = {
      method: commit.baseMethod,
      ref: commit.baseRef,
      sha: commit.baseSha,
    };

    byKey.set(`${base.sha}\u0000${base.method}\u0000${base.ref}`, base);
  }

  return [...byKey.values()].toSorted((a, b) =>
    a.sha === b.sha
      ? `${a.method}${a.ref}`.localeCompare(`${b.method}${b.ref}`)
      : a.sha.localeCompare(b.sha)
  );
};

const pathTouchCounts = (
  commits: readonly CommitFacts[]
): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>();

  for (const commit of commits) {
    for (const path of new Set(commit.paths)) {
      counts.set(path, (counts.get(path) ?? 0) + 1);
    }
  }

  return counts;
};

export const summarizeGitChurn = (snapshot: StoreSnapshot): GitChurnSummary => {
  const events = snapshot.events.filter(isGitHistory);
  const commits = dedupeCommits(events);
  const measured = commits.filter((commit) => commit.numstatAvailable);
  const touches = pathTouchCounts(measured);

  const headShas = distinct(
    events
      .filter((event) => event.kind === "git.commit")
      .map((event) => event.context.headSha)
  );

  const coverage = snapshot.coverage.filter(
    (item) => item.adapterId === GIT_CHURN_SOURCE_ADAPTER_ID
  );

  return {
    baseShas: distinct(commits.map((commit) => commit.baseSha)),
    bases: distinctBases(commits),
    binaryFiles: measured.reduce((total, c) => total + c.binaryFiles, 0),
    branches: distinct(events.map((event) => event.context.branch)),
    commitEvidence: commits.map((commit) => commit.evidenceId),
    commits: commits.length,
    coverage,
    distinctFiles: touches.size,
    filesRetouched: [...touches.values()].filter((count) => count > 1).length,
    headShas,
    linesAdded: measured.reduce((total, c) => total + (c.linesAdded ?? 0), 0),
    linesDeleted: measured.reduce(
      (total, c) => total + (c.linesDeleted ?? 0),
      0
    ),
    mergeCommits: commits.filter((commit) => commit.isMerge).length,
    pathsTruncated: measured.some((commit) => commit.pathsTruncated),
    sourcePresent: events.length > 0 || coverage.length > 0,
    unmeasuredCommits: commits.length - measured.length,
    worktree: latestWorktree(events, headShas),
  };
};
