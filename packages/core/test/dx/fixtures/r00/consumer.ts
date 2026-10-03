import { unknownTokens } from "../../../../src/dx/model/attribution.js";
import type { DxEventEnvelope } from "../../../../src/dx/model/event.js";
import {
  emptyEventIdentity,
  emptyFlightContext,
} from "../../../../src/dx/model/event.js";
import { EventIdSchema } from "../../../../src/dx/model/ids.js";

export const consumerRepo = "/labelled-fixture/r00/repository";

export const consumerEvent = (id: string): DxEventEnvelope => ({
  acquisition: "file-import",
  adapterId: "dx.harness.codex",
  adapterVersion: "labelled-fixture",
  ai: {
    agentId: null,
    agentType: "main",
    branchSource: "harness-recorded",
    channel: "session-file",
    cwd: consumerRepo,
    effort: null,
    effortSource: null,
    harness: "codex",
    harnessVersion: "labelled-fixture",
    model: "fixture-model",
    modelRaw: "fixture-model",
    parentSessionId: null,
    provider: "openai",
    sessionId: "fixture-session",
    via: null,
  },
  context: {
    ...emptyFlightContext,
    branch: "fixture-branch",
    repoCommonDir: consumerRepo,
    worktreePath: consumerRepo,
  },
  eventId: EventIdSchema.make(id),
  evidence: { bounded: true, hash: null, ref: `labelled-fixture:${id}` },
  fieldSemantics: [],
  identity: {
    ...emptyEventIdentity,
    requestId: id,
    sessionId: "fixture-session",
  },
  kind: "ai.turn",
  observedAt: "2026-10-02T10:00:00.000Z",
  occurredAt: "2026-10-02T10:00:00.000Z",
  occurredAtPrecision: "exact",
  origin: "fixture",
  payload: {},
  schemaVersion: "dx.event.v2",
  sourceVersion: null,
  upstreamKey: id,
  usage: {
    premiumRequests: null,
    requestKey: id,
    serviceTier: null,
    speed: null,
    tokens: {
      ...unknownTokens,
      inputFresh: 10,
      output: 2,
      reasoning: null,
      total: 12,
    },
    toolFigure: null,
    webSearchRequests: null,
  },
});
