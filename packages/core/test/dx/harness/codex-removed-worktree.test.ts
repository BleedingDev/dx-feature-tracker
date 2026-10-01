// @effect-diagnostics nodeBuiltinImport:off -- The fixture tier scripts a throwaway git repository and copies a committed Codex session into an owned temp home.
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { afterAll, describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import {
  CodexHarness,
  CodexStore,
} from "../../../src/dx/harness/codex/index.js";
import { HarnessHome } from "../../../src/dx/harness/home.js";
import { registryWith } from "../../../src/dx/harness/registry.js";
import { contextForRepo } from "../../../src/dx/registry/runtime.js";
import { planHarnessSources } from "../../../src/dx/registry/sync.js";

const scratch = realpathSync(
  mkdtempSync(path.join(os.tmpdir(), "dft-codex-removed-"))
);

afterAll(() => {
  rmSync(scratch, { force: true, recursive: true });
});

const REPO = path.join(scratch, "repo");

const GONE = path.join(scratch, "wt-two");

const home = path.join(scratch, "home");

const SESSION =
  "rollout-2026-10-01T12-57-25-01a0f71c-a7e4-7770-a034-76f806712941.jsonl";

const git = (...args: string[]) =>
  execFileSync("git", ["-C", REPO, "-c", "core.hooksPath=/dev/null", ...args], {
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_AUTHOR_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "fixture",
    },
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();

const setUp = (): string => {
  mkdirSync(REPO, { recursive: true });
  git("init", "-q", "-b", "main");
  writeFileSync(path.join(REPO, "main.py"), "print('hi')\n");
  git("add", "main.py");
  git("commit", "-q", "-m", "init");

  const head = git("rev-parse", "HEAD");
  const archived = path.join(home, ".codex", "archived_sessions");

  const fixture = readFileSync(
    path.join(
      import.meta.dirname,
      "..",
      "fixtures",
      "harness",
      "codex",
      "home",
      ".codex",
      "archived_sessions",
      SESSION
    ),
    "utf-8"
  );

  mkdirSync(archived, { recursive: true });
  writeFileSync(
    path.join(archived, SESSION),
    fixture
      .replaceAll("/home/user/work/demo-two", GONE)
      .replaceAll("14e42b7fce2a277dfddb2fa4ba1e5fa2fadb2310", head)
  );

  return head;
};

const codexAt = CodexHarness.layer.pipe(
  Layer.provide(CodexStore.layer),
  Layer.provide(HarnessHome.at(home)),
  Layer.provide(NodeServices.layer)
);

describe("Codex sessions from a worktree removed before the first sync", () => {
  it.effect(
    "are planned under the repo when the repo knows the session's commit",
    () =>
      Effect.gen(function* plan() {
        setUp();

        const context = contextForRepo(REPO);

        const planned = yield* planHarnessSources(context, {
          cwd: REPO,
          dftHome: path.join(scratch, "dft-home"),
          home,
          repo: REPO,
          storePath: path.join(scratch, "dft-home", "events.sqlite"),
        });

        expect(
          planned
            .filter((source) => source.harness === "codex")
            .map((source) => ({
              repoCommonDir: source.context.repoCommonDir,
              session: source.ref?.sessionId ?? null,
              worktreePath: source.context.worktreePath,
            }))
        ).toStrictEqual([
          {
            repoCommonDir: context.repoCommonDir,
            session: "01a0f71c-a7e4-7770-a034-76f806712941",
            worktreePath: GONE,
          },
        ]);
      }).pipe(Effect.provide(registryWith(codexAt)))
  );
});
