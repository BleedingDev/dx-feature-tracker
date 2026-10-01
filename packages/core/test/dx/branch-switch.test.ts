// @effect-diagnostics nodeBuiltinImport:off -- The branch switch test scripts a throwaway git repository in a scratch directory.
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { afterAll, describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { makeDxChatsCapability } from "../../src/dx/chats/capability.js";
import type { ChatNode } from "../../src/dx/chats/contract.js";
import { EventStore } from "../../src/dx/contracts/event-store.js";
import { attributeHistoricalBranches } from "../../src/dx/correlation/branch-at-time/attribute.js";
import { joinAccountRows } from "../../src/dx/correlation/branch-at-time/snapshot.js";
import { withCollectorBlocks } from "../../src/dx/harness/collector-blocks.js";
import { makeDxHistoryCapability } from "../../src/dx/history/capability.js";
import { unknownStatus } from "../../src/dx/history/compute.js";
import type { DxEventEnvelope } from "../../src/dx/model/event.js";
import {
  emptyEventIdentity,
  emptyFlightContext,
} from "../../src/dx/model/event.js";
import { EventIdSchema, SnapshotIdSchema } from "../../src/dx/model/ids.js";
import { selectAnalyzeSnapshot } from "../../src/dx/reports/analyze/select.js";
import { FakeEventStoreLayer, fakeManifest } from "./fakes.js";

const CONVERSATION = "conv-C";

const T = {
  t1: "2026-09-29T09:00:00.000Z",
  t2: "2026-09-29T09:10:00.000Z",
  t3: "2026-09-29T09:20:00.000Z",
  t4: "2026-09-29T10:00:00.000Z",
  t5: "2026-09-29T10:30:00.000Z",
  t6: "2026-09-29T10:40:00.000Z",
};

const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "dft-switch-")));

const REPO = path.join(scratch, ".git");

const git = (date: string, ...args: string[]) =>
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd: scratch,
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: date,
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_AUTHOR_NAME: "fixture",
      GIT_COMMITTER_DATE: date,
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "fixture",
    },
    stdio: ["ignore", "pipe", "ignore"],
  });

const commit = (date: string, file: string) => {
  writeFileSync(path.join(scratch, file), file);
  git(date, "add", file);
  git(date, "commit", "-q", "--no-gpg-sign", "-m", file);
};

git("2026-09-28T08:00:00Z", "init", "-q", "-b", "main");

commit("2026-09-28T08:00:00Z", "base.txt");

git("2026-09-29T08:00:00Z", "checkout", "-q", "-b", "feature/a");

commit("2026-09-29T08:30:00Z", "a.txt");

git(T.t4, "checkout", "-q", "-b", "feature/b");

commit("2026-09-29T10:20:00Z", "b.txt");

afterAll(() => {
  rmSync(scratch, { force: true, recursive: true });
});

const envelope = (
  id: string,
  at: string | null,
  overrides: Partial<DxEventEnvelope>
): DxEventEnvelope =>
  withCollectorBlocks({
    acquisition: "api",
    adapterId: "cursor-usage-api",
    adapterVersion: "fixture",
    context: emptyFlightContext,
    eventId: EventIdSchema.make(id),
    evidence: { bounded: true, hash: null, ref: `fixture:${id}` },
    fieldSemantics: [],
    identity: { ...emptyEventIdentity, sessionId: CONVERSATION },
    kind: "ai.usage",
    observedAt: at ?? T.t6,
    occurredAt: at,
    occurredAtPrecision: "exact",
    origin: "fixture",
    payload: {},
    schemaVersion: "dx.event.v2",
    sourceVersion: null,
    upstreamKey: id,
    ...overrides,
  });

const hook = (id: string, at: string) =>
  envelope(id, at, {
    acquisition: "hook",
    adapterId: "cursor-hooks",
    context: {
      ...emptyFlightContext,
      branch: "feature/a",
      repoCommonDir: REPO,
      worktreePath: scratch,
    },
    kind: "ai.request",
    payload: { hookEvent: "beforeSubmitPrompt" },
  });

const row = (id: string, at: string, output: number) =>
  envelope(id, at, {
    payload: {
      charge: null,
      listPriceEstimateUsd: null,
      model: "gpt-5",
      requestKey: `source:cursor-usage-api:request:${id}`,
      sourceKind: "dashboard-json",
      tokens: {
        "cache-write": null,
        "cached-input": null,
        input: 100,
        output,
        reasoning: null,
        total: null,
      },
    },
  });

const events: readonly DxEventEnvelope[] = [
  hook("hook-1", T.t1),
  row("row-1", T.t1, 1),
  hook("hook-2", T.t2),
  row("row-2", T.t2, 2),
  hook("hook-3", T.t3),
  row("row-3", T.t3, 3),
  row("row-5", T.t5, 5),
  row("row-6", T.t6, 6),
];

const layer = Layer.merge(FakeEventStoreLayer, NodeServices.layer);

const seed = Effect.gen(function* seedStore() {
  const store = yield* EventStore;

  yield* store.append({
    coverage: {
      adapterId: "fixture",
      expectedItems: events.length,
      gaps: [],
      observedItems: events.length,
      state: "complete",
      watermark: null,
      windowFrom: null,
      windowTo: null,
    },
    cursor: null,
    events,
  });

  return store;
});

const selectorFor = (branch: string | null) => ({
  branch,
  flightId: null,
  from: null,
  repoCommonDir: REPO,
  to: null,
});

const outputOf = (c: ChatNode | undefined) =>
  c?.tokens.find((t) => t.category === "output")?.value;

const idsOn = (list: readonly DxEventEnvelope[]) =>
  list.map((e) => String(e.eventId)).toSorted((a, b) => a.localeCompare(b));

describe("same chat continued on a new branch", () => {
  it("joins a conversation row to the nearest-in-time local event, not the first", () => {
    const untimed = envelope("row-untimed", null, { observedAt: T.t3 });

    const joined = joinAccountRows([
      hook("hook-1", T.t1),
      {
        ...hook("hook-late", T.t5),
        context: { ...hook("x", T.t5).context, branch: "feature/b" },
      },
      row("row-6", T.t6, 6),
      untimed,
    ]);

    expect(joined[2]?.context).toMatchObject({
      branch: "feature/b",
      repoCommonDir: REPO,
      worktreePath: scratch,
    });
    expect(joined[3]?.context.branch).toBe("feature/a");
    expect(joined[2]?.payload.sessionJoin).toMatchObject({
      attribution: "provisional",
    });
  });

  it("links a conversation event without a worktree to the nearest-in-time live event", () => {
    const onB = {
      ...hook("hook-b", T.t5),
      context: { ...hook("x", T.t5).context, branch: "feature/b" },
    };

    const bare = (id: string, at: string | null, observedAt: string) => ({
      ...row(id, at ?? T.t6, 1),
      context: { ...emptyFlightContext, repoCommonDir: REPO },
      observedAt,
      occurredAt: at,
    });

    const result = attributeHistoricalBranches(
      [
        hook("hook-a", T.t1),
        onB,
        bare("late", T.t6, T.t6),
        bare("early-untimed", null, T.t2),
      ],
      { commitBranches: new Map(), timelines: [] }
    );

    const byId = new Map(result.attributions.map((a) => [a.eventId, a]));

    expect(byId.get("late")).toMatchObject({
      attribution: "provisional",
      branch: "feature/b",
    });
    expect(byId.get("early-untimed")).toMatchObject({
      attribution: "provisional",
      branch: "feature/a",
    });
  });

  it.live(
    "analyze, history, chats and replay split the chat at the checkout",
    () =>
      Effect.gen(function* splitAtCheckout() {
        const store = yield* seed;

        const onA = yield* selectAnalyzeSnapshot(store, {
          asOf: null,
          selector: selectorFor("feature/a"),
          snapshotId: null,
        });

        const onB = yield* selectAnalyzeSnapshot(store, {
          asOf: null,
          selector: selectorFor("feature/b"),
          snapshotId: null,
        });

        expect(idsOn(onA.snapshot.events)).toEqual([
          "hook-1",
          "hook-2",
          "hook-3",
          "row-1",
          "row-2",
          "row-3",
        ]);
        expect(idsOn(onB.snapshot.events)).toEqual(["row-5", "row-6"]);

        const history = yield* makeDxHistoryCapability({
          defaultRepo: scratch,
          resolveContext: () => ({
            ...emptyFlightContext,
            branch: "feature/b",
            repoCommonDir: REPO,
            worktreePath: scratch,
          }),
          resolveStatus: () => unknownStatus("fixture"),
        }).handler({});

        const branches = history.rows
          .map((r) => r.branch ?? "")
          .toSorted((a, b) => a.localeCompare(b));

        expect(branches).toEqual(["feature/a", "feature/b"]);

        for (const r of history.rows) {
          expect(r.chats.value).toBe(1);
        }

        const chats = makeDxChatsCapability({
          resolveSelector: () => Effect.succeed(selectorFor(null)),
        });

        const chatA = (yield* chats.handler({ branch: "feature/a" })).chats;
        const chatB = (yield* chats.handler({ branch: "feature/b" })).chats;

        expect(chatA.map((c) => c.sessionId)).toEqual([CONVERSATION]);
        expect(chatB.map((c) => c.sessionId)).toEqual([CONVERSATION]);
        expect(chatA[0]?.branches).toEqual(["feature/a", "feature/b"]);
        expect(chatB[0]?.branches).toEqual(["feature/a", "feature/b"]);
        expect(chatA[0]?.eventCount).toBe(6);
        expect(chatB[0]?.eventCount).toBe(2);

        expect(outputOf(chatB[0])).toBe(11);
        expect(outputOf(chatA[0])).toBe(6);

        const pinnedId = SnapshotIdSchema.make("pinned-b");

        yield* store.putSnapshotManifest({
          ...fakeManifest("pinned-b", selectorFor("feature/b")),
          createdAt: "2026-09-30T00:00:00.000Z",
          snapshotId: pinnedId,
        });

        const replayed = yield* selectAnalyzeSnapshot(store, {
          asOf: null,
          selector: selectorFor("feature/b"),
          snapshotId: pinnedId,
        });

        expect(idsOn(replayed.snapshot.events)).toEqual(
          idsOn(onB.snapshot.events)
        );
        expect(replayed.attribution).toEqual(onB.attribution);
      }).pipe(Effect.provide(layer))
  );
});
