// @effect-diagnostics nodeBuiltinImport:off -- Hook observations are appended to an owned temp DFT_HOME with synchronous node:fs, like the real hook process.
import { mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { afterAll, describe, expect, it } from "@effect/vitest";
import { DateTime, Effect, Layer, Ref } from "effect";

import { EventStore } from "../../../src/dx/contracts/event-store.js";
import type { Harness, SessionRef } from "../../../src/dx/harness/contract.js";
import { everywhere } from "../../../src/dx/harness/contract.js";
import { HOOK_DECODERS } from "../../../src/dx/harness/hook-decoders.js";
import {
  hookSpoolRefs,
  readHookSpool,
  recordHook,
} from "../../../src/dx/harness/hook-spool.js";
import { HarnessRegistry } from "../../../src/dx/harness/registry.js";
import { emptyFlightContext } from "../../../src/dx/model/event.js";
import { runPlannedStep } from "../../../src/dx/registry/sync.js";
import { HarnessCursors } from "../../../src/dx/storage/harness-cursors.js";
import { FakeEventStoreLayer } from "../fakes.js";

const dftHome = mkdtempSync(path.join(os.tmpdir(), "dft-hook-cursors-"));

afterAll(() => {
  rmSync(dftHome, { force: true, recursive: true });
});

const git = {
  branch: "feature/a",
  headSha: "abc",
  repoCommonDir: "/r/.git",
  worktreePath: "/r",
};

const observe = (at: string, prompt: number) =>
  recordHook({
    cwd: "/r",
    decoder: HOOK_DECODERS["claude-code"],
    dftHome,
    event: "UserPromptSubmit",
    now: DateTime.toDateUtc(DateTime.makeUnsafe(at)),
    resolveGit: () => git,
    stdinText: JSON.stringify({ session_id: `s${prompt}` }),
    tool: "claude-code",
  });

const scope = { ...everywhere, dftHome, worktrees: ["/r"] };

const spoolHarness = (reads: Ref.Ref<readonly string[]>): Harness => ({
  capabilities: {
    branchSources: ["hook"],
    liveHooks: true,
    storedFigure: null,
    subagents: false,
  },
  channels: ["hooks"],
  discover: Effect.succeed({
    harness: "claude-code",
    present: true,
    reason: null,
    roots: [],
    sessions: 0,
    version: null,
  }),
  displayName: "Claude Code",
  id: "claude-code",
  locate: () => Effect.succeed(hookSpoolRefs(scope, "claude-code")),
  read: (session: SessionRef) =>
    Ref.update(reads, (seen) => [...seen, path.basename(session.path)]).pipe(
      Effect.as(
        readHookSpool(session, HOOK_DECODERS["claude-code"], "imported")
      )
    ),
});

describe("hook spool sync cursors", () => {
  it("stamps each spool day with the file's mtime and size", () => {
    const outcome = observe("2026-09-29T10:00:00.000Z", 0);
    const file = outcome.outcome.state === "recorded" && outcome.outcome.path;
    const refs = hookSpoolRefs(scope, "claude-code");
    const day = refs.find((ref) => ref.path === file);
    const stats = file === false ? null : statSync(file);

    expect(day?.mtimeMs).toBe(stats?.mtimeMs);
    expect(day?.size).toBe(stats?.size);
  });

  it.effect("reads a past spool day once and a growing day again", () =>
    Effect.gen(function* skip() {
      for (const prompt of [1, 2, 3]) {
        observe(`2026-09-30T1${prompt}:00:00.000Z`, prompt);
      }

      const reads = yield* Ref.make<readonly string[]>([]);
      const store = yield* EventStore;
      const env = { store, storePath: path.join(dftHome, "dft.db") };
      const registry = HarnessRegistry.fromHarnesses([spoolHarness(reads)]);

      const syncAll = Effect.suspend(() =>
        Effect.forEach(hookSpoolRefs(scope, "claude-code"), (ref) =>
          runPlannedStep(env, [], {
            context: emptyFlightContext,
            harness: "claude-code",
            input: ref.path,
            ref,
            source: ref.source,
            unavailable: null,
          })
        )
      ).pipe(Effect.provide(registry));

      const first = yield* syncAll;
      const second = yield* syncAll;

      observe("2026-09-30T18:00:00.000Z", 4);
      yield* syncAll;

      expect(first.map((step) => step.inserted)).toStrictEqual([1, 3]);
      expect(second.map((step) => [step.inserted, step.duplicates])).toEqual([
        [0, 0],
        [0, 0],
      ]);
      expect(yield* Ref.get(reads)).toStrictEqual([
        "2026-09-29.jsonl",
        "2026-09-30.jsonl",
        "2026-09-30.jsonl",
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          FakeEventStoreLayer,
          HarnessCursors.memory,
          NodeServices.layer
        )
      )
    )
  );
});
