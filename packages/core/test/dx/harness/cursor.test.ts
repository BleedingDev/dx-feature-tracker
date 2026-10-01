// @effect-diagnostics nodeBuiltinImport:off -- The Cursor fixture tier copies committed transcript fixtures into an owned temp home.
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { afterAll, describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import {
  CursorHarness,
  CursorStore,
} from "../../../src/dx/harness/cursor/index.js";
import { HarnessHome } from "../../../src/dx/harness/home.js";
import {
  HarnessRegistry,
  registryWith,
} from "../../../src/dx/harness/registry.js";
import { emptyFlightContext } from "../../../src/dx/model/event.js";
import { harnessConformance } from "./conformance.js";

const home = mkdtempSync(path.join(os.tmpdir(), "dft-cursor-harness-"));

const dftHome = path.join(home, ".dft");

const worktree = "/demo";

mkdirSync(path.join(home, ".cursor", "projects"), { recursive: true });

cpSync(
  path.join(import.meta.dirname, "..", "fixtures", "b07", "projects", "demo"),
  path.join(home, ".cursor", "projects", "demo"),
  { recursive: true }
);

afterAll(() => {
  rmSync(home, { force: true, recursive: true });
});

const cursorAt = CursorHarness.layer.pipe(
  Layer.provide(CursorStore.layer),
  Layer.provide(HarnessHome.at(home)),
  Layer.provide(NodeServices.layer)
);

const scope = {
  dftHome,
  repoCommonDir: null,
  since: null,
  worktrees: [worktree],
};

harnessConformance("cursor", registryWith(cursorAt), {
  context: { ...emptyFlightContext, branch: "main", worktreePath: worktree },
  expectEvents: true,
  scope,
  tier: "fixture",
});

describe("Cursor harness", () => {
  it.effect("locates the transcripts of a worktree through the registry", () =>
    Effect.gen(function* locateTranscripts() {
      const registry = yield* HarnessRegistry;
      const located = yield* registry.locate(scope);

      expect(
        located.refs.map((ref) => [
          path.relative(home, ref.path),
          ref.channel,
          ref.source,
        ])
      ).toStrictEqual([
        [
          ".cursor/projects/demo/agent-transcripts/comp-T.txt",
          "transcript",
          "collector.cursor-transcripts",
        ],
        [
          ".cursor/projects/demo/agent-transcripts/comp-A/comp-A.jsonl",
          "transcript",
          "collector.cursor-transcripts",
        ],
        [
          ".cursor/projects/demo/agent-transcripts/comp-A/subagents/agent-7.jsonl",
          "transcript",
          "collector.cursor-transcripts",
        ],
      ]);

      const discovered = yield* registry.discover;

      expect(
        discovered.find((entry) => entry.harness === "cursor")?.present
      ).toBe(true);
    }).pipe(Effect.provide(registryWith(cursorAt)))
  );
});
