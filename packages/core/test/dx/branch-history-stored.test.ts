import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { DateTime, Effect, FileSystem, Path, Schema } from "effect";

import { collectGitObservation } from "../../src/dx/collectors/git-observation/collector.js";
import { spawnerGitRunner } from "../../src/dx/collectors/git-observation/git-runner.js";
import { reattributeWithRunner } from "../../src/dx/correlation/branch-at-time/pipeline.js";
import type { AiAttribution } from "../../src/dx/model/attribution.js";
import type { DxEventEnvelope } from "../../src/dx/model/event.js";
import {
  emptyEventIdentity,
  emptyFlightContext,
} from "../../src/dx/model/event.js";
import { EventIdSchema } from "../../src/dx/model/ids.js";

const GIT_CONFIG = [
  "-c",
  "user.name=Fixture",
  "-c",
  "user.email=fixture@example.invalid",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "core.hooksPath=/dev/null",
];

const decodeTransitions = Schema.decodeUnknownEffect(
  Schema.Struct({
    transitions: Schema.Array(
      Schema.Struct({ at: Schema.String, subject: Schema.String })
    ),
  })
);

const ai = (worktree: string): AiAttribution => ({
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
  sessionId: "session-1",
  via: null,
});

const request = (
  id: string,
  atMs: number,
  repoCommonDir: string,
  worktree: string
): DxEventEnvelope => ({
  acquisition: "file-import",
  adapterId: "harness.codex",
  adapterVersion: "0.2.0",
  ai: ai(worktree),
  context: {
    ...emptyFlightContext,
    branch: "feat/a",
    repoCommonDir,
    worktreePath: worktree,
  },
  eventId: EventIdSchema.make(id),
  evidence: { bounded: true, hash: null, ref: `fixture:${id}` },
  fieldSemantics: [],
  identity: {
    ...emptyEventIdentity,
    requestId: id,
    sessionId: "session-1",
  },
  kind: "ai.usage",
  observedAt: DateTime.formatIso(DateTime.makeUnsafe(atMs)),
  occurredAt: DateTime.formatIso(DateTime.makeUnsafe(atMs)),
  occurredAtPrecision: "exact",
  origin: "fixture",
  payload: {},
  schemaVersion: "dx.event.v2",
  sourceVersion: null,
  upstreamKey: id,
  usage: null,
});

describe("checkout history kept from earlier syncs", () => {
  it.live(
    "keeps each request's branch after its worktree is removed or its path reused",
    () =>
      Effect.scoped(
        Effect.gen(function* storedHistory() {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const runGit = yield* spawnerGitRunner;

          const git = (cwd: string, args: readonly string[]) =>
            runGit(cwd, [...GIT_CONFIG, ...args]);

          const root = yield* fileSystem.realPath(
            yield* fileSystem.makeTempDirectoryScoped()
          );

          const app = path.join(root, "app");
          const wt = path.join(root, "wt");

          yield* fileSystem.makeDirectory(app);
          yield* git(app, ["init", "-q", "-b", "main"]);
          yield* git(app, ["commit", "-q", "--allow-empty", "-m", "base"]);
          yield* git(app, ["worktree", "add", "-q", "-b", "feat/a", wt]);
          yield* Effect.sleep("1100 millis");
          yield* git(wt, ["switch", "-q", "-c", "feat/b2"]);
          yield* git(wt, ["commit", "-q", "--allow-empty", "-m", "work"]);

          const observed = yield* collectGitObservation(runGit, {
            adapterId: "git-observation",
            context: emptyFlightContext,
            cursor: null,
            origin: "fixture",
            scratchDir: null,
            selectedInput: wt,
          });

          const head = observed.events.find(
            (event) => event.payload.observationKind === "head-moves"
          );

          const repoCommonDir = head?.context.repoCommonDir ?? "";
          const { transitions } = yield* decodeTransitions(head?.payload);
          const switchedMs = Date.parse(transitions.at(-1)?.at ?? "");

          expect(Number.isFinite(switchedMs)).toBe(true);

          const requests = [
            request("r1", switchedMs - 500, repoCommonDir, wt),
            request("r2", switchedMs + 300, repoCommonDir, wt),
            request("r3", switchedMs + 600, repoCommonDir, wt),
          ];

          const branches = (events: readonly DxEventEnvelope[]) =>
            reattributeWithRunner(runGit, events).pipe(
              Effect.map((result) =>
                result.events
                  .filter((event) => event.kind === "ai.usage")
                  .map(
                    (event) =>
                      `${event.eventId}:${event.context.branch}:${event.ai?.branchSource}`
                  )
              )
            );

          const switched = [
            "r1:feat/a:git-at-time",
            "r2:feat/b2:git-at-time",
            "r3:feat/b2:git-at-time",
          ];

          expect(yield* branches([...observed.events, ...requests])).toEqual(
            switched
          );

          yield* git(app, ["merge", "-q", "--no-edit", "feat/b2"]);
          yield* git(app, ["worktree", "remove", wt]);

          expect(yield* branches([...observed.events, ...requests])).toEqual(
            switched
          );

          yield* Effect.sleep("1100 millis");
          yield* git(app, ["worktree", "add", "-q", "-b", "feat/b", wt]);

          expect(yield* branches([...observed.events, ...requests])).toEqual(
            switched
          );

          expect(yield* branches(requests)).toEqual([
            "r1:feat/a:session-recorded",
            "r2:feat/a:session-recorded",
            "r3:feat/a:session-recorded",
          ]);
        })
      ).pipe(Effect.provide(NodeServices.layer))
  );
});
