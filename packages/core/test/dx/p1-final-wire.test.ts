import { describe, expect, it } from "vitest";

import { joinAccountRows } from "../../src/dx/correlation/branch-at-time/snapshot.js";
import { matchSlug } from "../../src/dx/metrics/cost/price-catalog/slug.js";
import {
  emptyEventIdentity,
  emptyFlightContext,
} from "../../src/dx/model/event.js";
import type { DxEventEnvelope } from "../../src/dx/model/event.js";
import { EventIdSchema } from "../../src/dx/model/ids.js";

const REPO = "/work/repo/.git";

const event = (
  id: string,
  sessionId: string,
  context: DxEventEnvelope["context"]
): DxEventEnvelope => ({
  acquisition: "api",
  adapterId: "cursor-usage-api",
  adapterVersion: "1.0.0",
  context,
  eventId: EventIdSchema.make(id),
  evidence: { bounded: true, hash: null, ref: `fixture:${id}` },
  fieldSemantics: [],
  identity: { ...emptyEventIdentity, sessionId },
  kind: "ai.usage",
  observedAt: "2026-09-30T10:00:00.000Z",
  occurredAt: "2026-09-30T09:00:00.000Z",
  occurredAtPrecision: "second",
  origin: "fixture",
  payload: {},
  schemaVersion: "dx.event.v1",
  sourceVersion: null,
  upstreamKey: id,
});

const local = {
  ...emptyFlightContext,
  branch: "feature/a",
  repoCommonDir: REPO,
  worktreePath: "/work/repo",
};

describe("account usage rows join local sessions by conversationId", () => {
  it("moves a matching account row onto the local repo and branch, leaves others unattributed", () => {
    const joined = joinAccountRows([
      event("local", "conv-1", local),
      event("account-hit", "conv-1", emptyFlightContext),
      event("account-miss", "conv-9", emptyFlightContext),
    ]);

    expect(joined.map((e) => [e.eventId, e.context.repoCommonDir])).toEqual([
      ["local", REPO],
      ["account-hit", REPO],
      ["account-miss", null],
    ]);
    expect(joined[1]?.context.branch).toBe("feature/a");
  });
});

describe("fast tier slugs", () => {
  const ids = new Set(["grok-4.7", "grok-4.7-fast"]);

  it("prices an effort+fast slug at the fast tier, never the base tier", () => {
    expect(matchSlug("grok-4.7-high-fast", ids)).toEqual({
      catalogId: "grok-4.7-fast",
      kind: "matched",
    });
    expect(
      matchSlug("grok-4.7-high-fast", new Set(["grok-4.7"]))
    ).toMatchObject({ kind: "unavailable" });
  });

  it("keeps Auto unpriced", () => {
    expect(matchSlug("default", ids)).toMatchObject({ kind: "unavailable" });
  });
});
