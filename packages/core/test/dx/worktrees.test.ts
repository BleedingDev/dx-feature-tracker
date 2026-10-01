// @effect-diagnostics nodeBuiltinImport:off -- The worktree test scripts a throwaway git repository with linked worktrees, a DFT_HOME and a SQLite store in a scratch directory.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { afterAll, describe, expect, it } from "@effect/vitest";
import { DateTime, Effect } from "effect";

import { makeDxChatsCapability } from "../../src/dx/chats/capability.js";
import type { ChatNode } from "../../src/dx/chats/contract.js";
import { handleCursorHook } from "../../src/dx/collectors/cursor-hooks/handler.js";
import type { RawHookPayload } from "../../src/dx/collectors/cursor-hooks/raw-payload.js";
import { EventStore } from "../../src/dx/contracts/event-store.js";
import { placeEventsInWorktrees } from "../../src/dx/correlation/branch-at-time/worktree.js";
import { buildRepoMap } from "../../src/dx/correlation/repo/worktree-map.js";
import { withCollectorBlocks } from "../../src/dx/harness/collector-blocks.js";
import { makeDxHistoryCapability } from "../../src/dx/history/capability.js";
import { unknownStatus } from "../../src/dx/history/compute.js";
import type { FlightHistoryRow } from "../../src/dx/history/contract.js";
import type { DxEventEnvelope } from "../../src/dx/model/event.js";
import {
  emptyEventIdentity,
  emptyFlightContext,
} from "../../src/dx/model/event.js";
import { EventIdSchema } from "../../src/dx/model/ids.js";
import { allCollectors } from "../../src/dx/registry/registry.js";
import {
  hookSpoolDirFor,
  resolveCanonicalGit,
  runCursorHook,
} from "../../src/dx/registry/runtime.js";
import { autoSync } from "../../src/dx/registry/sync.js";
import { selectAnalyzeSnapshot } from "../../src/dx/reports/analyze/select.js";
import { openSqliteEventStore } from "../../src/dx/storage/sqlite-event-store.js";

const scratch = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "dft-worktrees-"))
);

afterAll(() => {
  fs.rmSync(scratch, { force: true, recursive: true });
});

const MAIN = path.join(scratch, "app");

const COMMON = path.join(MAIN, ".git");

const dftHome = path.join(scratch, "dft-home");

const PARENT = "conv-parent";

const LANES = [1, 2, 3].map((n) => ({
  branch: `feature/w${n}`,
  child: `sub-${n}`,
  output: n * 100,
  toolCall: `task-${n}`,
  worktree: path.join(scratch, `app-w${n}`),
}));

const git = (cwd: string, date: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "core.hooksPath=/dev/null", ...args], {
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

const commit = (cwd: string, date: string, file: string) => {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), file);
  git(cwd, date, "add", file);
  git(cwd, date, "commit", "-q", "--no-gpg-sign", "-m", file);
};

fs.mkdirSync(MAIN);

git(MAIN, "2026-09-28T08:00:00Z", "init", "-q", "-b", "main");

commit(MAIN, "2026-09-28T08:00:00Z", "src/base.ts");

for (const lane of LANES) {
  git(
    MAIN,
    "2026-09-29T08:00:00Z",
    "worktree",
    "add",
    "-q",
    "-b",
    lane.branch,
    lane.worktree
  );
  commit(lane.worktree, "2026-09-29T08:10:00Z", `src/${lane.child}.ts`);
}

const byPath = (a: string | null, b: string | null) =>
  (a ?? "").localeCompare(b ?? "");

const at = (minute: number) =>
  DateTime.toDateUtc(DateTime.makeUnsafe(Date.UTC(2026, 8, 29, 9, minute, 0)));

const hook = (payload: RawHookPayload, minute: number) =>
  runCursorHook(
    JSON.stringify({ workspace_roots: [MAIN], ...payload }),
    MAIN,
    at(minute),
    dftHome
  );

hook(
  {
    conversation_id: PARENT,
    generation_id: "g-parent",
    hook_event_name: "beforeSubmitPrompt",
    model: "claude-4.6-opus-high",
    prompt: "fixture prompt",
  },
  0
);

for (const [index, lane] of LANES.entries()) {
  const file = path.join(lane.worktree, "src", `${lane.child}.ts`);

  hook(
    {
      conversation_id: PARENT,
      generation_id: "g-parent",
      hook_event_name: "subagentStart",
      parent_conversation_id: PARENT,
      subagent_id: lane.child,
      subagent_model: "gpt-5.5-high",
      subagent_type: "generalPurpose",
      tool_call_id: lane.toolCall,
    },
    1 + index
  );

  hook(
    {
      conversation_id: lane.child,
      edits: [{ new_string: "a\nb", old_string: "a" }],
      file_path: file,
      generation_id: `g-${lane.child}`,
      hook_event_name: "afterFileEdit",
      tool_use_id: `edit-${lane.child}`,
    },
    10 + index
  );

  hook(
    {
      conversation_id: PARENT,
      cwd: lane.worktree,
      generation_id: "g-parent",
      hook_event_name: "postToolUse",
      parent_tool_call_id: lane.toolCall,
      tool_name: "Shell",
      tool_use_id: `shell-${lane.child}`,
    },
    20 + index
  );

  hook(
    {
      child_conversation_id: lane.child,
      conversation_id: PARENT,
      generation_id: "g-parent",
      hook_event_name: "subagentStop",
      modified_files: [file],
      parent_conversation_id: PARENT,
      status: "completed",
      subagent_id: lane.child,
      tool_call_id: lane.toolCall,
    },
    30 + index
  );
}

handleCursorHook(
  JSON.stringify({
    conversation_id: "sub-2",
    file_path: path.join(LANES[1]?.worktree ?? "", "src", "legacy.ts"),
    generation_id: "g-legacy",
    hook_event_name: "afterFileEdit",
    tool_use_id: "edit-legacy",
    workspace_roots: [MAIN],
  }),
  {
    cwd: MAIN,
    now: at(35),
    resolveGit: resolveCanonicalGit,
    spoolDirFor: (worktree) => hookSpoolDirFor(worktree, dftHome),
  }
);

const GONE = path.join(scratch, "app-removed");

handleCursorHook(
  JSON.stringify({
    conversation_id: PARENT,
    hook_event_name: "sessionEnd",
    workspace_roots: [MAIN],
  }),
  {
    cwd: MAIN,
    now: at(45),
    resolveGit: resolveCanonicalGit,
    spoolDirFor: () => hookSpoolDirFor(GONE, dftHome),
  }
);

hook(
  {
    conversation_id: PARENT,
    generation_id: "g-parent",
    hook_event_name: "stop",
    status: "completed",
  },
  40
);

const usageRow = (
  session: string,
  minute: number,
  output: number
): DxEventEnvelope =>
  withCollectorBlocks({
    acquisition: "api",
    adapterId: "cursor-usage-api",
    adapterVersion: "fixture",
    context: emptyFlightContext,
    eventId: EventIdSchema.make(`usage-${session}`),
    evidence: { bounded: true, hash: null, ref: `fixture:usage-${session}` },
    fieldSemantics: [],
    identity: { ...emptyEventIdentity, sessionId: session },
    kind: "ai.usage",
    observedAt: at(minute).toISOString(),
    occurredAt: at(minute).toISOString(),
    occurredAtPrecision: "exact",
    origin: "fixture",
    payload: {
      charge: null,
      listPriceEstimateUsd: null,
      model: "gpt-5",
      requestKey: `source:cursor-usage-api:request:${session}`,
      sourceKind: "dashboard-json",
      tokens: {
        "cache-write": null,
        "cached-input": null,
        input: 10,
        output,
        reasoning: null,
        total: null,
      },
    },
    schemaVersion: "dx.event.v2",
    sourceVersion: null,
    upstreamKey: `usage-${session}`,
  });

const usageRows = [
  usageRow(PARENT, 41, 7),
  ...LANES.map((lane, index) => usageRow(lane.child, 33 + index, lane.output)),
];

const outputOf = (tokens: FlightHistoryRow["tokens"]) =>
  tokens.find((t) => t.category === "output")?.measure.value ?? null;

const chatOutput = (chat: ChatNode | undefined) =>
  chat?.tokens.find((t) => t.category === "output")?.value ?? null;

describe("parallel subagents in linked worktrees", () => {
  it("spools each subagent event in the worktree it touched", () => {
    for (const lane of LANES) {
      expect(
        fs.readdirSync(hookSpoolDirFor(lane.worktree, dftHome))
      ).toHaveLength(3);
    }

    expect(fs.readdirSync(hookSpoolDirFor(MAIN, dftHome))).toHaveLength(6);
  });

  it("moves an event with a file path in another worktree, and a pathless event of the same chat", () => {
    const [lane] = LANES;

    const map = buildRepoMap(COMMON, [
      {
        bare: false,
        branch: "main",
        detached: false,
        headSha: null,
        path: MAIN,
        prunable: false,
      },
      {
        bare: false,
        branch: lane?.branch ?? "",
        detached: false,
        headSha: null,
        path: lane?.worktree ?? "",
        prunable: false,
      },
    ]);

    const context = {
      ...emptyFlightContext,
      branch: "main",
      repoCommonDir: COMMON,
      worktreePath: MAIN,
    };

    const event = (id: string, payload: DxEventEnvelope["payload"]) => ({
      ...usageRow("sub-1", 10, 1),
      acquisition: "hook" as const,
      adapterId: "cursor-hooks",
      context,
      eventId: EventIdSchema.make(id),
      kind: "ai.tool-edit" as const,
      payload,
    });

    const placed = placeEventsInWorktrees(map === null ? [] : [map], [
      event("edit", {
        filePath: path.join(lane?.worktree ?? "", "src", "x.ts"),
      }),
      event("prompt", {}),
    ]);

    expect(placed.events.map((e) => e.context.worktreePath)).toEqual([
      lane?.worktree,
      lane?.worktree,
    ]);
    expect(placed.placements.map((p) => p.method)).toEqual([
      "file-path",
      "same-chat",
    ]);
  });

  it.live(
    "sync reads every worktree's spool, including a removed worktree's; history and chats split tokens per subagent branch",
    () =>
      Effect.gen(function* perWorktree() {
        const storePath = path.join(scratch, "store", "dft.db");
        fs.mkdirSync(path.dirname(storePath), { recursive: true });

        const opened = yield* openSqliteEventStore({
          kind: "live",
          path: storePath,
        });

        const store = opened.service;

        const report = yield* autoSync(store, allCollectors, {
          cwd: MAIN,
          dftHome,
          home: scratch,
          repo: MAIN,
          storePath,
        });

        const syncedSpools = report.steps
          .filter((s) => s.source === "collector.cursor-hooks")
          .map((s) => s.input);

        expect(syncedSpools.toSorted(byPath)).toEqual(
          [MAIN, GONE, ...LANES.map((l) => l.worktree)]
            .map((w) => hookSpoolDirFor(w, dftHome))
            .toSorted(byPath)
        );

        yield* store.append({
          coverage: {
            adapterId: "fixture",
            expectedItems: usageRows.length,
            gaps: [],
            observedItems: usageRows.length,
            state: "complete",
            watermark: null,
            windowFrom: null,
            windowTo: null,
          },
          cursor: null,
          events: usageRows,
        });

        const history = yield* makeDxHistoryCapability({
          defaultRepo: MAIN,
          resolveStatus: () => unknownStatus("fixture"),
        })
          .handler({})
          .pipe(Effect.provideService(EventStore, store));

        const byBranch = new Map(history.rows.map((r) => [r.branch, r]));

        expect([...byBranch.keys()].toSorted(byPath)).toEqual([
          "feature/w1",
          "feature/w2",
          "feature/w3",
          "main",
        ]);

        for (const lane of LANES) {
          const row = byBranch.get(lane.branch);

          expect(outputOf(row?.tokens ?? [])).toBe(lane.output);
          expect(row?.worktree).toBe(lane.worktree);
          expect(row?.chats.value).toBe(1);
        }

        expect(outputOf(byBranch.get("main")?.tokens ?? [])).toBe(7);
        expect(byBranch.get("main")?.worktree).toBe(MAIN);

        const chats = yield* makeDxChatsCapability({
          resolveSelector: () =>
            Effect.succeed({
              branch: null,
              flightId: null,
              from: null,
              repoCommonDir: COMMON,
              to: null,
            }),
        })
          .handler({})
          .pipe(Effect.provideService(EventStore, store));

        const chat = new Map(chats.chats.map((c) => [c.sessionId, c]));
        const parent = chat.get(PARENT);

        expect(parent?.childSessionIds).toEqual(LANES.map((l) => l.child));
        expect(parent?.branches).toEqual(["main"]);
        expect(chatOutput(parent)).toBe(7);
        expect(chats.rootSessionIds).toEqual([PARENT]);

        for (const lane of LANES) {
          const child = chat.get(lane.child);

          expect(child?.parentSessionId).toBe(PARENT);
          expect(child?.isSubagent).toBe(true);
          expect(child?.branches).toEqual([lane.branch]);
          expect(chatOutput(child)).toBe(lane.output);
          expect(child?.models).toContain("gpt-5.5-high");
        }

        const onMain = yield* selectAnalyzeSnapshot(store, {
          asOf: null,
          selector: {
            branch: "main",
            flightId: null,
            from: null,
            repoCommonDir: COMMON,
            to: null,
          },
          snapshotId: null,
        });

        const parentRow = onMain.snapshot.events.find(
          (e) => e.eventId === `usage-${PARENT}`
        );

        expect(parentRow?.payload.sessionJoin).toMatchObject({
          unsplitParent: true,
        });

        const onW2 = yield* selectAnalyzeSnapshot(store, {
          asOf: null,
          selector: {
            branch: "feature/w2",
            flightId: null,
            from: null,
            repoCommonDir: COMMON,
            to: null,
          },
          snapshotId: null,
        });

        const legacy = onW2.snapshot.events.find(
          (e) => e.identity.generationId === "g-legacy"
        );

        expect(legacy?.context.worktreePath).toBe(LANES[1]?.worktree);
        expect(legacy?.payload.worktreePlacement).toMatchObject({
          fromWorktree: MAIN,
          method: "file-path",
        });

        opened.close();
      }).pipe(Effect.provide(NodeServices.layer))
  );
});
