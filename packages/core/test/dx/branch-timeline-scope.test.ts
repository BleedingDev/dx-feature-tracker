import { describe, expect, it } from "@effect/vitest";
import { DateTime, Effect } from "effect";

import type { GitRunner } from "../../src/dx/collectors/git-observation/git-runner.js";
import {
  WorktreeTimelines,
  reattributeWithRunner,
  sharedTimelines,
} from "../../src/dx/correlation/branch-at-time/pipeline.js";
import type { DxEventEnvelope } from "../../src/dx/model/event.js";
import {
  emptyEventIdentity,
  emptyFlightContext,
} from "../../src/dx/model/event.js";
import { EventIdSchema } from "../../src/dx/model/ids.js";

const APP = "/fixture/app";

const SIDE = "/fixture/side";

const UNRELATED = Array.from(
  { length: 40 },
  (_, index) => `/fixture/other-${String(index)}`
);

const BRANCHES = Array.from(
  { length: 30 },
  (_, index) => `feat/${String(index)}`
).join("\n");

const AT = DateTime.formatIso(
  DateTime.makeUnsafe(Date.parse("2026-09-01T00:00:00.000Z"))
);

const envelope = (
  id: string,
  kind: DxEventEnvelope["kind"],
  worktree: string | null,
  payload: DxEventEnvelope["payload"]
): DxEventEnvelope => ({
  acquisition: "file-import",
  adapterId: kind === "git.observation" ? "git-observation" : "harness.codex",
  adapterVersion: "0.2.0",
  ai:
    kind === "git.observation"
      ? null
      : {
          agentId: null,
          agentType: null,
          branchSource: "session-recorded",
          channel: "session-file",
          cwd: worktree,
          effort: null,
          effortSource: null,
          harness: "codex",
          harnessVersion: null,
          model: "fixture-model",
          modelRaw: "fixture-model",
          parentSessionId: null,
          provider: "openai",
          sessionId: `session-${id}`,
          via: null,
        },
  context: {
    ...emptyFlightContext,
    branch: "main",
    repoCommonDir: worktree === null ? null : `${worktree}/.git`,
    worktreePath: worktree,
  },
  eventId: EventIdSchema.make(id),
  evidence: { bounded: true, hash: null, ref: `fixture:${id}` },
  fieldSemantics: [],
  identity: { ...emptyEventIdentity, requestId: id },
  kind,
  observedAt: AT,
  occurredAt: AT,
  occurredAtPrecision: "exact",
  origin: "fixture",
  payload,
  schemaVersion: "dx.event.v2",
  sourceVersion: null,
  upstreamKey: id,
  usage: null,
});

const observation = (worktree: string, index: number): DxEventEnvelope =>
  envelope(`obs-${String(index)}`, "git.observation", worktree, {
    branch: "main",
    observationKind: "head-moves",
    startedAt: AT,
    transitions: [],
  });

const observations = [SIDE, ...UNRELATED].map(observation);

interface Call {
  readonly command: string | undefined;
  readonly cwd: string;
}

interface CountingRunner {
  readonly calls: Call[];
  readonly runGit: GitRunner;
}

const countingRunner = (): CountingRunner => {
  const calls: Call[] = [];

  return {
    calls,
    runGit: (cwd, args) =>
      Effect.sync(() => {
        calls.push({ command: args[0], cwd });

        return args[0] === "for-each-ref" ? BRANCHES : "";
      }),
  };
};

const request = envelope("r1", "ai.usage", APP, {});

describe("branch history loads git only for the worktrees its requests name", () => {
  it.effect(
    "spawns git for the request's worktree, not for every observed one",
    () =>
      Effect.gen(function* scoped() {
        const { calls, runGit } = countingRunner();

        const unplaced = envelope("r2", "ai.usage", null, {
          cwd: `${SIDE}/src`,
        });

        yield* reattributeWithRunner(runGit, [
          ...observations,
          request,
          unplaced,
        ]);

        expect(new Set(calls.map((call) => call.cwd))).toEqual(
          new Set([APP, `${APP}/.git`, SIDE])
        );
      })
  );

  it.effect("loads each worktree's history once across batches", () =>
    Effect.gen(function* shared() {
      const { calls, runGit } = countingRunner();

      const batch = (events: readonly DxEventEnvelope[]) =>
        reattributeWithRunner(runGit, [...observations, ...events]);

      yield* Effect.provideService(
        Effect.all([
          batch([request]),
          batch([envelope("r3", "ai.usage", APP, {})]),
        ]),
        WorktreeTimelines,
        sharedTimelines()
      );

      expect(
        calls.filter(
          (call) => call.cwd === APP && call.command === "for-each-ref"
        )
      ).toHaveLength(1);
    })
  );
});
