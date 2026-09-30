// @effect-diagnostics nodeBuiltinImport:off -- Process-spawning test: it creates a scratch git repo and hook spool directories on disk.
// @effect-diagnostics globalDate:off -- The hook handler contract takes a plain capture Date supplied by the hook process.
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  cursorHooksCollector,
  cursorHooksDescriptor,
} from "../../src/dx/collectors/cursor-hooks/collector.js";
import type { GitResolver } from "../../src/dx/collectors/cursor-hooks/handler.js";
import {
  handleCursorHook,
  resolveGitContext,
} from "../../src/dx/collectors/cursor-hooks/handler.js";
import type { CollectInput } from "../../src/dx/contracts/services.js";
import { emptyFlightContext } from "../../src/dx/model/event.js";

const fixtureDir = path.join(import.meta.dirname, "fixtures", "b05");

const scratchRoot = mkdtempSync(path.join(tmpdir(), "dxfr-b05-"));

afterAll(() => {
  rmSync(scratchRoot, { force: true, recursive: true });
});

const fixedGit: GitResolver = () => ({
  branch: "feature/fixture",
  headSha: "0000000000000000000000000000000000000001",
  repoCommonDir: "/fixture/workspace/.git",
  worktreePath: "/fixture/workspace",
});

let counter = 0;

const freshSpool = (label: string): string => {
  counter += 1;

  return path.join(scratchRoot, `${label}-${counter}`);
};

const spoolFixture = (fixture: string, spoolDir: string) => {
  const lines = readFileSync(path.join(fixtureDir, fixture), "utf-8")
    .split("\n")
    .filter((line) => line !== "");

  return lines.map((line, index) =>
    handleCursorHook(line, {
      cwd: "/fixture/workspace",
      now: new Date(Date.UTC(2026, 8, 30, 12, 0, index)),
      resolveGit: fixedGit,
      spoolDir,
    })
  );
};

const collectInput = (spoolDir: string | null): CollectInput => ({
  adapterId: "cursor-hooks",
  context: emptyFlightContext,
  cursor: null,
  origin: "fixture",
  scratchDir: null,
  selectedInput: spoolDir,
});

describe("B05 cursor hooks collector", () => {
  it.effect("decodes agent turns, tool calls and edits per branch", () =>
    Effect.gen(function* agentTurns() {
      const spoolDir = freshSpool("agent");
      const results = spoolFixture("agent-turns.jsonl", spoolDir);

      expect(
        results.every((result) => result.outcome.state === "spooled")
      ).toBe(true);

      const batch = yield* cursorHooksCollector.collect(collectInput(spoolDir));
      const kinds = batch.events.map((event) => event.kind);

      expect(kinds.filter((kind) => kind === "ai.turn")).toHaveLength(2);
      expect(kinds.filter((kind) => kind === "ai.request")).toHaveLength(2);
      expect(kinds.filter((kind) => kind === "ai.session")).toHaveLength(2);
      expect(
        batch.events.filter((event) => event.payload.toolCall === true)
      ).toHaveLength(2);
      expect(batch.events.every((event) => event.origin === "fixture")).toBe(
        true
      );
      expect(
        batch.events.every(
          (event) => event.context.branch === "feature/fixture"
        )
      ).toBe(true);

      const edit = batch.events.find((event) => event.kind === "ai.tool-edit");

      expect(edit?.payload.linesAdded).toBe(4);
      expect(edit?.payload.linesRemoved).toBe(2);

      const turn = batch.events.find(
        (event) =>
          event.kind === "ai.turn" && event.payload.status === "aborted"
      );

      expect(turn?.identity.turnId).toBe("fixture-conv-1:fixture-gen-2");
      expect(batch.events.some((event) => event.kind === "ai.usage")).toBe(
        false
      );
      expect(batch.coverage.state).toBe("complete");
      expect(batch.coverage.observedItems).toBe(11);
    })
  );

  it("never spools prompt, response, output, command text or email", () => {
    const spoolDir = freshSpool("privacy");

    spoolFixture("agent-turns.jsonl", spoolDir);

    const spooled = readdirSync(spoolDir)
      .map((name) => readFileSync(path.join(spoolDir, name), "utf-8"))
      .join("\n");

    expect(spooled).not.toContain("FIXTURE PROMPT SECRET");
    expect(spooled).not.toContain("FIXTURE RESPONSE BODY");
    expect(spooled).not.toContain("FIXTURE OUTPUT");
    expect(spooled).not.toContain("FIXTURE_SECRET");
    expect(spooled).not.toContain("fixture@example.invalid");
    expect(spooled).toContain('"commandBin":"pnpm"');
  });

  it.effect("collapses duplicate stop emissions for one turn", () =>
    Effect.gen(function* duplicateStop() {
      const spoolDir = freshSpool("dup");

      spoolFixture("duplicate-stop.jsonl", spoolDir);

      const batch = yield* cursorHooksCollector.collect(collectInput(spoolDir));

      expect(batch.coverage.observedItems).toBe(2);
      expect(batch.events).toHaveLength(1);
      expect(batch.events[0]?.kind).toBe("ai.turn");
    })
  );

  it.effect("marks Tab edits with the tab surface", () =>
    Effect.gen(function* tabEdit() {
      const spoolDir = freshSpool("tab");

      spoolFixture("tab-edit.jsonl", spoolDir);

      const batch = yield* cursorHooksCollector.collect(collectInput(spoolDir));

      expect(batch.events).toHaveLength(1);
      expect(batch.events[0]?.payload.surface).toBe("tab");
      expect(batch.events[0]?.payload.linesAdded).toBe(2);
    })
  );

  it.effect("keeps stop-hook usage raw and unverified", () =>
    Effect.gen(function* rawUsage() {
      const spoolDir = freshSpool("usage");

      spoolFixture("stop-usage-raw.jsonl", spoolDir);

      const batch = yield* cursorHooksCollector.collect(collectInput(spoolDir));
      const usage = batch.events.find((event) => event.kind === "ai.usage");

      expect(usage?.payload.semanticsVerified).toBe(false);
      expect(usage?.payload.normalizedCategories).toBeNull();
      expect(usage?.payload.rawUsage).toEqual({
        cost_usd: 0.0123,
        "usage.cache_read_tokens": 800,
        "usage.input_tokens": 1200,
        "usage.output_tokens": 340,
      });
      expect(
        usage?.fieldSemantics.every((field) =>
          (field.note ?? "").includes("unverified")
        )
      ).toBe(true);
    })
  );

  it.effect(
    "reports malformed and unknown hooks instead of empty success",
    () =>
      Effect.gen(function* malformed() {
        const spoolDir = freshSpool("bad");
        const results = spoolFixture("malformed.jsonl", spoolDir);

        expect(results.map((result) => result.outcome.state)).toEqual([
          "skipped",
          "skipped",
          "spooled",
        ]);
        expect(results[0]?.stdout).toBe("{}");

        const batch = yield* cursorHooksCollector.collect(
          collectInput(spoolDir)
        );

        expect(batch.coverage.state).toBe("partial");
        expect(batch.coverage.gaps.map((gap) => gap.code)).toContain(
          "unknown-hook-event"
        );
      })
  );

  it.effect("resumes from its cursor without re-emitting old records", () =>
    Effect.gen(function* resume() {
      const spoolDir = freshSpool("cursor");

      spoolFixture("duplicate-stop.jsonl", spoolDir);

      const first = yield* cursorHooksCollector.collect(collectInput(spoolDir));

      const second = yield* cursorHooksCollector.collect({
        ...collectInput(spoolDir),
        cursor: first.cursor,
      });

      expect(second.events).toHaveLength(0);
      expect(second.coverage.state).toBe("none");
    })
  );

  it.effect("fails visibly for missing spool or input", () =>
    Effect.gen(function* missing() {
      const noDir = yield* Effect.flip(
        cursorHooksCollector.collect(
          collectInput(path.join(scratchRoot, "absent"))
        )
      );

      const noInput = yield* Effect.flip(
        cursorHooksCollector.collect(collectInput(null))
      );

      expect(noDir._tag).toBe("SourceUnavailable");
      expect(noInput._tag).toBe("InvalidInput");
    })
  );

  it("answers permission hooks without blocking", () => {
    const spoolDir = freshSpool("perm");

    const result = handleCursorHook(
      JSON.stringify({
        command: "ls",
        conversation_id: "c",
        generation_id: "g",
        hook_event_name: "beforeShellExecution",
      }),
      {
        cwd: scratchRoot,
        now: new Date(),
        resolveGit: fixedGit,
        spoolDir,
      }
    );

    expect(JSON.parse(result.stdout)).toEqual({ permission: "allow" });
  });

  it("resolves the real git branch of the hook workspace", () => {
    const repo = path.join(scratchRoot, "repo");

    mkdirSync(repo);
    execFileSync("git", ["init", "-q", "-b", "feature/b05-demo", repo]);
    execFileSync("git", [
      "-C",
      repo,
      "-c",
      "user.email=b05@example.invalid",
      "-c",
      "user.name=b05",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    ]);

    const git = resolveGitContext(repo);

    expect(git.branch).toBe("feature/b05-demo");
    expect(git.headSha).toMatch(/^[0-9a-f]{40}$/u);
    expect(git.worktreePath).toBe(
      execFileSync("git", ["-C", repo, "rev-parse", "--show-toplevel"], {
        encoding: "utf-8",
      }).trim()
    );
  });

  it("describes itself honestly", () => {
    expect(cursorHooksDescriptor.readiness).toBe("degraded");
    expect(cursorHooksDescriptor.gaps.map((gap) => gap.code)).toContain(
      "stop-usage-unverified"
    );
  });
});
