// @effect-diagnostics nodeBuiltinImport:off -- The fixture tier scripts a throwaway git repository with a removed worktree and copies a committed Claude Code session into an owned temp home.
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { afterAll, describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import {
  ClaudeCodeHarness,
  ClaudeCodeStore,
} from "../../../src/dx/harness/claude-code/index.js";
import { projectSlug } from "../../../src/dx/harness/claude-code/paths.js";
import { HarnessHome } from "../../../src/dx/harness/home.js";
import {
  HarnessRegistry,
  registryWith,
} from "../../../src/dx/harness/registry.js";
import type { FlightContext } from "../../../src/dx/model/event.js";
import { contextForRepo } from "../../../src/dx/registry/runtime.js";
import { planHarnessSources } from "../../../src/dx/registry/sync.js";

const scratch = realpathSync(
  mkdtempSync(path.join(os.tmpdir(), "dft-claude-removed-"))
);

afterAll(() => {
  rmSync(scratch, { force: true, recursive: true });
});

const REPO = path.join(scratch, "repo");

const home = path.join(scratch, "home");

const BRANCH = "feat/claude-code-two";

const FIXTURE_CWD = "/home/user/work/claude-code/wt-two";

const SESSION = "464d3ae5-0952-4217-9f80-fabd271a363d";

const FIXTURE_TIME = Date.parse("2026-10-01T10:56:00.000Z") / 1000;

const fixture = readFileSync(
  path.join(
    import.meta.dirname,
    "..",
    "fixtures",
    "harness",
    "claude-code",
    "claude-home",
    "projects",
    "-home-user-work-claude-code-wt-two",
    `${SESSION}.jsonl`
  ),
  "utf-8"
);

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

const commitInWorktree = (
  worktree: string,
  branch: string,
  keepBranch: boolean
): string => {
  git("worktree", "add", "-q", "-b", branch, worktree);
  writeFileSync(path.join(worktree, "main.py"), `print('${branch}')\n`);
  execFileSync("git", ["-C", worktree, "add", "main.py"]);
  execFileSync(
    "git",
    [
      "-C",
      worktree,
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-q",
      "-m",
      "Document greet",
    ],
    {
      env: {
        ...process.env,
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_AUTHOR_NAME: "fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "fixture",
      },
      stdio: "ignore",
    }
  );

  const sha = execFileSync("git", ["-C", worktree, "rev-parse", "HEAD"], {
    encoding: "utf-8",
  }).trim();

  git("worktree", "remove", "--force", worktree);

  if (!keepBranch) {
    git("branch", "-D", branch);
  }

  return sha;
};

const withLastToolResult = (text: string, output: string): string => {
  const lines = text.split("\n");

  const last = lines.findLastIndex((line) =>
    line.includes('"type":"tool_result"')
  );

  return lines
    .map((line, index) =>
      index === last
        ? line.replaceAll(
            '"content":"synthetic text"',
            `"content":${JSON.stringify(output)}`
          )
        : line
    )
    .join("\n");
};

const writeSession = (cwd: string, toolOutput: string): void => {
  const dir = path.join(home, ".claude", "projects", projectSlug(cwd));
  const file = path.join(dir, `${SESSION}.jsonl`);

  mkdirSync(dir, { recursive: true });
  writeFileSync(
    file,
    withLastToolResult(fixture.replaceAll(FIXTURE_CWD, cwd), toolOutput)
  );
  utimesSync(file, FIXTURE_TIME, FIXTURE_TIME);
};

const MOVE_AT_LINE = 30;

const movedAfter = (text: string, cwd: string, branch: string): string =>
  text
    .split("\n")
    .map((line, index) =>
      index < MOVE_AT_LINE
        ? line
        : line
            .replaceAll(
              `"cwd":${JSON.stringify(FIXTURE_CWD)}`,
              `"cwd":${JSON.stringify(cwd)}`
            )
            .replaceAll(
              `"gitBranch":${JSON.stringify(BRANCH)}`,
              `"gitBranch":${JSON.stringify(branch)}`
            )
    )
    .join("\n");

const writeMovingSession = (
  start: string,
  later: string,
  laterBranch: string,
  toolOutput: string
): void => {
  const dir = path.join(home, ".claude", "projects", projectSlug(start));
  const file = path.join(dir, `${SESSION}.jsonl`);

  mkdirSync(dir, { recursive: true });
  writeFileSync(
    file,
    withLastToolResult(
      movedAfter(fixture, later, laterBranch).replaceAll(FIXTURE_CWD, start),
      toolOutput
    )
  );
  utimesSync(file, FIXTURE_TIME, FIXTURE_TIME);
};

const setUpRepo = (): void => {
  rmSync(REPO, { force: true, recursive: true });
  rmSync(home, { force: true, recursive: true });
  mkdirSync(REPO, { recursive: true });
  git("init", "-q", "-b", "main");
  writeFileSync(path.join(REPO, "main.py"), "print('hi')\n");
  git("add", "main.py");
  git("commit", "-q", "-m", "init");
};

const claudeAt = Layer.fresh(ClaudeCodeHarness.layer).pipe(
  Layer.provide(ClaudeCodeStore.layer),
  Layer.provide(HarnessHome.at(home)),
  Layer.provide(NodeServices.layer)
);

const planClaude = (context: FlightContext) =>
  planHarnessSources(context, {
    cwd: REPO,
    dftHome: path.join(scratch, "dft-home"),
    home,
    repo: REPO,
    storePath: path.join(scratch, "dft-home", "events.sqlite"),
  }).pipe(
    Effect.map((planned) =>
      planned.filter((source) => source.harness === "claude-code")
    )
  );

const placedOf = (context: FlightContext) =>
  Effect.gen(function* readPlanned() {
    const registry = yield* HarnessRegistry;
    const harness = registry.get("claude-code");
    const planned = yield* planClaude(context);

    const usage = yield* Effect.forEach((source: (typeof planned)[number]) =>
      source.ref === null || harness === null
        ? Effect.succeed([])
        : harness
            .read(source.ref, {
              context: source.context,
              cursor: null,
              origin: "fixture",
            })
            .pipe(Effect.map((batch) => batch.events))
    )(planned);

    const ids = usage.flat().map((event) => event.eventId);

    return {
      planned: planned.map((source) => ({
        repoCommonDir: source.context.repoCommonDir,
        session: source.ref?.sessionId ?? null,
        worktreePath: source.context.worktreePath,
      })),
      repeated: ids.length - new Set(ids).size,
      usage: [
        ...new Set(
          usage
            .flat()
            .filter((event) => event.kind === "ai.usage")
            .map(
              (event) =>
                `${event.context.worktreePath ?? "-"}|${event.context.branch ?? "-"}|${event.ai?.branchSource ?? "-"}|${event.context.repoCommonDir === null ? "no-repo" : "repo"}`
            )
        ),
      ],
    };
  });

const keptUnder = (gone: string, context: FlightContext) => [
  {
    repoCommonDir: context.repoCommonDir,
    session: SESSION,
    worktreePath: gone,
  },
];

describe("Claude Code sessions from a worktree removed before the first sync", () => {
  it.effect(
    "are kept under the removed worktree when the repo knows a commit the session recorded",
    () =>
      Effect.gen(function* recordedCommit() {
        setUpRepo();

        const gone = path.join(scratch, "wt-two");
        const sha = commitInWorktree(gone, BRANCH, false);

        writeSession(
          gone,
          `[${BRANCH} ${sha.slice(0, 7)}] Document greet\n 1 file changed, 1 insertion(+)`
        );

        const context = contextForRepo(REPO);
        const { planned, usage } = yield* placedOf(context);

        expect(planned).toStrictEqual(keptUnder(gone, context));
        expect(usage).toStrictEqual([
          `${gone}|${BRANCH}|harness-recorded|repo`,
        ]);
      }).pipe(Effect.provide(registryWith(claudeAt)))
  );

  it.effect(
    "are kept when the session points at the repo's git common dir",
    () =>
      Effect.gen(function* commonDirEvidence() {
        setUpRepo();

        const gone = path.join(scratch, "wt-three");
        const context = contextForRepo(REPO);

        commitInWorktree(gone, BRANCH, false);
        writeSession(
          gone,
          `gitdir: ${context.repoCommonDir ?? ""}/worktrees/wt-three`
        );

        const { planned } = yield* placedOf(context);

        expect(planned).toStrictEqual(keptUnder(gone, context));
      }).pipe(Effect.provide(registryWith(claudeAt)))
  );

  it.effect(
    "are kept once under the removed worktree when its folder name extends the repo's",
    () =>
      Effect.gen(function* prefixedName() {
        setUpRepo();

        const gone = path.join(scratch, "repo-two");
        const sha = commitInWorktree(gone, BRANCH, false);

        writeSession(gone, `[${BRANCH} ${sha.slice(0, 9)}] Document greet`);

        const context = contextForRepo(REPO);
        const { planned, usage } = yield* placedOf(context);

        expect(planned).toStrictEqual(keptUnder(gone, context));
        expect(usage).toStrictEqual([
          `${gone}|${BRANCH}|harness-recorded|repo`,
        ]);
      }).pipe(Effect.provide(registryWith(claudeAt)))
  );

  it.effect(
    "are not kept when nothing in the session points into the repo",
    () =>
      Effect.gen(function* noEvidence() {
        setUpRepo();

        const gone = path.join(scratch, "wt-four");

        commitInWorktree(gone, BRANCH, false);
        writeSession(gone, "[feat/elsewhere 0123abc] Document greet");

        const { planned } = yield* placedOf(contextForRepo(REPO));

        expect(planned).toStrictEqual([]);
      }).pipe(Effect.provide(registryWith(claudeAt)))
  );

  it.effect("are not kept on a branch name alone", () =>
    Effect.gen(function* checkedOutBranch() {
      setUpRepo();

      const gone = path.join(scratch, "wt-five");

      commitInWorktree(gone, BRANCH, true);
      writeSession(gone, "synthetic text");

      const { planned } = yield* placedOf(contextForRepo(REPO));

      expect(planned).toStrictEqual([]);
    }).pipe(Effect.provide(registryWith(claudeAt)))
  );

  it.effect(
    "store requests that move into the live main worktree under the repo when the removed folder name extends the repo's",
    () =>
      Effect.gen(function* movesIntoRepo() {
        setUpRepo();

        const gone = path.join(scratch, "repo-two");
        const sha = commitInWorktree(gone, BRANCH, false);

        writeMovingSession(
          gone,
          REPO,
          "main",
          `[${BRANCH} ${sha.slice(0, 7)}] Document greet`
        );

        const context = contextForRepo(REPO);
        const { planned, repeated, usage } = yield* placedOf(context);

        expect(planned).toStrictEqual([
          ...keptUnder(gone, context),
          {
            repoCommonDir: context.repoCommonDir,
            session: SESSION,
            worktreePath: REPO,
          },
        ]);
        expect(usage.toSorted()).toStrictEqual(
          [
            `${gone}|${BRANCH}|harness-recorded|repo`,
            `${REPO}|main|harness-recorded|repo`,
          ].toSorted()
        );
        expect(repeated).toBe(0);
      }).pipe(Effect.provide(registryWith(claudeAt)))
  );

  it.effect(
    "store requests that move into the live main worktree under the repo when the removed folder name does not extend the repo's",
    () =>
      Effect.gen(function* unrelatedName() {
        setUpRepo();

        const gone = path.join(scratch, "wt-six");
        const sha = commitInWorktree(gone, BRANCH, false);

        writeMovingSession(
          gone,
          REPO,
          "main",
          `[${BRANCH} ${sha.slice(0, 7)}] Document greet`
        );

        const context = contextForRepo(REPO);
        const { planned, repeated, usage } = yield* placedOf(context);

        expect(planned).toStrictEqual([
          ...keptUnder(gone, context),
          {
            repoCommonDir: context.repoCommonDir,
            session: SESSION,
            worktreePath: REPO,
          },
        ]);
        expect(usage.toSorted()).toStrictEqual(
          [
            `${gone}|${BRANCH}|harness-recorded|repo`,
            `${REPO}|main|harness-recorded|repo`,
          ].toSorted()
        );
        expect(repeated).toBe(0);
      }).pipe(Effect.provide(registryWith(claudeAt)))
  );

  it.effect(
    "store requests that move outside every worktree once, as (no repo), from the removed folder",
    () =>
      Effect.gen(function* movesNowhere() {
        setUpRepo();

        const gone = path.join(scratch, "wt-seven");
        const nowhere = path.join(scratch, "elsewhere");
        const sha = commitInWorktree(gone, BRANCH, false);

        writeMovingSession(
          gone,
          nowhere,
          "main",
          `[${BRANCH} ${sha.slice(0, 7)}] Document greet`
        );

        const context = contextForRepo(REPO);
        const { planned, repeated, usage } = yield* placedOf(context);

        expect(planned).toStrictEqual(keptUnder(gone, context));
        expect(usage.toSorted()).toStrictEqual(
          [
            `${gone}|${BRANCH}|harness-recorded|repo`,
            "-|main|harness-recorded|no-repo",
          ].toSorted()
        );
        expect(repeated).toBe(0);
      }).pipe(Effect.provide(registryWith(claudeAt)))
  );

  it.effect("leave a sibling folder that still exists to its own sync", () =>
    Effect.gen(function* liveSibling() {
      setUpRepo();

      const sibling = path.join(scratch, "other");
      const head = git("rev-parse", "HEAD");

      mkdirSync(sibling, { recursive: true });
      writeSession(sibling, `[main ${head.slice(0, 7)}] init`);

      const { planned } = yield* placedOf(contextForRepo(REPO));

      expect(planned).toStrictEqual([]);
    }).pipe(Effect.provide(registryWith(claudeAt)))
  );
});
