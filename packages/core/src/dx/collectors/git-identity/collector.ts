import { NodeServices } from "@effect/platform-node";
import { Crypto, DateTime, Effect } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";

import { InvalidInput } from "../../contracts/error-invalid-input.js";
import type { CollectInput, DxCollector } from "../../contracts/services.js";
import { CONTRACT_VERSION } from "../../contracts/version.js";
import type { SourceCoverage } from "../../model/coverage.js";
import type { ModuleDescriptor } from "../../model/descriptor.js";
import { EVENT_SCHEMA_VERSION, emptyEventIdentity } from "../../model/event.js";
import type {
  DxEventEnvelope,
  EventBatch,
  FieldSemantics,
} from "../../model/event.js";
import { DescriptorIdSchema, EventIdSchema } from "../../model/ids.js";
import { GIT_IDENTITY_ADAPTER_ID, gitRunFor } from "./git-runner.js";
import { resolveGitIdentity } from "./identity.js";
import type { GitIdentity } from "./identity.js";

export const GIT_IDENTITY_ADAPTER_VERSION = "1.0.0";

export const GIT_IDENTITY_FIXTURE_IDS = ["b02-git-context-redacted"];

export const gitIdentityDescriptor: ModuleDescriptor = {
  contractVersion: CONTRACT_VERSION,
  fixtureIds: GIT_IDENTITY_FIXTURE_IDS,
  gaps: [
    {
      code: "base-heuristic",
      message:
        "base ref is origin/HEAD, else the first local main/master/trunk/develop; no explicit base override yet",
    },
    {
      code: "reflog-dependent-branch-creation",
      message:
        "branch creation time comes from the local reflog and is unavailable when the reflog is missing or expired",
    },
  ],
  id: DescriptorIdSchema.make("collector.git-identity"),
  kind: "collector",
  owner: "B02",
  readiness: "ready",
  requiredInputs: ["local Git working tree path (--repo or --input)"],
  supportedFields: [
    "context.repoCommonDir",
    "context.worktreePath",
    "context.branch",
    "context.headSha",
    "payload.gitDir",
    "payload.isLinkedWorktree",
    "payload.detached",
    "payload.dirty",
    "payload.dirtyEntries",
    "payload.baseRef",
    "payload.baseSource",
    "payload.baseSha",
    "payload.onBaseBranch",
    "payload.aheadCount",
    "payload.branchCreatedAt",
    "payload.branchCreatedFrom",
    "payload.firstBranchCommitAt",
    "payload.worktreeCount",
    "payload.sameBranchWorktrees",
  ],
  version: GIT_IDENTITY_ADAPTER_VERSION,
};

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

export const sha256 = Effect.fn("GitIdentity.sha256")(function* sha256(
  text: string
) {
  const crypto = yield* Crypto.Crypto;

  const digest = yield* crypto
    .digest("SHA-256", new TextEncoder().encode(text))
    .pipe(Effect.orDie);

  return `sha256:${hex(digest)}`;
});

export const gitContextUpstreamKey = (identity: GitIdentity): string =>
  [
    "context",
    identity.worktreePath,
    identity.headSha ?? "unborn",
    identity.branch ?? "detached",
    identity.baseSha ?? "no-base",
  ].join(":");

const FIELD_SEMANTICS: readonly FieldSemantics[] = [
  {
    field: "baseSha",
    method: "derived",
    note: "merge-base of HEAD and baseRef",
    rawName: "git merge-base",
    unit: null,
  },
  {
    field: "aheadCount",
    method: "observed",
    note: "commits reachable from HEAD but not from baseSha",
    rawName: "git rev-list --count",
    unit: "commits",
  },
  {
    field: "branchCreatedAt",
    method: "observed",
    note: "oldest local reflog entry 'branch: Created from'",
    rawName: "git reflog",
    unit: null,
  },
  {
    field: "firstBranchCommitAt",
    method: "observed",
    note: "author date of the oldest commit in baseSha..HEAD; author dates can be rewritten",
    rawName: "git log %aI",
    unit: null,
  },
  {
    field: "dirtyEntries",
    method: "observed",
    note: "git status porcelain entries at observation time",
    rawName: "git status --porcelain",
    unit: "entries",
  },
];

export const buildGitContextBatch = Effect.fn("GitIdentity.buildBatch")(
  function* buildGitContextBatch(
    identity: GitIdentity,
    input: CollectInput,
    observedAt: string
  ) {
    const upstreamKey = gitContextUpstreamKey(identity);

    const payload = {
      aheadCount: identity.aheadCount,
      baseRef: identity.baseRef,
      baseSha: identity.baseSha,
      baseSource: identity.baseSource,
      branchCreatedAt: identity.branchCreatedAt,
      branchCreatedFrom: identity.branchCreatedFrom,
      detached: identity.detached,
      dirty: identity.dirtyEntries === null ? null : identity.dirtyEntries > 0,
      dirtyEntries: identity.dirtyEntries,
      firstBranchCommitAt: identity.firstBranchCommitAt,
      gitDir: identity.gitDir,
      isLinkedWorktree: identity.isLinkedWorktree,
      onBaseBranch: identity.onBaseBranch,
      sameBranchWorktrees: identity.sameBranchWorktrees,
      unavailable: identity.gaps,
      worktreeCount: identity.worktreeCount,
    };

    const eventId = yield* sha256(
      `${GIT_IDENTITY_ADAPTER_ID}\u0000${upstreamKey}\u0000git.context`
    );

    const evidenceHash = yield* sha256(JSON.stringify(payload));

    const event: DxEventEnvelope = {
      acquisition: "git",
      adapterId: GIT_IDENTITY_ADAPTER_ID,
      adapterVersion: GIT_IDENTITY_ADAPTER_VERSION,
      context: {
        branch: identity.branch,
        flightId: input.context.flightId,
        headSha: identity.headSha,
        repoCommonDir: identity.repoCommonDir,
        worktreePath: identity.worktreePath,
      },
      eventId: EventIdSchema.make(eventId),
      evidence: {
        bounded: true,
        hash: evidenceHash,
        ref: `git://${upstreamKey}`,
      },
      fieldSemantics: FIELD_SEMANTICS,
      identity: emptyEventIdentity,
      kind: "git.context",
      observedAt,
      occurredAt: observedAt,
      occurredAtPrecision: "exact",
      origin: input.origin,
      payload,
      schemaVersion: EVENT_SCHEMA_VERSION,
      sourceVersion: identity.gitVersion,
      upstreamKey,
    };

    const coverage: SourceCoverage = {
      adapterId: GIT_IDENTITY_ADAPTER_ID,
      expectedItems: 1,
      gaps: identity.gaps.map((gap) => ({
        code: `unavailable:${gap.field}`,
        message: gap.reason,
      })),
      observedItems: 1,
      state: identity.gaps.length === 0 ? "complete" : "partial",
      watermark: upstreamKey,
      windowFrom: observedAt,
      windowTo: observedAt,
    };

    return {
      coverage,
      cursor: { adapterId: GIT_IDENTITY_ADAPTER_ID, value: upstreamKey },
      events: [event],
    } satisfies EventBatch;
  }
);

const selectRepoPath = (input: CollectInput) => {
  const selected = input.selectedInput ?? input.context.worktreePath;

  return selected === null || selected.trim() === ""
    ? Effect.fail(
        new InvalidInput({
          field: "input",
          message:
            "git-identity needs an explicitly selected local repository path (--repo or --input)",
        })
      )
    : Effect.succeed(selected);
};

export const collectGitIdentity = Effect.fn("GitIdentity.collect")(
  function* collectGitIdentity(input: CollectInput) {
    const repoPath = yield* selectRepoPath(input);
    const run = yield* gitRunFor(repoPath);
    const identity = yield* resolveGitIdentity(run);
    const observedAt = DateTime.formatIso(yield* DateTime.now);

    return yield* buildGitContextBatch(identity, input, observedAt);
  }
);

export const gitIdentityCollectorEffect: DxCollector<
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> = {
  collect: collectGitIdentity,
  descriptor: gitIdentityDescriptor,
};

export const gitIdentityCollector: DxCollector = {
  collect: (input) =>
    collectGitIdentity(input).pipe(Effect.provide(NodeServices.layer)),
  descriptor: gitIdentityDescriptor,
};
