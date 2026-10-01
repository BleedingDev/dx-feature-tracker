import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";

import { gitRunFor } from "../../src/dx/collectors/git-identity/git-runner.js";
import { repoLocator } from "../../src/dx/correlation/attribution/locator.js";
import { repoCorrelationDescriptor } from "../../src/dx/correlation/repo/descriptor.js";
import {
  containedJoin,
  isContained,
  normalizePath,
  relativeWithin,
} from "../../src/dx/correlation/repo/path.js";
import {
  buildRepoMap,
  correlateContext,
  parseWorktreePorcelain,
  resolvePath,
} from "../../src/dx/correlation/repo/worktree-map.js";
import type { RepoMap } from "../../src/dx/correlation/repo/worktree-map.js";
import { GitRunner, notARepo } from "../../src/dx/harness/git.js";
import { ModuleDescriptorSchema } from "../../src/dx/model/descriptor.js";
import { emptyFlightContext } from "../../src/dx/model/event.js";

const PORCELAIN_URL = new URL(
  "fixtures/b23/worktree-porcelain.txt",
  import.meta.url
);

const fixtureMap = Effect.fn("b23.fixtureMap")(function* fixtureMap() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = yield* fs.readFileString(yield* path.fromFileUrl(PORCELAIN_URL));
  const records = parseWorktreePorcelain(text);
  const map = buildRepoMap("/work/repo/.git", records);

  if (map === null) {
    return yield* Effect.die("fixture map");
  }

  return { map, records };
});

describe("B23 path containment", () => {
  it("normalises lexically and rejects relative paths", () => {
    expect(normalizePath("/a/./b/../c/")).toBe("/a/c");
    expect(normalizePath("C:\\Users\\x\\..\\y")).toBe("C:/Users/y");
    expect(normalizePath("relative/path")).toBeNull();
    expect(normalizePath("")).toBeNull();
    expect(normalizePath("/../..")).toBe("/");
  });

  it("is segment-aware and blocks traversal", () => {
    expect(isContained("/work/repo", "/work/repo/src/a.ts")).toBe(true);
    expect(isContained("/work/repo", "/work/repo2/a.ts")).toBe(false);
    expect(isContained("/work/repo", "/work/repo/../repo2")).toBe(false);
    expect(relativeWithin("/work/repo/", "/work/repo")).toBe("");
    expect(relativeWithin("/", "/etc")).toBe("etc");
    expect(containedJoin("/work/repo", "src/a.ts")).toBe("/work/repo/src/a.ts");
    expect(containedJoin("/work/repo", "../../etc/passwd")).toBeNull();
    expect(containedJoin("/work/repo", "/etc/passwd")).toBeNull();
  });
});

describe("B23 worktree mapping (fixture b23-worktree-porcelain)", () => {
  it.effect("parses porcelain including detached and prunable entries", () =>
    Effect.gen(function* testBody() {
      const { records } = yield* fixtureMap();

      expect(
        records.map((r) => [r.path, r.branch, r.detached, r.prunable])
      ).toEqual([
        ["/work/repo", "main", false, false],
        ["/work/repo/.worktrees/feature-x", "feature/x", false, false],
        ["/work/repo-detached", null, true, false],
        ["/work/gone", "stale", false, true],
      ]);
    }).pipe(Effect.provide(NodeServices.layer))
  );

  it.effect("resolves nested worktrees to the innermost root", () =>
    Effect.gen(function* testBody() {
      const { map } = yield* fixtureMap();

      const nested = resolvePath(
        [map],
        "/work/repo/.worktrees/feature-x/src/a.ts"
      );

      const main = resolvePath([map], "/work/repo/src/a.ts");

      expect(nested).toMatchObject({
        relativePath: "src/a.ts",
        repoCommonDir: "/work/repo/.git",
        status: "matched",
        worktree: { branch: "feature/x" },
      });
      expect(main).toMatchObject({
        status: "matched",
        worktree: { branch: "main" },
      });
      expect(resolvePath([map], "/work/repo2/a.ts").status).toBe("outside");
      expect(resolvePath([map], "/work/repo/.git/HEAD").status).toBe("outside");
      expect(resolvePath([map], "src/a.ts").status).toBe("invalid");
    }).pipe(Effect.provide(NodeServices.layer))
  );

  it.effect("reports ambiguity when two repositories claim a path", () =>
    Effect.gen(function* testBody() {
      const { map } = yield* fixtureMap();
      const clone: RepoMap = { ...map, repoCommonDir: "/elsewhere/.git" };

      expect(resolvePath([map, clone], "/work/repo/a.ts").status).toBe(
        "ambiguous"
      );
    }).pipe(Effect.provide(NodeServices.layer))
  );

  it.effect(
    "assigns context, keeps branch null when detached, flags multi-root and conflicts",
    () =>
      Effect.gen(function* testBody() {
        const { map } = yield* fixtureMap();

        const assigned = correlateContext([map], emptyFlightContext, [
          "/work/repo/.worktrees/feature-x",
          "/work/repo/.worktrees/feature-x/README.md",
        ]);

        expect(assigned.assignment).toBe("assigned");
        expect(assigned.context).toEqual({
          branch: "feature/x",
          flightId: null,
          headSha: "2222222222222222222222222222222222222222",
          repoCommonDir: "/work/repo/.git",
          worktreePath: "/work/repo/.worktrees/feature-x",
        });
        expect(assigned.relativePaths).toEqual(["", "README.md"]);

        const detached = correlateContext([map], emptyFlightContext, [
          "/work/repo-detached/x.ts",
        ]);

        expect(detached.assignment).toBe("detached");
        expect(detached.context.branch).toBeNull();
        expect(detached.context.repoCommonDir).toBe("/work/repo/.git");

        expect(
          correlateContext([map], emptyFlightContext, [
            "/work/repo/a.ts",
            "/work/repo/.worktrees/feature-x/b.ts",
          ]).assignment
        ).toBe("multi-root");

        const conflict = correlateContext(
          [map],
          { ...emptyFlightContext, repoCommonDir: "/other/.git" },
          ["/work/repo/a.ts"]
        );

        expect(conflict.assignment).toBe("conflict");
        expect(conflict.context.repoCommonDir).toBe("/other/.git");
        expect(correlateContext([map], emptyFlightContext, []).assignment).toBe(
          "unassigned"
        );
      }).pipe(Effect.provide(NodeServices.layer))
  );

  it("exports a valid ready correlation descriptor", () => {
    const decoded = Schema.decodeSync(ModuleDescriptorSchema)(
      repoCorrelationDescriptor
    );

    expect(decoded.kind).toBe("correlation");
    expect(decoded.readiness).toBe("ready");
  });
});

describe("B23 live Git layout (fixture b23-live-linked-worktree)", () => {
  const liveGit = Layer.provideMerge(GitRunner.layer, NodeServices.layer);

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

  const git = Effect.fn("b23.git")(function* git(
    cwd: string,
    args: readonly string[]
  ) {
    const run = yield* gitRunFor(cwd);
    const result = yield* run([...GIT_CONFIG, ...args]);
    expect(result.exitCode).toBe(0);

    return result.stdout.trim();
  });

  const makeRepo = Effect.fn("b23.makeRepo")(function* makeRepo() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
    const main = path.join(root, "repo");
    const linked = path.join(root, "repo-feature");
    yield* fs.makeDirectory(path.join(main, "src"), { recursive: true });
    yield* git(main, ["init", "-q", "-b", "main"]);
    yield* fs.writeFileString(path.join(main, "src", "a.ts"), "x\n");
    yield* git(main, ["add", "."]);
    yield* git(main, ["commit", "-q", "-m", "init"]);
    yield* git(main, ["worktree", "add", "-q", "-b", "feature/cost", linked]);
    yield* git(main, ["pack-refs", "--all"]);
    const head = yield* git(main, ["rev-parse", "HEAD"]);

    return { head, linked, main, root };
  });

  it.effect(
    "places a linked worktree's file and lists worktrees read-only",
    () =>
      Effect.gen(function* testBody() {
        const path = yield* Path.Path;
        const runner = yield* GitRunner;
        const locator = yield* repoLocator;
        const { head, linked, main, root } = yield* makeRepo();

        expect(yield* runner.at(path.join(linked, "src"))).toEqual({
          branch: "feature/cost",
          headSha: head,
          repoCommonDir: `${main}/.git`,
          worktreePath: linked,
        });

        expect(yield* locator.locate(path.join(linked, "src", "a.ts"))).toEqual(
          {
            kind: "repo",
            location: {
              branch: "feature/cost",
              headSha: head,
              repoCommonDir: `${main}/.git`,
              worktreePath: linked,
            },
          }
        );

        expect(yield* runner.worktrees(path.join(main, "src"))).toEqual([
          { branch: "main", headSha: head, path: main },
          { branch: "feature/cost", headSha: head, path: linked },
        ]);

        expect(yield* runner.at(root)).toEqual(notARepo);
      }).pipe(Effect.scoped, Effect.provide(liveGit))
  );

  it.effect("leaves a deleted linked worktree out of the worktree list", () =>
    Effect.gen(function* testBody() {
      const fs = yield* FileSystem.FileSystem;
      const runner = yield* GitRunner;
      const { head, linked, main } = yield* makeRepo();
      yield* git(linked, ["checkout", "-q", "--detach"]);
      yield* fs.remove(linked, { recursive: true });

      expect(yield* runner.worktrees(main)).toEqual([
        { branch: "main", headSha: head, path: main },
      ]);
    }).pipe(Effect.scoped, Effect.provide(liveGit))
  );
});
