// @effect-diagnostics nodeBuiltinImport:off -- The Codex fixture tier copies committed session fixtures and a hook spool into an owned temp home.
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { afterAll, describe, expect, it } from "@effect/vitest";
import { DateTime, Effect, Layer } from "effect";

import {
  CODEX_HOOK_KINDS,
  CodexHarness,
  CodexStore,
  codexHookDecoder,
} from "../../../src/dx/harness/codex/index.js";
import { everywhere } from "../../../src/dx/harness/contract.js";
import { HarnessHome } from "../../../src/dx/harness/home.js";
import { recordHook } from "../../../src/dx/harness/hook-spool.js";
import {
  HarnessRegistryLive,
  registryWith,
} from "../../../src/dx/harness/registry.js";
import { emptyFlightContext } from "../../../src/dx/model/event.js";
import type { DxEventEnvelope } from "../../../src/dx/model/event.js";
import { readAll, readInput, totalsOf, usageOf } from "./codex-support.js";
import { harnessConformance } from "./conformance.js";

const home = mkdtempSync(path.join(os.tmpdir(), "dft-codex-harness-"));

const dftHome = path.join(home, ".dft");

cpSync(
  path.join(import.meta.dirname, "..", "fixtures", "harness", "codex", "home"),
  home,
  { recursive: true }
);

recordHook({
  cwd: "/home/user/work/demo",
  decoder: codexHookDecoder,
  dftHome,
  event: "SubagentStart",
  now: DateTime.toDateUtc(DateTime.makeUnsafe("2026-10-01T10:58:24.000Z")),
  resolveGit: () => ({
    branch: "main",
    headSha: "be57ab2",
    repoCommonDir: "/home/user/work/demo/.git",
    worktreePath: "/home/user/work/demo",
  }),
  stdinText: JSON.stringify({
    agent_id: "01a0f71d-900e-7100-8988-195a203ff357",
    agent_transcript_path: "/home/user/.codex/sessions/sub.jsonl",
    agent_type: "worker",
    cwd: "/home/user/work/demo",
    hook_event_name: "SubagentStart",
    model: "gpt-5.6-luna",
    session_id: "01a0f71d-2ce1-7010-8395-f432e17bdb4e",
    transcript_path: "/home/user/.codex/sessions/parent.jsonl",
  }),
  tool: "codex",
});

afterAll(() => {
  rmSync(home, { force: true, recursive: true });
});

const codexAt = CodexHarness.layer.pipe(
  Layer.provide(CodexStore.layer),
  Layer.provide(HarnessHome.at(home)),
  Layer.provide(NodeServices.layer)
);

const DEMO = "/home/user/work/demo";

const DEMO_TWO = "/home/user/work/demo-two";

const demoContext = {
  ...emptyFlightContext,
  branch: "feat/codex-switch",
  repoCommonDir: `${DEMO}/.git`,
  worktreePath: DEMO,
};

harnessConformance("codex", registryWith(codexAt), {
  expectEvents: true,
  scope: { ...everywhere, dftHome },
  tier: "fixture",
});

harnessConformance("codex", registryWith(codexAt), {
  context: demoContext,
  expectEvents: true,
  scope: { ...everywhere, dftHome, worktrees: [DEMO] },
  tier: "fixture",
});

const recent = DateTime.formatIso(
  DateTime.subtract(DateTime.nowUnsafe(), { days: 3 })
);

harnessConformance(
  "codex",
  HarnessRegistryLive.pipe(Layer.provide(NodeServices.layer)),
  {
    maxSessions: 25,
    scope: { ...everywhere, since: recent },
    tier: "live",
  }
);

const MANIFEST: readonly (readonly [
  string,
  number,
  number,
  number,
  number,
  number,
])[] = [
  ["01a0f719-884c-7ba1-b80a-4ffb1432cfad", 4, 83_344, 55_296, 686, 225],
  ["01a0f71a-2858-7732-a298-0263fe414142", 19, 746_410, 700_672, 3812, 1285],
  ["01a0f71c-a7e4-7770-a034-76f806712941", 3, 72_137, 53_888, 232, 0],
  ["01a0f71d-2ce1-7010-8395-f432e17bdb4e", 12, 380_027, 326_656, 2626, 1397],
  ["01a0f71d-900e-7100-8988-195a203ff357", 7, 142_171, 112_896, 935, 232],
  ["01a0f71f-0495-73b1-b110-adb811d9ab8f", 9, 254_626, 227_072, 2057, 1084],
  ["01a0f798-461b-7401-af5c-67f1a919955a", 2, 43_941, 17_920, 10, 0],
];

const sessionOf = (events: readonly DxEventEnvelope[], id: string) =>
  events.find(
    (event) => event.kind === "ai.session" && event.ai?.sessionId === id
  );

const turnsOf = (events: readonly DxEventEnvelope[], id: string) =>
  events.filter(
    (event) => event.kind === "ai.turn" && event.ai?.sessionId === id
  );

describe("Codex harness over real session structure", () => {
  it.effect(
    "matches independently computed totals for every recorded run",
    () =>
      Effect.gen(function* manifestTotals() {
        const { events } = yield* readAll();

        for (const [
          id,
          requests,
          input,
          cached,
          output,
          reasoning,
        ] of MANIFEST) {
          expect(totalsOf(usageOf(events, id)), id).toStrictEqual({
            cached,
            input,
            output,
            reasoning,
            requests,
            total: input + output,
          });
        }
      }).pipe(Effect.provide(codexAt))
  );

  it.effect(
    "finds every session location once, archived and recovered copies included",
    () =>
      Effect.gen(function* locations() {
        const { events, refs } = yield* readAll();
        const files = refs.map((ref) => path.relative(home, ref.path));

        expect(files).toContain(
          ".codex/archived_sessions/rollout-2026-10-01T12-57-25-01a0f71c-a7e4-7770-a034-76f806712941.jsonl"
        );
        expect(
          files.filter((file) => file.includes("01a0f719-884c"))
        ).toHaveLength(1);
        expect(new Set(refs.map((ref) => ref.sessionId)).size).toBe(
          refs.length
        );
        expect(new Set(events.map((event) => event.eventId)).size).toBe(
          events.length
        );

        const harness = yield* CodexHarness;

        const copies = yield* Effect.forEach(
          [
            ".codex/sessions/2026/10/01/rollout-2026-10-01T12-54-00-01a0f719-884c-7ba1-b80a-4ffb1432cfad.jsonl",
            ".codex/sessions/recovered/2026/10/01/rollout-recovered-2026-10-01T12-54-00-01a0f719-884c-7ba1-b80a-4ffb1432cfad.jsonl",
          ],
          (file) =>
            harness.read(
              {
                channel: "session-file",
                harness: "codex",
                id: file,
                mtimeMs: null,
                path: path.join(home, file),
                sessionId: null,
                size: null,
                source: "harness.codex",
                worktree: null,
              },
              readInput()
            )
        );

        expect(copies[0]?.events.map((event) => event.eventId)).toStrictEqual(
          copies[1]?.events.map((event) => event.eventId)
        );

        const discovery = yield* harness.discover;

        expect(discovery.present).toBe(true);
        expect(discovery.version).toMatch(/^0\.\d+\.\d+$/u);
        expect(
          discovery.roots.map((root) => path.relative(home, root))
        ).toStrictEqual([".codex/sessions", ".codex/archived_sessions"]);
      }).pipe(Effect.provide(codexAt))
  );

  it.effect(
    "keeps a subagent's own tokens under its own session and names its parent",
    () =>
      Effect.gen(function* subagent() {
        const { events } = yield* readAll();
        const sub = usageOf(events, "01a0f71d-900e-7100-8988-195a203ff357");

        expect(sub[0]?.ai).toMatchObject({
          agentId: "01a0f71d-900e-7100-8988-195a203ff357",
          agentType: "worker",
          branchSource: "session-recorded",
          parentSessionId: "01a0f71d-2ce1-7010-8395-f432e17bdb4e",
        });
        expect(
          sessionOf(events, "01a0f71d-900e-7100-8988-195a203ff357")?.payload
        ).toMatchObject({
          agentNickname: "Lovelace",
          isSubagent: true,
          rootSessionId: "01a0f71d-2ce1-7010-8395-f432e17bdb4e",
          subagentKind: "thread_spawn",
        });
        expect(
          sessionOf(events, "01a0f71d-2ce1-7010-8395-f432e17bdb4e")?.payload
        ).toMatchObject({
          isSubagent: false,
          title: "Fixture title four",
        });
      }).pipe(Effect.provide(codexAt))
  );

  it.effect(
    "labels the start branch of a resumed session as session-recorded",
    () =>
      Effect.gen(function* resumed() {
        const { events } = yield* readAll(readInput(demoContext));
        const id = "01a0f71a-2858-7732-a298-0263fe414142";

        expect(
          turnsOf(events, id).map((event) => event.payload.status)
        ).toStrictEqual(["completed", "completed", "completed"]);
        expect(
          new Set(
            usageOf(events, id).map(
              (event) => `${event.context.branch} ${event.ai?.branchSource}`
            )
          )
        ).toStrictEqual(new Set(["feat/codex-one session-recorded"]));
        expect(usageOf(events, id)[0]?.context).toMatchObject({
          repoCommonDir: `${DEMO}/.git`,
          worktreePath: DEMO,
        });
        expect(sessionOf(events, id)?.payload.title).toBe("Fixture title two");
      }).pipe(Effect.provide(codexAt))
  );

  it.effect(
    "locates sessions by worktree, including the second worktree and the -C orchestrator",
    () =>
      Effect.gen(function* worktrees() {
        const harness = yield* CodexHarness;

        const two = yield* harness.locate({
          ...everywhere,
          worktrees: [DEMO_TWO],
        });

        const demo = yield* harness.locate({
          ...everywhere,
          worktrees: [DEMO],
        });

        expect(two.map((ref) => [ref.sessionId, ref.worktree])).toStrictEqual([
          ["01a0f71c-a7e4-7770-a034-76f806712941", DEMO_TWO],
        ]);
        expect(demo.map((ref) => ref.sessionId)).toContain(
          "01a0f71f-0495-73b1-b110-adb811d9ab8f"
        );
        expect(demo.every((ref) => ref.worktree === DEMO)).toBe(true);

        const [archived] = two;

        expect(archived).toBeDefined();

        if (archived === undefined) {
          return;
        }

        const batch = yield* harness.read(archived, readInput());

        expect(
          batch.events.find((event) => event.kind === "ai.usage")?.context
        ).toMatchObject({
          branch: "feat/codex-two",
          worktreePath: DEMO_TWO,
        });
      }).pipe(Effect.provide(codexAt))
  );

  it.effect("reports a failed request as a failed turn without usage", () =>
    Effect.gen(function* failed() {
      const { events } = yield* readAll();
      const id = "01a0f778-616d-7b51-858b-db1c30ea9d6c";

      expect(usageOf(events, id)).toStrictEqual([]);
      expect(turnsOf(events, id).map((event) => event.payload)).toMatchObject([
        { errorKind: "other", requests: 0, status: "failed" },
      ]);
    }).pipe(Effect.provide(codexAt))
  );

  it.effect("follows a model and effort change between turns", () =>
    Effect.gen(function* modelChange() {
      const { events } = yield* readAll();
      const id = "01a0f798-461b-7401-af5c-67f1a919955a";

      expect(
        usageOf(events, id).map((event) => [
          event.ai?.model,
          event.ai?.effort,
          event.usage?.serviceTier,
        ])
      ).toStrictEqual([
        ["gpt-5.6-luna", "high", null],
        ["gpt-6.1-sol", "low", "default"],
      ]);
      expect(
        turnsOf(events, id).map((event) => event.payload.model)
      ).toStrictEqual(["gpt-5.6-luna", "gpt-6.1-sol"]);
    }).pipe(Effect.provide(codexAt))
  );

  it.effect(
    "reads pre-record sessions from token_count without replayed parent history",
    () =>
      Effect.gen(function* legacy() {
        const { events } = yield* readAll();
        const fork = usageOf(events, "019f4932-7932-7271-834e-61854159b23b");
        const cliFork = usageOf(events, "019f275a-0736-7842-b743-58c6de4b3cd6");

        expect(fork.map((event) => event.usage?.tokens.total)).toStrictEqual([
          20_796, 21_171, 21_277,
        ]);
        expect(
          fork.every((event) => event.payload.usageSource === "token_count")
        ).toBe(true);
        expect(cliFork.length).toBe(10);
        expect(
          cliFork.every(
            (event) =>
              event.occurredAt !== null &&
              event.occurredAt >= "2026-07-03T09:42"
          )
        ).toBe(true);
        expect(cliFork[0]?.ai?.via).toBe("headroom");
      }).pipe(Effect.provide(codexAt))
  );

  it.effect(
    "counts guardian reviews, compaction gaps and mixed-format sessions",
    () =>
      Effect.gen(function* oddities() {
        const { events } = yield* readAll();

        const guardian = usageOf(
          events,
          "01a06b39-2c53-7571-b81c-259468e296c4"
        );

        const compacted = usageOf(
          events,
          "019f493d-b513-7633-90ba-83e03ac27fd5"
        );

        const mixed = usageOf(events, "01a03d5f-a4fb-73a0-9dbe-7330736f47ec");

        expect(guardian.length).toBe(4);
        expect(guardian[0]?.ai?.agentType).toBe("guardian");
        expect(compacted.length).toBeGreaterThan(0);
        expect(
          compacted.every((event) => event.ai?.model === "gpt-5.6-sol")
        ).toBe(true);

        const firstRecord = mixed.findIndex(
          (event) => event.payload.usageSource === "token_usage_record"
        );

        expect(firstRecord).toBeGreaterThan(0);
        expect(
          mixed
            .slice(firstRecord)
            .every(
              (event) => event.payload.usageSource === "token_usage_record"
            )
        ).toBe(true);
      }).pipe(Effect.provide(codexAt))
  );

  it.effect("turns hook observations into events on the hooks channel", () =>
    Effect.gen(function* hooks() {
      const harness = yield* CodexHarness;
      const refs = yield* harness.locate({ ...everywhere, dftHome });
      const hookRef = refs.find((ref) => ref.channel === "hooks");

      expect(hookRef).toBeDefined();

      if (hookRef === undefined) {
        return;
      }

      const batch = yield* harness.read(hookRef, readInput());

      expect(
        batch.events.map((event) => [
          event.kind,
          event.ai?.sessionId,
          event.ai?.parentSessionId,
        ])
      ).toStrictEqual([
        [
          "ai.session",
          "01a0f71d-900e-7100-8988-195a203ff357",
          "01a0f71d-2ce1-7010-8395-f432e17bdb4e",
        ],
      ]);
      expect(CODEX_HOOK_KINDS.get("Stop")).toBe("ai.turn");
      expect(codexHookDecoder.kind("PostToolUse")).toBe("other");
    }).pipe(Effect.provide(codexAt))
  );
});

describe("Codex store", () => {
  it.effect("follows CODEX_HOME", () =>
    Effect.gen(function* override() {
      const store = yield* CodexStore;
      const roots = yield* store.roots;

      expect(roots).toStrictEqual([
        "/elsewhere/codex/sessions",
        "/elsewhere/codex/archived_sessions",
      ]);
      expect(yield* store.listSessions).toStrictEqual([]);
    }).pipe(
      Effect.provide(
        CodexStore.layer.pipe(
          Layer.provide(
            HarnessHome.at("/home/user", { CODEX_HOME: "/elsewhere/codex" })
          ),
          Layer.provide(NodeServices.layer)
        )
      )
    )
  );
});
