// @effect-diagnostics nodeBuiltinImport:off -- The git status test builds a throwaway git repository in a scratch directory.
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { EventStore } from "../../src/dx/contracts/event-store.js";
import {
  FakeEventStoreLayer,
  fakeManifest,
} from "../../src/dx/contracts/fakes.js";
import type { StoreSnapshot } from "../../src/dx/contracts/services.js";
import { makeDxHistoryCapability } from "../../src/dx/history/capability.js";
import {
  computeHistory,
  parseSince,
  unknownStatus,
} from "../../src/dx/history/compute.js";
import type { HistoryOptions } from "../../src/dx/history/compute.js";
import {
  DxHistoryOutput,
  dxHistoryContract,
} from "../../src/dx/history/contract.js";
import type {
  FlightHistoryRow,
  HistoryMeasure,
} from "../../src/dx/history/contract.js";
import { gitBranchStatus } from "../../src/dx/history/git-status.js";
import { computeAiUsage } from "../../src/dx/metrics/ai-usage/metric.js";
import { NO_COST_OPTIONS } from "../../src/dx/metrics/cost/metric.js";
import { decodePriceTable } from "../../src/dx/metrics/cost/price-table.js";
import type { DxEventEnvelope, EventKind } from "../../src/dx/model/event.js";
import {
  emptyEventIdentity,
  emptyFlightContext,
} from "../../src/dx/model/event.js";
import { EventIdSchema } from "../../src/dx/model/ids.js";

const REPO = "/fixture/history/.git";

const WORKTREE = "/fixture/history";

const OTHER = "/fixture/other/.git";

interface EventSpec {
  readonly adapterId: string;
  readonly branch: string | null;
  readonly commitSha?: string;
  readonly id: string;
  readonly kind: EventKind;
  readonly occurredAt: string;
  readonly payload: DxEventEnvelope["payload"];
  readonly repo: string | null;
  readonly sessionId?: string;
}

const event = (spec: EventSpec): DxEventEnvelope => ({
  acquisition: "file-import",
  adapterId: spec.adapterId,
  adapterVersion: "fixture",
  ai: null,
  context: {
    ...emptyFlightContext,
    branch: spec.branch,
    repoCommonDir: spec.repo,
    worktreePath: spec.repo === REPO ? WORKTREE : null,
  },
  eventId: EventIdSchema.make(spec.id),
  evidence: { bounded: true, hash: null, ref: `fixture:${spec.id}` },
  fieldSemantics: [],
  identity: {
    ...emptyEventIdentity,
    commitSha: spec.commitSha ?? null,
    sessionId: spec.sessionId ?? null,
  },
  kind: spec.kind,
  observedAt: "2026-09-30T12:00:00Z",
  occurredAt: spec.occurredAt,
  occurredAtPrecision: "exact",
  origin: "fixture",
  payload: spec.payload,
  schemaVersion: "dx.event.v2",
  sourceVersion: null,
  upstreamKey: spec.id,
  usage: null,
});

const fixtureEvents: readonly DxEventEnvelope[] = [
  event({
    adapterId: "cursor-cli",
    branch: "feat/a",
    id: "h-cli-a",
    kind: "ai.usage",
    occurredAt: "2026-09-28T10:00:00Z",
    payload: {
      charge: null,
      listPriceEstimateUsd: null,
      model: "gpt-5",
      requestKey: "source:cursor-cli:request:r1",
      sourceKind: "cursor-cli",
      tokens: {
        "cache-write": null,
        "cached-input": 400,
        input: 2000,
        output: 1000,
        reasoning: null,
        total: null,
      },
    },
    repo: REPO,
    sessionId: "chat-1",
  }),
  event({
    adapterId: "cursor-local-db",
    branch: "feat/a",
    id: "h-ldb-a",
    kind: "ai.usage",
    occurredAt: "2026-09-28T10:05:00Z",
    payload: {
      measurements: [
        {
          category: "other",
          cumulativeVerified: false,
          currency: "USD",
          ledger: "metered",
          method: "source-reported",
          rawCategory: "usageData.costInCents",
          unit: "usd-cents",
          value: 250,
        },
      ],
      model: "gpt-5",
      requests: 1,
      sourceKind: "local-db",
    },
    repo: REPO,
    sessionId: "chat-1",
  }),
  event({
    adapterId: "claude",
    branch: "feat/a",
    id: "h-claude-a",
    kind: "ai.usage",
    occurredAt: "2026-09-29T09:00:00Z",
    payload: {
      charge: null,
      listPriceEstimateUsd: 0.77,
      model: "claude-x",
      sourceKind: "claude-jsonl",
      tokens: { input: 100, output: 50 },
    },
    repo: REPO,
    sessionId: "chat-2",
  }),
  event({
    adapterId: "git-history",
    branch: "feat/a",
    commitSha: "a1a1a1",
    id: "h-commit-a",
    kind: "git.commit",
    occurredAt: "2026-09-29T11:00:00Z",
    payload: { filesChanged: 1, linesAdded: 5, linesDeleted: 1, sha: "a1a1a1" },
    repo: REPO,
  }),
  event({
    adapterId: "git-history",
    branch: "feat/b",
    commitSha: "b1b1b1",
    id: "h-commit-b",
    kind: "git.commit",
    occurredAt: "2026-09-10T08:00:00Z",
    payload: { filesChanged: 2, linesAdded: 3, linesDeleted: 0, sha: "b1b1b1" },
    repo: REPO,
  }),
  event({
    adapterId: "cursor-usage-export",
    branch: null,
    id: "h-csv-charge",
    kind: "ai.usage",
    occurredAt: "2026-09-28T12:00:00Z",
    payload: {
      charge: 1.25,
      costLedger: "charge",
      costUsd: 1.25,
      currency: "USD",
      model: "gpt-5",
      requestKey: null,
      requestUnits: 2,
      sourceKind: "usage-csv",
      tokens: { input: 3000, output: 100 },
    },
    repo: null,
  }),
  event({
    adapterId: "git-history",
    branch: "feat/x",
    commitSha: "c1c1c1",
    id: "h-commit-x",
    kind: "git.commit",
    occurredAt: "2026-09-29T15:00:00Z",
    payload: { filesChanged: 1, linesAdded: 1, linesDeleted: 0, sha: "c1c1c1" },
    repo: OTHER,
  }),
];

const snapshot: StoreSnapshot = {
  coverage: [],
  events: fixtureEvents,
  manifest: fakeManifest("history-fixture", {
    branch: null,
    flightId: null,
    from: null,
    repoCommonDir: null,
    to: null,
  }),
};

const priceTable = decodePriceTable({
  currency: "USD",
  effectiveFrom: "2026-09-01T00:00:00Z",
  id: "fixture-prices",
  models: { "gpt-5": { "cached-input": 0.125, input: 1.25, output: 10 } },
  source: "history fixture (not vendor prices)",
  unit: "usd-per-million-tokens",
  version: "2026-09-01",
});

const NOW_ISO = "2026-09-30T12:00:00.000Z";

const NOW_MS = Date.parse(NOW_ISO);

const options = (overrides: Partial<HistoryOptions> = {}): HistoryOptions => ({
  allRepos: false,
  asOf: NOW_ISO,
  costOptions: { priceTable, subscription: null },
  repoCommonDir: REPO,
  resolveStatus: (_repo, branch) =>
    branch === "feat/b"
      ? { reason: "fixture: merged", value: "merged" }
      : { reason: "fixture: open", value: "open" },
  sinceMs: null,
  ...overrides,
});

const rowOf = (
  rows: readonly FlightHistoryRow[],
  branch: string | null,
  repo: string | null = REPO
): FlightHistoryRow => {
  const found = rows.find(
    (row) => row.branch === branch && row.repoCommonDir === repo
  );

  if (found === undefined) {
    throw new Error(`no row for ${String(repo)} ${String(branch)}`);
  }

  return found;
};

const measures = (row: FlightHistoryRow): readonly HistoryMeasure[] => [
  row.activeTime,
  row.agentTime,
  row.branchAge,
  row.chats,
  row.commits,
  row.requests,
  row.money.billed,
  row.money.metered,
  row.money.estimatedSource,
  row.money.estimatedPriceTable,
  ...row.tokens.map((token) => token.measure),
];

const byName = (a: string | null, b: string | null) =>
  (a ?? "").localeCompare(b ?? "");

const tokens = (row: FlightHistoryRow, category: string) =>
  row.tokens.find((token) => token.category === category)?.measure;

describe("dx_history", () => {
  it("lists one row per flight of the current repo with separate money ledgers", () => {
    const { notes, rows } = computeHistory(snapshot, options());

    expect(rows.map((row) => row.branch).toSorted(byName)).toEqual([
      "feat/a",
      "feat/b",
    ]);
    expect(notes.some((note) => note.includes("allRepos"))).toBe(true);

    const a = rowOf(rows, "feat/a");

    expect(a.status).toEqual({ reason: "fixture: open", value: "open" });
    expect(a.worktrees).toEqual([WORKTREE]);
    expect(a.firstActivityAt).toBe("2026-09-28T10:00:00.000Z");
    expect(a.lastActivityAt).toBe("2026-09-29T11:00:00.000Z");
    expect(a.chats.value).toBe(2);
    expect(a.commits.value).toBe(1);

    const usage = computeAiUsage({
      ...snapshot,
      events: fixtureEvents.filter((item) => item.context.branch === "feat/a"),
    }).results;

    for (const token of a.tokens) {
      const expected = usage.find((r) => r.metricId === token.measure.metricId);

      expect(token.measure.value).toBe(expected?.value ?? null);
    }

    expect(tokens(a, "cached-input")?.value).toBe(400);
    expect(tokens(a, "reasoning")?.value).toBeNull();
    expect(tokens(a, "reasoning")?.reason).not.toBeNull();
    expect(a.requests.value).toBe(
      usage.find((r) => r.metricId === "dx.ai-usage.requests")?.value
    );
    expect(a.money.metered.value).toBe(2.5);
    expect(a.money.estimatedSource.value).toBe(0.77);
    expect(a.money.estimatedSource.method).toBe("estimated");
    expect(a.money.estimatedPriceTable.method).toBe("estimated");
    expect(a.money.estimatedPriceTable.value).not.toBeNull();
    expect(a.money.billed.value).toBeNull();
    expect(a.money.billed.reason).not.toBeNull();

    const b = rowOf(rows, "feat/b");

    expect(b.status.value).toBe("merged");
    expect(b.commits.value).toBe(1);
    expect(b.chats.value).toBeNull();
    expect(b.chats.reason).toBe("no AI evidence on this branch");

    for (const row of rows) {
      for (const measure of measures(row)) {
        expect(measure.value !== null || measure.reason !== null).toBe(true);
      }
    }
  });

  it("widens to every repo and keeps unattributed billed charges in their own row", () => {
    const { rows } = computeHistory(snapshot, options({ allRepos: true }));

    expect(rowOf(rows, "feat/x", OTHER).commits.value).toBe(1);

    const unassigned = rowOf(rows, null, null);

    expect(unassigned.money.billed.value).toBe(1.25);
    expect(unassigned.status.value).toBe("unknown");
    expect(rowOf(rows, "feat/a").money.billed.value).toBeNull();
  });

  it("filters flights by last activity with --since", () => {
    const since = parseSince("7d", NOW_MS);

    expect(since.ok).toBe(true);

    const sinceMs = since.ok ? since.ms : null;
    const { rows } = computeHistory(snapshot, options({ sinceMs }));

    expect(rows.map((row) => row.branch)).toEqual(["feat/a"]);
    expect(parseSince("2026-09-01T00:00:00Z", NOW_MS)).toEqual({
      ms: Date.parse("2026-09-01T00:00:00Z"),
      ok: true,
    });
    expect(parseSince("soon", NOW_MS).ok).toBe(false);
  });

  it("reports cost ledgers unavailable without a price table instead of zero", () => {
    const { notes, rows } = computeHistory(
      snapshot,
      options({ costOptions: NO_COST_OPTIONS })
    );

    const a = rowOf(rows, "feat/a");

    expect(a.money.estimatedPriceTable.value).toBeNull();
    expect(a.money.estimatedPriceTable.reason).not.toBeNull();
    expect(notes.some((note) => note.includes("price table"))).toBe(true);
  });

  it.live("serves the capability over the event store", () =>
    Effect.gen(function* capability() {
      const store = yield* EventStore;

      yield* store.append({
        coverage: {
          adapterId: "fixture",
          expectedItems: fixtureEvents.length,
          gaps: [],
          observedItems: fixtureEvents.length,
          state: "complete",
          watermark: null,
          windowFrom: null,
          windowTo: null,
        },
        cursor: null,
        events: fixtureEvents,
      });

      const cap = makeDxHistoryCapability({
        defaultRepo: WORKTREE,
        resolveContext: () => ({
          ...emptyFlightContext,
          branch: "feat/a",
          repoCommonDir: REPO,
          worktreePath: WORKTREE,
        }),
        resolveStatus: () => unknownStatus("fixture"),
      });

      expect(cap.contract.name).toBe(dxHistoryContract.name);

      const output = yield* cap.handler({ since: "2026-09-01T00:00:00Z" });

      expect(Schema.is(DxHistoryOutput)(output)).toBe(true);
      expect(output.rows.map((row) => row.branch).toSorted(byName)).toEqual([
        "feat/a",
        "feat/b",
      ]);
      expect(output.since).toBe("2026-09-01T00:00:00.000Z");

      const failure = yield* Effect.flip(cap.handler({ since: "later" }));

      expect(failure._tag).toBe("InvalidInput");
    }).pipe(Effect.provide(FakeEventStoreLayer))
  );
});

describe("git branch status", () => {
  const scratch = realpathSync(
    mkdtempSync(path.join(tmpdir(), "dft-history-"))
  );

  afterAll(() => {
    rmSync(scratch, { force: true, recursive: true });
  });

  const run = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: scratch,
      encoding: "utf-8",
      env: {
        ...process.env,
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_AUTHOR_NAME: "fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "fixture",
      },
      stdio: ["ignore", "pipe", "ignore"],
    });

  const commit = (file: string) => {
    writeFileSync(path.join(scratch, file), file);
    run("add", file);
    run("commit", "-q", "-m", file);
  };

  it("derives open, merged and deleted from local refs", () => {
    run("init", "-q", "-b", "main");
    commit("base.txt");
    run("checkout", "-q", "-b", "feat/merged");
    commit("merged.txt");
    run("checkout", "-q", "main");
    run("merge", "-q", "--no-ff", "-m", "merge", "feat/merged");
    run("checkout", "-q", "-b", "feat/open");
    commit("open.txt");
    run("checkout", "-q", "main");

    const gitDir = path.join(scratch, ".git");

    expect(gitBranchStatus(gitDir, "feat/merged").value).toBe("merged");
    expect(gitBranchStatus(gitDir, "feat/open").value).toBe("open");
    expect(gitBranchStatus(gitDir, "feat/gone").value).toBe("deleted");
    expect(gitBranchStatus(gitDir, "main")).toEqual({
      reason: "default branch",
      value: "open",
    });
    expect(gitBranchStatus("/nonexistent/.git", "main").value).toBe("unknown");
  });
});
