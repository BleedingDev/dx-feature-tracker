// @effect-diagnostics nodeBuiltinImport:off -- The Cursor mock tier loads committed transcript fixtures into an in-memory store.
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import {
  CursorHarness,
  CursorStore,
} from "../../../src/dx/harness/cursor/index.js";
import type { MemoryFile } from "../../../src/dx/harness/file-store.js";
import {
  HarnessRegistry,
  registryWith,
} from "../../../src/dx/harness/registry.js";
import { emptyFlightContext } from "../../../src/dx/model/event.js";
import { harnessConformance } from "./conformance.js";

const fixtureRoot = path.join(
  import.meta.dirname,
  "..",
  "fixtures",
  "b07",
  "projects"
);

const projectsRoot = "/cursor-memory-home/.cursor/projects";

const worktree = "/demo";

const TRANSCRIPTS = [
  "demo/agent-transcripts/comp-T.txt",
  "demo/agent-transcripts/comp-A/comp-A.jsonl",
  "demo/agent-transcripts/comp-A/subagents/agent-7.jsonl",
] as const;

const files: readonly MemoryFile[] = TRANSCRIPTS.map((relative) => ({
  mtimeMs: 1_790_000_000_000,
  path: path.join(projectsRoot, relative),
  text: readFileSync(path.join(fixtureRoot, relative), "utf-8"),
}));

const cursorInMemory = Layer.fresh(CursorHarness.layer).pipe(
  Layer.provide(CursorStore.memory({ files, roots: [projectsRoot] }))
);

const scope = {
  dftHome: "/cursor-memory-home/.dft",
  repoCommonDir: null,
  since: null,
  worktrees: [worktree],
};

harnessConformance("cursor", registryWith(cursorInMemory), {
  context: { ...emptyFlightContext, branch: "main", worktreePath: worktree },
  expectEvents: true,
  scope,
  tier: "mock",
});

describe("Cursor harness over a memory store", () => {
  it.effect("locates and reads transcripts only through CursorStore", () =>
    Effect.gen(function* locateInMemory() {
      const registry = yield* HarnessRegistry;
      const located = yield* registry.locate(scope);

      expect(located.failures).toStrictEqual([]);
      expect(
        located.refs.map((ref) => [ref.path, ref.channel, ref.worktree])
      ).toStrictEqual(
        files
          .map((file) => file.path)
          .toSorted()
          .map((file) => [file, "transcript", worktree])
      );

      const discovered = yield* registry.discover;

      expect(
        discovered.find((entry) => entry.harness === "cursor")
      ).toMatchObject({ present: true, roots: [projectsRoot], sessions: 3 });
    }).pipe(Effect.provide(registryWith(cursorInMemory)))
  );

  it.effect("the empty mock runs the real Cursor harness", () =>
    Effect.gen(function* emptyMock() {
      const registry = yield* HarnessRegistry;
      const cursor = registry.get("cursor");

      expect(cursor?.capabilities.branchSources).toContain("harness-recorded");
      expect(yield* registry.locate(scope)).toStrictEqual({
        failures: [],
        refs: [],
      });
    }).pipe(Effect.provide(registryWith(CursorHarness.mock)))
  );
});
