import { describe, expect, it } from "@effect/vitest";

import { attributeHistoricalBranches } from "../../src/dx/correlation/branch-at-time/attribute.js";
import type { WorktreeTimeline } from "../../src/dx/correlation/branch-at-time/timeline.js";
import { HARNESS_IDS } from "../../src/dx/harness/ids.js";
import type { BranchSource, HarnessId } from "../../src/dx/harness/ids.js";
import { rulesForEvent } from "../../src/dx/harness/rules.js";
import type { AiAttribution } from "../../src/dx/model/attribution.js";
import type { DxEventEnvelope } from "../../src/dx/model/event.js";
import {
  emptyEventIdentity,
  emptyFlightContext,
} from "../../src/dx/model/event.js";
import { EventIdSchema } from "../../src/dx/model/ids.js";

const WORKTREE = "/work/app";

const CHECKED_OUT_AT = "2026-09-30T08:00:00.000Z";

const REQUEST_AT = "2026-09-30T10:00:00.000Z";

const timeline: WorktreeTimeline = {
  currentBranch: "main",
  currentSinceMs: Date.parse(CHECKED_OUT_AT),
  moves: [
    { atMs: Date.parse(CHECKED_OUT_AT), branch: "main", detached: false },
  ],
  points: [],
  reflogFromMs: Date.parse(CHECKED_OUT_AT),
  worktree: WORKTREE,
};

const attribution = (
  harness: HarnessId,
  branchSource: BranchSource
): AiAttribution => ({
  agentId: null,
  agentType: null,
  branchSource,
  channel: "session-file",
  cwd: WORKTREE,
  effort: null,
  effortSource: null,
  harness,
  harnessVersion: null,
  model: "fixture-model",
  modelRaw: "fixture-model",
  parentSessionId: null,
  provider: "unknown",
  sessionId: "session-1",
  via: null,
});

interface EventSpec {
  readonly acquisition?: DxEventEnvelope["acquisition"];
  readonly ai: AiAttribution | null;
  readonly branch: string | null;
  readonly id: string;
  readonly occurredAt: string | null;
  readonly worktreePath?: string | null;
}

const event = (spec: EventSpec): DxEventEnvelope => ({
  acquisition: spec.acquisition ?? "file-import",
  adapterId: "harness.fixture",
  adapterVersion: "0.2.0",
  ai: spec.ai,
  context: {
    ...emptyFlightContext,
    branch: spec.branch,
    worktreePath:
      spec.worktreePath === undefined ? WORKTREE : spec.worktreePath,
  },
  eventId: EventIdSchema.make(spec.id),
  evidence: { bounded: true, hash: null, ref: `fixture:${spec.id}` },
  fieldSemantics: [],
  identity: { ...emptyEventIdentity, sessionId: "session-1" },
  kind: spec.acquisition === "hook" ? "other" : "ai.usage",
  observedAt: spec.occurredAt ?? REQUEST_AT,
  occurredAt: spec.occurredAt,
  occurredAtPrecision: "exact",
  origin: "fixture",
  payload: {},
  schemaVersion: "dx.event.v2",
  sourceVersion: null,
  upstreamKey: spec.id,
  usage: null,
});

const attribute = (events: readonly DxEventEnvelope[]) => {
  const result = attributeHistoricalBranches(events, {
    commitBranches: new Map(),
    timelines: [timeline],
  });

  return new Map<string, { branch: string | null; source: string | null }>(
    result.events.map((rewritten) => [
      rewritten.eventId,
      {
        branch: rewritten.context.branch,
        source: rewritten.ai?.branchSource ?? null,
      },
    ])
  );
};

describe("branch precedence (D28)", () => {
  it("keeps the branch a tool recorded on the request over checkout history", () => {
    const result = attribute([
      event({
        ai: attribution("claude-code", "harness-recorded"),
        branch: "feature/recorded",
        id: "recorded",
        occurredAt: REQUEST_AT,
      }),
    ]);

    expect(result.get("recorded")).toStrictEqual({
      branch: "feature/recorded",
      source: "harness-recorded",
    });
  });

  it("lets checkout history win over a branch recorded once at session start", () => {
    const result = attribute([
      event({
        ai: attribution("codex", "session-recorded"),
        branch: "feature/at-start",
        id: "session-start",
        occurredAt: REQUEST_AT,
      }),
    ]);

    expect(result.get("session-start")).toStrictEqual({
      branch: "main",
      source: "git-at-time",
    });
  });

  it("gives a tool's request the branch its hook saw during the same turn", () => {
    const result = attribute([
      event({
        acquisition: "hook",
        ai: { ...attribution("codex", "hook"), channel: "hooks" },
        branch: "feature/hooked",
        id: "hook-turn",
        occurredAt: "2026-09-30T09:59:00.000Z",
      }),
      event({
        ai: attribution("codex", "session-recorded"),
        branch: "feature/at-start",
        id: "request",
        occurredAt: REQUEST_AT,
      }),
    ]);

    expect(result.get("request")).toStrictEqual({
      branch: "feature/hooked",
      source: "hook",
    });
  });
});

const PRECEDENCE_STEPS = [
  {
    branch: "feature/recorded",
    expected: { branch: "feature/recorded", source: "harness-recorded" },
    name: "a branch the tool recorded on the row",
    source: "harness-recorded",
  },
  {
    branch: "feature/at-start",
    expected: { branch: "main", source: "git-at-time" },
    name: "checkout history over a branch recorded once per session",
    source: "session-recorded",
  },
  {
    branch: "HEAD",
    expected: { branch: "main", source: "git-at-time" },
    name: "checkout history over a recorded HEAD",
    source: "harness-recorded",
  },
] as const;

describe.each(HARNESS_IDS)("branch precedence (D28) for %s", (harness) => {
  it.each(PRECEDENCE_STEPS)("takes $name", (step) => {
    const result = attribute([
      event({
        ai: attribution(harness, step.source),
        branch: step.branch,
        id: "row",
        occurredAt: REQUEST_AT,
      }),
    ]);

    expect(result.get("row")).toStrictEqual(step.expected);
  });

  it("takes the hook turn's branch before checkout history when the tool's rule allows it", () => {
    const request = event({
      ai: attribution(harness, "session-recorded"),
      branch: null,
      id: "request",
      occurredAt: REQUEST_AT,
    });

    const result = attribute([
      event({
        acquisition: "hook",
        ai: { ...attribution(harness, "hook"), channel: "hooks" },
        branch: "feature/hooked",
        id: "hook-turn",
        occurredAt: "2026-09-30T09:58:00.000Z",
      }),
      request,
    ]);

    expect(result.get("request")).toStrictEqual(
      rulesForEvent(request).takesHookTurn(request)
        ? { branch: "feature/hooked", source: "hook" }
        : { branch: "main", source: "git-at-time" }
    );
  });

  it("falls back to the folder's branch when the row has no time", () => {
    const result = attribute([
      event({
        ai: attribution(harness, "cwd-inferred"),
        branch: "feature/folder",
        id: "untimed",
        occurredAt: null,
      }),
    ]);

    expect(result.get("untimed")).toStrictEqual({
      branch: "feature/folder",
      source: "cwd-inferred",
    });
  });

  it("leaves the row unassigned when nothing knows the branch", () => {
    const result = attribute([
      event({
        ai: attribution(harness, "cwd-inferred"),
        branch: null,
        id: "lost",
        occurredAt: REQUEST_AT,
        worktreePath: null,
      }),
    ]);

    expect(result.get("lost")).toStrictEqual({
      branch: null,
      source: "unassigned",
    });
  });
});
