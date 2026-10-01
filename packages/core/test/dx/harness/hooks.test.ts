// @effect-diagnostics nodeBuiltinImport:off -- Hook observations are appended to an owned temp DFT_HOME with synchronous node:fs, like the real hook process.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "@effect/vitest";
import { DateTime } from "effect";

import { HOOK_DECODERS } from "../../../src/dx/harness/hook-decoders.js";
import {
  hookEventNameOf,
  hookToolOf,
  standardHookFields,
} from "../../../src/dx/harness/hook-observation.js";
import {
  hookSpoolFile,
  readHookObservations,
  recordHook,
} from "../../../src/dx/harness/hook-spool.js";
import { HARNESS_IDS } from "../../../src/dx/harness/ids.js";

const dftHome = mkdtempSync(path.join(os.tmpdir(), "dft-hooks-"));

afterAll(() => {
  rmSync(dftHome, { force: true, recursive: true });
});

const git = {
  branch: "feature/a",
  headSha: "abc",
  repoCommonDir: "/r/.git",
  worktreePath: "/r",
};

describe("hook observations", () => {
  it("reads the common session fields and nothing else", () => {
    expect(
      standardHookFields(
        JSON.stringify({
          agent_id: "a1",
          cwd: "/r/src",
          prompt: "never kept",
          session_id: "s1",
          transcript_path: "/t/s1.jsonl",
          turn_id: "t1",
        })
      )
    ).toStrictEqual({
      agentId: "a1",
      cwd: "/r/src",
      model: null,
      parentSessionId: null,
      sessionId: "s1",
      transcriptPath: "/t/s1.jsonl",
      turnId: "t1",
    });
    expect(standardHookFields("[1,2]")).toBeNull();
    expect(hookEventNameOf('{"hook_event_name":"Stop"}')).toBe("Stop");
    expect(hookToolOf("codex")).toBe("codex");
    expect(hookToolOf("vim")).toBeNull();
  });

  it("has a decoder for every tool", () => {
    expect(Object.keys(HOOK_DECODERS).toSorted()).toStrictEqual(
      [...HARNESS_IDS].toSorted()
    );
    expect(HOOK_DECODERS.cursor.respond("beforeSubmitPrompt")).toBe(
      '{"continue":true}'
    );
    expect(HOOK_DECODERS.pi.respond("message_end")).toBe("");
  });

  it("appends one observation per call and reads them back", () => {
    const now = DateTime.toDateUtc(
      DateTime.makeUnsafe("2026-10-01T10:00:00.000Z")
    );

    const seen: string[] = [];

    const first = recordHook({
      cwd: "/r",
      decoder: HOOK_DECODERS["claude-code"],
      dftHome,
      event: "Stop",
      now,
      resolveGit: (cwd) => {
        seen.push(cwd);

        return git;
      },
      stdinText: JSON.stringify({ cwd: "/r/sub", session_id: "s1" }),
      tool: "claude-code",
    });

    const second = recordHook({
      cwd: "/r",
      decoder: HOOK_DECODERS["claude-code"],
      dftHome,
      event: "SessionEnd",
      now,
      resolveGit: () => git,
      stdinText: "not json",
      tool: "claude-code",
    });

    expect(first.outcome.state).toBe("recorded");
    expect(second.stdout).toBe("");
    expect(seen).toStrictEqual(["/r/sub"]);

    const file = hookSpoolFile(dftHome, "claude-code", now.toISOString());

    expect(readFileSync(file, "utf-8").trim().split("\n").length).toBe(2);

    const observations = readHookObservations(dftHome, "claude-code");

    expect(observations.map((o) => [o.event, o.payloadValid])).toStrictEqual([
      ["Stop", true],
      ["SessionEnd", false],
    ]);
    expect(observations[0]?.git.branch).toBe("feature/a");
    expect(observations[0]?.fields.sessionId).toBe("s1");
    expect(readHookObservations(dftHome, "codex")).toStrictEqual([]);
  });
});
