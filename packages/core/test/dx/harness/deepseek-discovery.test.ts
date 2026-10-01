// @effect-diagnostics nodeBuiltinImport:off -- Discovery tests lay out owned temp DSH homes, profile overlays and hook spools on disk.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { afterAll, describe, expect, it } from "@effect/vitest";
import { DateTime, Effect, Layer } from "effect";

import type {
  HarnessScope,
  SessionRef,
} from "../../../src/dx/harness/contract.js";
import {
  DeepseekHarness,
  DeepseekStore,
  deepseekHookDecoder,
  deepseekHookKind,
} from "../../../src/dx/harness/deepseek/index.js";
import { persistenceRootsIn } from "../../../src/dx/harness/deepseek/roots.js";
import { HarnessHome } from "../../../src/dx/harness/home.js";
import type { HarnessHomeOverrides } from "../../../src/dx/harness/home.js";
import { recordHook } from "../../../src/dx/harness/hook-spool.js";
import { emptyFlightContext } from "../../../src/dx/model/event.js";
import {
  FIXTURE_CWD,
  batchesOf,
  fixtureSession,
  sessionFilePath,
  zstdLog,
} from "./deepseek-fixtures.js";

const base = mkdtempSync(path.join(os.tmpdir(), "dft-deepseek-discovery-"));

afterAll(() => {
  rmSync(base, { force: true, recursive: true });
});

const writeSession = (sessionsRoot: string, name: "main" | "worktree") => {
  const session = fixtureSession(name);
  const file = sessionFilePath(sessionsRoot, session);

  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, zstdLog(batchesOf(session.lines)));
};

const harnessAt = (home: string, overrides: HarnessHomeOverrides = {}) =>
  Layer.fresh(DeepseekHarness.layer).pipe(
    Layer.provide(DeepseekStore.layer),
    Layer.provide(HarnessHome.at(home, overrides)),
    Layer.provide(NodeServices.layer)
  );

const scope = (
  dftHome: string | null,
  worktrees: readonly string[]
): HarnessScope => ({
  dftHome,
  repoCommonDir: null,
  since: null,
  worktrees,
});

describe("DeepSeek session discovery", () => {
  it.effect("follows DSH_HOME and roots set in profile overlays", () =>
    Effect.gen(function* overrides() {
      const home = path.join(base, "home");
      const dshHome = path.join(base, "custom-dsh");
      const extraRoot = path.join(base, "team-sessions");

      writeSession(path.join(dshHome, "sessions"), "main");
      writeSession(extraRoot, "worktree");
      mkdirSync(path.join(dshHome, "profiles", "work"), { recursive: true });
      writeFileSync(
        path.join(dshHome, "profiles", "work", "cordis.patch.yml"),
        `- id: session-persistence-jsonl\n  config:\n    root: ${extraRoot}\n`
      );

      const found = yield* Effect.gen(function* discoverAll() {
        const harness = yield* DeepseekHarness;
        const discovery = yield* harness.discover;
        const refs = yield* harness.locate(scope(null, []));

        return { discovery, refs };
      }).pipe(Effect.provide(harnessAt(home, { DSH_HOME: dshHome })));

      expect(found.discovery.roots).toStrictEqual([
        path.join(dshHome, "sessions"),
        extraRoot,
      ]);
      expect(found.discovery.present).toBe(true);
      expect(
        found.refs
          .map((ref) => ref.sessionId ?? "")
          .toSorted((a, b) => a.localeCompare(b))
      ).toStrictEqual(
        [fixtureSession("main").id, fixtureSession("worktree").id].toSorted(
          (a, b) => a.localeCompare(b)
        )
      );
    })
  );

  it("reads persistence roots from profile YAML", () => {
    const context = {
      dshHome: "/h/.dsh",
      home: "/h",
      join: (...parts: readonly string[]) => path.join(...parts),
    };

    expect(
      persistenceRootsIn(
        [
          "- id: session-persistence-jsonl",
          "  name: '@deepseek-ai/dsh-session-persistence-jsonl'",
          "  config:",
          "    root: !!js dshHomePath('team')",
          "- id: other",
          "  config:",
          "    root: /not/this",
          "- id: session-persistence-jsonl",
          "  config:",
          "    root: '~/logs/dsh'",
        ].join("\n"),
        context
      )
    ).toStrictEqual(["/h/.dsh/team", "/h/logs/dsh"]);
  });

  it.effect("reports an absent tool without failing", () =>
    Effect.gen(function* absent() {
      const discovery = yield* Effect.gen(function* discoverNone() {
        const harness = yield* DeepseekHarness;

        return yield* harness.discover;
      }).pipe(Effect.provide(harnessAt(path.join(base, "empty-home"))));

      expect(discovery.present).toBe(false);
      expect(discovery.sessions).toBe(0);
      expect(discovery.reason).toMatch(/no DeepSeek Harness sessions/u);
    })
  );
});

describe("DeepSeek live hook observations", () => {
  it("maps bridge and plugin event names to event kinds", () => {
    expect(
      [
        "SessionStart",
        "UserPromptSubmit",
        "PreToolUse",
        "PostToolUse",
        "Stop",
        "SubagentStart",
        "SubagentStop",
        "turn/end",
        "assistant/message",
      ].map(deepseekHookKind)
    ).toStrictEqual([
      "ai.session",
      "ai.turn",
      "other",
      "other",
      "ai.turn",
      "ai.session",
      "ai.session",
      "ai.turn",
      "ai.request",
    ]);
    expect(deepseekHookDecoder.respond("Stop")).toBe("");
  });

  it.effect("turns spooled hook calls into extension-channel events", () =>
    Effect.gen(function* spool() {
      const dftHome = path.join(base, "dft");

      recordHook({
        cwd: FIXTURE_CWD.repo,
        decoder: deepseekHookDecoder,
        dftHome,
        event: "UserPromptSubmit",
        now: DateTime.toDateUtc(
          DateTime.makeUnsafe("2026-10-01T10:00:00.000Z")
        ),
        resolveGit: () => ({
          branch: "feat/deepseek-switch",
          headSha: "abc",
          repoCommonDir: `${FIXTURE_CWD.repo}/.git`,
          worktreePath: FIXTURE_CWD.repo,
        }),
        stdinText: JSON.stringify({
          cwd: FIXTURE_CWD.repo,
          hook_event_name: "UserPromptSubmit",
          prompt: "never kept",
          session_id: "session-hooked",
          transcript_path: "",
        }),
        tool: "deepseek",
      });

      const events = yield* Effect.gen(function* readSpool() {
        const harness = yield* DeepseekHarness;
        const refs = yield* harness.locate(scope(dftHome, [FIXTURE_CWD.repo]));
        const hooks = refs.filter((ref) => ref.channel === "extension");

        const batches = yield* Effect.forEach((ref: SessionRef) =>
          harness.read(ref, {
            context: emptyFlightContext,
            cursor: null,
            origin: "fixture",
          })
        )(hooks);

        return batches.flatMap((batch) => batch.events);
      }).pipe(Effect.provide(harnessAt(path.join(base, "empty-home"))));

      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe("ai.turn");
      expect(events[0]?.ai?.channel).toBe("extension");
      expect(events[0]?.ai?.branchSource).toBe("hook");
      expect(events[0]?.context.branch).toBe("feat/deepseek-switch");
      expect(events[0]?.identity.sessionId).toBe("session-hooked");
      expect(events[0]?.ai?.harness).toBe("deepseek");
      expect(JSON.stringify(events[0]?.payload)).not.toMatch(/never kept/u);
    })
  );
});
