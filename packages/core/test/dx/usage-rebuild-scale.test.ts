import { describe, expect, it } from "@effect/vitest";
import { DateTime, Effect } from "effect";

import { repoLocator } from "../../src/dx/correlation/attribution/locator.js";
import { attributeRepos } from "../../src/dx/correlation/attribution/repos.js";
import { attributeHistoricalBranches } from "../../src/dx/correlation/branch-at-time/attribute.js";
import { joinAccountRows } from "../../src/dx/correlation/branch-at-time/session-join.js";
import type { WorktreeTimeline } from "../../src/dx/correlation/branch-at-time/timeline.js";
import { GitRunner } from "../../src/dx/harness/git.js";
import type { MemoryRepo } from "../../src/dx/harness/git.js";
import { unknownTokens } from "../../src/dx/model/attribution.js";
import type { DxEventEnvelope } from "../../src/dx/model/event.js";
import {
  emptyEventIdentity,
  emptyFlightContext,
} from "../../src/dx/model/event.js";
import { EventIdSchema } from "../../src/dx/model/ids.js";
import { deriveUsageFacts } from "../../src/dx/usage/derive.js";

const ORCHESTRATOR = "/home/user/scratch";

const APP = `${ORCHESTRATOR}/app`;

const APP_GIT = `${APP}/.git`;

const REPOS: readonly MemoryRepo[] = [
  {
    repoCommonDir: APP_GIT,
    worktrees: [{ branch: "main", headSha: null, path: APP }],
  },
];

const START_MS = Date.parse("2026-09-01T00:00:00.000Z");

const SESSIONS = 20;

const PARENT_EVENTS = 3000;

const AGENTS = 4;

const AGENT_EVENTS = 500;

interface Spec {
  readonly at: number;
  readonly cwd: string;
  readonly id: string;
  readonly parentSessionId: string | null;
  readonly sessionId: string;
  readonly turnId: string | null;
}

const event = (spec: Spec): DxEventEnvelope => ({
  acquisition: "file-import",
  adapterId: "harness.claude-code",
  adapterVersion: "0.2.0",
  ai: {
    agentId: null,
    agentType: null,
    branchSource: "cwd-inferred",
    channel: "session-file",
    cwd: spec.cwd,
    effort: null,
    effortSource: null,
    harness: "claude-code",
    harnessVersion: null,
    model: "fixture-model",
    modelRaw: "fixture-model",
    parentSessionId: spec.parentSessionId,
    provider: "anthropic",
    sessionId: spec.sessionId,
    via: null,
  },
  context: { ...emptyFlightContext },
  eventId: EventIdSchema.make(spec.id),
  evidence: { bounded: true, hash: null, ref: `fixture:${spec.id}` },
  fieldSemantics: [],
  identity: {
    ...emptyEventIdentity,
    requestId: `req-${spec.id}`,
    sessionId: spec.sessionId,
    turnId: spec.turnId,
  },
  kind: "ai.usage",
  observedAt: DateTime.formatIso(DateTime.makeUnsafe(spec.at)),
  occurredAt: DateTime.formatIso(DateTime.makeUnsafe(spec.at)),
  occurredAtPrecision: "exact",
  origin: "fixture",
  payload: {},
  schemaVersion: "dx.event.v2",
  sourceVersion: null,
  upstreamKey: spec.id,
  usage: {
    premiumRequests: null,
    requestKey: `request:${spec.id}`,
    serviceTier: null,
    speed: null,
    tokens: { ...unknownTokens, total: 100 },
    toolFigure: null,
  },
});

const sessionEvents = (session: number): DxEventEnvelope[] => {
  const sessionId = `session-${String(session)}`;
  const base = START_MS + session * 86_400_000;

  const parent = Array.from({ length: PARENT_EVENTS }, (_, index) =>
    event({
      at: base + index * 10_000,
      cwd: ORCHESTRATOR,
      id: `${sessionId}-p${String(index)}`,
      parentSessionId: null,
      sessionId,
      turnId: index % 2 === 0 ? null : `turn-${String(Math.floor(index / 20))}`,
    })
  );

  const agents = Array.from({ length: AGENTS }, (_, agent) =>
    Array.from({ length: AGENT_EVENTS }, (__, index) =>
      event({
        at: base + agent * 5_000_000 + index * 9000,
        cwd: index % 3 === 0 ? ORCHESTRATOR : APP,
        id: `${sessionId}-a${String(agent)}-${String(index)}`,
        parentSessionId: sessionId,
        sessionId: `${sessionId}-agent-${String(agent)}`,
        turnId: null,
      })
    )
  ).flat();

  return [...parent, ...agents];
};

const timeline: WorktreeTimeline = {
  currentBranch: "main",
  currentSinceMs: START_MS,
  moves: [{ atMs: START_MS, branch: "main", detached: false }],
  points: [],
  reflogFromMs: START_MS,
  worktree: APP,
};

describe("usage facts rebuild at scale", () => {
  it.effect(
    "derives 100k events of long sessions with subagents in seconds",
    () =>
      Effect.gen(function* scenario() {
        const events = Array.from({ length: SESSIONS }, (_, session) =>
          sessionEvents(session)
        ).flat();

        expect(events).toHaveLength(
          SESSIONS * (PARENT_EVENTS + AGENTS * AGENT_EVENTS)
        );

        const locator = yield* repoLocator;
        const placed = yield* attributeRepos(locator, events);
        const joined = joinAccountRows(placed.events);

        const history = attributeHistoricalBranches(joined, {
          commitBranches: new Map(),
          timelines: [timeline],
        });

        const { facts } = deriveUsageFacts(history.events);

        expect(facts.reduce((sum, fact) => sum + fact.requests, 0)).toBe(
          history.events.length
        );
        expect(
          facts.filter((fact) => fact.repo === APP_GIT).length
        ).toBeGreaterThan(SESSIONS * PARENT_EVENTS);
      }).pipe(Effect.provide(GitRunner.memory(REPOS))),
    { timeout: 20_000 }
  );
});
