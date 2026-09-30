import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";
import { TestClock } from "effect/testing";

import {
  collectGitObservation,
  gitObservationCollector,
  gitObservationDescriptor,
  makeGitObservationCollector,
} from "../../src/dx/collectors/git-observation/collector.js";
import { spawnerGitRunner } from "../../src/dx/collectors/git-observation/git-runner.js";
import type { GitRunner } from "../../src/dx/collectors/git-observation/git-runner.js";
import {
  parseNumstat,
  parseReflog,
  parseStatusPorcelainV2,
} from "../../src/dx/collectors/git-observation/parse.js";
import { SourceUnavailable } from "../../src/dx/contracts/error-source-unavailable.js";
import type { CollectInput } from "../../src/dx/contracts/services.js";
import { ModuleDescriptorSchema } from "../../src/dx/model/descriptor.js";
import {
  EventBatchSchema,
  emptyFlightContext,
} from "../../src/dx/model/event.js";

const FixtureSchema = Schema.Struct({
  fixtureId: Schema.String,
  gitVersion: Schema.String,
  numstat: Schema.String,
  origin: Schema.Literal("fixture"),
  reflog: Schema.String,
  revParse: Schema.String,
  status: Schema.String,
});

type Fixture = typeof FixtureSchema.Type;

const loadFixture = Effect.gen(function* loadFixture() {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const text = yield* fileSystem.readFileString(
    path.join(
      import.meta.dirname,
      "fixtures",
      "b04",
      "porcelain-dirty-feature.json"
    )
  );

  return yield* Schema.decodeEffect(Schema.fromJsonString(FixtureSchema))(text);
});

const inputFor = (
  selectedInput: string | null,
  origin: CollectInput["origin"]
): CollectInput => ({
  adapterId: "git-observation",
  context: emptyFlightContext,
  cursor: null,
  origin,
  scratchDir: null,
  selectedInput,
});

const fixtureRunner =
  (fixture: Fixture): GitRunner =>
  (_cwd, args) => {
    const outputs = new Map([
      ["diff", fixture.numstat],
      ["hash-object", "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391\n"],
      ["log", fixture.reflog],
      ["rev-parse", fixture.revParse],
      ["status", fixture.status],
      ["version", fixture.gitVersion],
    ]);

    const output = outputs.get(args[0] ?? "");

    return output === undefined
      ? Effect.fail(
          new SourceUnavailable({
            adapterId: "git-observation",
            message: "unexpected git call",
          })
        )
      : Effect.succeed(output);
  };

const failingRunner: GitRunner = () =>
  Effect.fail(
    new SourceUnavailable({
      adapterId: "git-observation",
      message: "not a repository",
    })
  );

describe("b04 git observation parsers", () => {
  it.effect("counts porcelain v2 entries including rename and conflict", () =>
    Effect.gen(function* parsesStatus() {
      const fixture = yield* loadFixture;
      const state = parseStatusPorcelainV2(fixture.status);

      expect(state).toEqual({
        ahead: 2,
        behind: 1,
        branch: "feature/cost-tracker",
        conflictedFiles: 1,
        headSha: "1111111111111111111111111111111111111111",
        stagedFiles: 2,
        trackedChangedFiles: 3,
        untrackedFiles: 2,
        upstream: "origin/feature/cost-tracker",
      });
      expect(parseNumstat(fixture.numstat)).toEqual({
        binaryFiles: 1,
        files: 4,
        linesAdded: 17,
        linesDeleted: 3,
      });
    }).pipe(Effect.provide(NodeServices.layer))
  );

  it.effect("keeps only reflog actions, never commit messages", () =>
    Effect.gen(function* parsesReflog() {
      const fixture = yield* loadFixture;
      const entries = parseReflog(fixture.reflog);

      expect(entries.map((entry) => entry.action)).toEqual([
        "commit",
        "commit (amend)",
        "reset",
        "branch",
      ]);
      expect(entries[3]?.createdFrom).toBe("main");
      expect(entries[3]?.occurredAt).toBe("2026-09-30T11:00:00.000Z");
      expect(JSON.stringify(entries)).not.toContain("secret");
      expect(JSON.stringify(entries)).not.toContain("private");
    }).pipe(Effect.provide(NodeServices.layer))
  );
});

describe("b04 git observation collector", () => {
  it.effect("requires an explicit opt-in worktree", () =>
    Effect.gen(function* requiresInput() {
      const fixture = yield* loadFixture;
      const collector = makeGitObservationCollector(fixtureRunner(fixture));

      const error = yield* Effect.flip(
        collector.collect(inputFor(null, "fixture"))
      );

      expect(error._tag).toBe("InvalidInput");
    }).pipe(Effect.provide(NodeServices.layer))
  );

  it.effect(
    "emits a deduplicable working-tree observation and reflog events",
    () =>
      Effect.gen(function* collectsFixture() {
        const fixture = yield* loadFixture;
        yield* TestClock.setTime(Date.parse("2026-09-30T12:05:00.000Z"));
        const runner = fixtureRunner(fixture);

        const batch = yield* collectGitObservation(
          runner,
          inputFor("/fixture/repo", "fixture")
        );

        const decoded = yield* Schema.decodeEffect(EventBatchSchema)(batch);

        const [state, ...reflog] = decoded.events;

        expect(decoded.events).toHaveLength(5);
        expect(state?.kind).toBe("git.observation");
        expect(state?.origin).toBe("fixture");
        expect(state?.sourceVersion).toBe("2.56.0");
        expect(state?.context.branch).toBe("feature/cost-tracker");
        expect(state?.context.repoCommonDir).toBe("/fixture/repo/.git");
        expect(state?.payload).toMatchObject({
          observationKind: "working-tree",
          uncommittedLinesAdded: 17,
          uncommittedLinesDeleted: 3,
          untrackedFiles: 2,
        });
        expect(reflog.map((event) => event.payload.action)).toEqual([
          "commit",
          "commit (amend)",
          "reset",
          "branch",
        ]);
        expect(decoded.coverage.state).toBe("partial");
        expect(decoded.coverage.windowFrom).toBe("2026-09-30T11:00:00.000Z");
        expect(decoded.coverage.gaps.map((gap) => gap.code)).toContain(
          "observation-not-history"
        );
        expect(state?.payload.worktreeFingerprint).toMatch(/^[0-9a-f]{64}$/u);
        expect(decoded.coverage.gaps.map((gap) => gap.code)).not.toContain(
          "fingerprint-unavailable"
        );
        expect(JSON.stringify(decoded)).not.toContain("secret");

        const again = yield* collectGitObservation(
          runner,
          inputFor("/fixture/repo", "fixture")
        );

        expect(again.events.map((event) => event.eventId)).toEqual(
          decoded.events.map((event) => event.eventId)
        );
      }).pipe(Effect.provide(NodeServices.layer))
  );

  it.effect("reports a git failure as SourceUnavailable", () =>
    Effect.gen(function* failsUnavailable() {
      const error = yield* Effect.flip(
        collectGitObservation(failingRunner, inputFor("/nowhere", "live"))
      );

      expect(error._tag).toBe("SourceUnavailable");
    })
  );

  it("publishes a decodable ready descriptor with visible gaps", () => {
    const descriptor = Schema.decodeSync(ModuleDescriptorSchema)(
      gitObservationDescriptor
    );

    expect(descriptor.readiness).toBe("ready");
    expect(descriptor.gaps.map((gap) => gap.code)).toEqual([
      "observation-not-history",
      "reflog-local-retention",
      "no-ai-attribution",
    ]);
    expect(gitObservationCollector.descriptor).toBe(gitObservationDescriptor);
  });
});

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

describe("b04 live temp repository", () => {
  it.effect("observes a real branch, dirty edits and its creation", () =>
    Effect.scoped(
      Effect.gen(function* observesLiveRepo() {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const runGit = yield* spawnerGitRunner;

        const git = (repo: string, args: readonly string[]) =>
          runGit(repo, [...GIT_CONFIG, ...args]);

        const root = yield* fileSystem.makeTempDirectoryScoped();
        const repo = path.join(root, "repo");

        yield* fileSystem.makeDirectory(repo);
        yield* git(repo, ["init", "-q", "-b", "main"]);
        yield* fileSystem.writeFileString(path.join(repo, "a.txt"), "one\n");
        yield* git(repo, ["add", "a.txt"]);
        yield* git(repo, ["commit", "-q", "-m", "base"]);
        yield* git(repo, ["switch", "-q", "-c", "feature/x"]);
        yield* fileSystem.writeFileString(
          path.join(repo, "a.txt"),
          "one\ntwo\nthree\n"
        );
        yield* fileSystem.writeFileString(path.join(repo, "b.txt"), "new\n");

        const batch = yield* gitObservationCollector.collect(
          inputFor(repo, "live")
        );

        const [state, ...reflog] = batch.events;

        expect(state?.context.branch).toBe("feature/x");
        expect(state?.origin).toBe("live");
        expect(state?.payload).toMatchObject({
          trackedChangedFiles: 1,
          uncommittedLinesAdded: 2,
          uncommittedLinesDeleted: 0,
          untrackedFiles: 1,
        });
        expect(reflog.map((event) => event.payload.action)).toEqual(["branch"]);
        expect(reflog[0]?.payload.createdFrom).toBe("HEAD");
        expect(reflog[0]?.occurredAt).not.toBeNull();

        const unchanged = yield* gitObservationCollector.collect(
          inputFor(repo, "live")
        );

        expect(unchanged.events[0]?.eventId).toBe(state?.eventId);

        yield* fileSystem.writeFileString(
          path.join(repo, "b.txt"),
          "new\nmore\n"
        );

        const edited = yield* gitObservationCollector.collect(
          inputFor(repo, "live")
        );

        expect(edited.events[0]?.eventId).not.toBe(state?.eventId);
      })
    ).pipe(Effect.provide(NodeServices.layer))
  );
});
