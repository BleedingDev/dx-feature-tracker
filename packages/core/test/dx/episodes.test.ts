import { describe, expect, it } from "@effect/vitest";

import type { StoreSnapshot } from "../../src/dx/contracts/services.js";
import {
  computeEpisodes,
  episodesDescriptor,
  makeEpisodesMetric,
  splitEpisodes,
} from "../../src/dx/metrics/episodes/metric.js";
import type { DxEventEnvelope } from "../../src/dx/model/event.js";
import {
  emptyEventIdentity,
  emptyFlightContext,
} from "../../src/dx/model/event.js";
import { EventIdSchema, SnapshotIdSchema } from "../../src/dx/model/ids.js";

const BRANCH = "feature/retro";

const NOW = "2026-09-30T10:00:00.000Z";

const usage = (
  id: string,
  occurredAt: string,
  input: number,
  output: number,
  charge: number
): DxEventEnvelope => ({
  acquisition: "file-import",
  adapterId: "cursor-usage-export",
  adapterVersion: "1.0.0",
  context: { ...emptyFlightContext, branch: BRANCH },
  eventId: EventIdSchema.make(id),
  evidence: { bounded: true, hash: null, ref: `fixture:${id}` },
  fieldSemantics: [],
  identity: { ...emptyEventIdentity, requestId: id },
  kind: "ai.usage",
  observedAt: NOW,
  occurredAt,
  occurredAtPrecision: "second",
  origin: "fixture",
  payload: {
    charge,
    costLedger: "charge",
    costUsd: charge,
    sourceKind: "usage-csv",
    tokens: { input, output },
  },
  schemaVersion: "dx.event.v1",
  sourceVersion: null,
  upstreamKey: id,
});

const commit = (id: string, occurredAt: string): DxEventEnvelope => ({
  ...usage(id, occurredAt, 0, 0, 0),
  acquisition: "git",
  adapterId: "git-history",
  identity: { ...emptyEventIdentity, commitSha: `sha-${id}` },
  kind: "git.commit",
  payload: {},
});

const snapshotOf = (events: readonly DxEventEnvelope[]): StoreSnapshot => ({
  coverage: [],
  events,
  manifest: {
    contractDigest: "fixture",
    contractVersion: "dx.contracts.v1",
    createdAt: NOW,
    enabledDescriptors: [],
    eventWatermark: "fixture",
    metricDefinitions: [],
    originMix: [],
    selector: {
      branch: BRANCH,
      flightId: null,
      from: null,
      repoCommonDir: null,
      to: null,
    },
    snapshotId: SnapshotIdSchema.make("fixture-episodes"),
  },
});

const events = [
  usage("past-1", "2026-08-30T09:00:00.000Z", 1000, 100, 0.4),
  usage("past-2", "2026-08-30T11:00:00.000Z", 2000, 200, 0.6),
  commit("past-commit", "2026-08-30T12:00:00.000Z"),
  usage("now-1", "2026-09-30T08:00:00.000Z", 500, 50, 0.25),
  {
    ...usage("other", "2026-09-30T08:30:00.000Z", 9, 9, 9),
    context: { ...emptyFlightContext, branch: "main" },
  },
];

const valueOf = (
  results: ReturnType<typeof computeEpisodes>["results"],
  metricId: string,
  checkpoint: string
) =>
  results.find((r) => r.metricId === metricId && r.checkpoint === checkpoint)
    ?.value;

describe("episodes metric", () => {
  it("splits month-apart burns and marks the latest as current", () => {
    const episodes = splitEpisodes(events.slice(0, 4), Date.parse(NOW));

    expect(episodes.map((e) => [e.index, e.events.length, e.current])).toEqual([
      [1, 3, false],
      [2, 1, true],
    ]);

    const { results } = computeEpisodes(snapshotOf(events));

    expect(valueOf(results, "dx.episode.commits", "episode:1")).toBe(1);
    expect(valueOf(results, "dx.episode.current", "episode:2:current")).toBe(1);
    expect(valueOf(results, "dx.episode.ai-usage.requests", "episode:1")).toBe(
      2
    );
    expect(
      valueOf(results, "dx.episode.ai-usage.tokens.input", "episode:1")
    ).toBe(3000);
    expect(
      valueOf(results, "dx.episode.ai-usage.tokens.input", "episode:2:current")
    ).toBe(500);
    expect(
      valueOf(results, "dx.episode.cost.charge.usd", "episode:1")
    ).toBeCloseTo(1);
    expect(
      valueOf(results, "dx.episode.cost.charge.usd", "episode:2:current")
    ).toBeCloseTo(0.25);
    expect(
      results.every((r) => r.value !== null || (r.reason ?? "") !== "")
    ).toBe(true);
  });

  it("honours a configurable idle gap", () => {
    const wide = makeEpisodesMetric({
      currentWindowMs: 24 * 60 * 60 * 1000,
      idleGapMs: 60 * 24 * 60 * 60 * 1000,
    });

    const checkpoints = new Set(
      wide.compute(snapshotOf(events)).results.map((r) => r.checkpoint)
    );

    expect([...checkpoints]).toEqual(["episode:1:current"]);
    expect(wide.descriptor).toBe(episodesDescriptor);
  });
});
