// @effect-diagnostics nodeBuiltinImport:off -- The retention test copies redacted tool sessions into a throwaway HOME, spawns the built dft binary, deletes the sessions and syncs again.
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "@effect/vitest";
import { cursorProjectSlug } from "@rat-stack/core/dx";
import { Schema } from "effect";

const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "dft-retain-")));

afterAll(() => {
  rmSync(scratch, { force: true, recursive: true });
});

const repo = path.join(scratch, "app");

const dftHome = path.join(scratch, "dft-home");

const cliPath = path.resolve(import.meta.dirname, "../dist/dft-main.js");

const fixtures = path.resolve(
  import.meta.dirname,
  "../../../packages/core/test/dx/fixtures"
);

const PROMPT_MARKER = "d41-prompt-marker-never-stored";

const REDACTED_PROMPTS = [
  "synthetic text",
  "Synthetic text.",
  "fixture text",
  "fixture prompt one",
  "Fixture instructions.",
] as const;

const slug = repo.replaceAll(/[^A-Za-z0-9]/gu, "-");

const SESSIONS = [
  {
    cwd: "/home/user/work/claude-code/repo",
    from: "harness/claude-code/claude-home/projects/-home-user-work-claude-code-repo/1100de81-3953-4d9f-9243-9d4e657a37fe.jsonl",
    to: `.claude/projects/${slug}/1100de81-3953-4d9f-9243-9d4e657a37fe.jsonl`,
  },
  {
    cwd: "/home/user/work/demo",
    from: "harness/codex/home/.codex/sessions/2026/10/01/rollout-2026-10-01T12-54-41-01a0f71a-2858-7732-a298-0263fe414142.jsonl",
    to: ".codex/sessions/2026/10/01/rollout-2026-10-01T12-54-41-01a0f71a-2858-7732-a298-0263fe414142.jsonl",
  },
  {
    cwd: "/home/user/projects/pi-demo",
    from: "harness/pi/home/.pi/agent/sessions/--home-user-projects-pi-demo--/2026-10-01T10-53-18-513Z_01a0f718-e330-7250-b94b-fc0576b8089d.jsonl",
    to: `.pi/agent/sessions/-${slug}--/2026-10-01T10-53-18-513Z_01a0f718-e330-7250-b94b-fc0576b8089d.jsonl`,
  },
  {
    cwd: "/home/user/work/repo",
    from: "harness/omp/sessions/-work-repo/2026-10-01T10-57-25-610Z_01a0f71c-a86a-701c-acfd-34b9dee677f7.jsonl",
    to: `.omp/agent/sessions/${slug}/2026-10-01T10-57-25-610Z_01a0f71c-a86a-701c-acfd-34b9dee677f7.jsonl`,
  },
  {
    cwd: null,
    from: "b07/projects/demo/agent-transcripts/comp-A/comp-A.jsonl",
    to: `.cursor/projects/${cursorProjectSlug(repo)}/agent-transcripts/comp-A/comp-A.jsonl`,
  },
] as const;

const SETTLED_AT_SECONDS = 1_788_220_800;

const git = (...args: readonly string[]) =>
  execFileSync("git", ["-C", repo, "-c", "core.hooksPath=/dev/null", ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  });

const makeRepo = () => {
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "fixture");
  writeFileSync(path.join(repo, "a.txt"), "app\n");
  git("add", ".");
  git("commit", "-q", "--no-gpg-sign", "-m", "init");
};

const marked = (text: string): string => {
  let current = text;

  for (const prompt of REDACTED_PROMPTS) {
    current = current.replaceAll(prompt, PROMPT_MARKER);
  }

  return current;
};

const copySessions = (): readonly string[] =>
  SESSIONS.map((session) => {
    const target = path.join(scratch, session.to);
    const source = readFileSync(path.join(fixtures, session.from), "utf-8");

    const text =
      session.cwd === null ? source : source.replaceAll(session.cwd, repo);

    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, marked(text));
    utimesSync(target, SETTLED_AT_SECONDS, SETTLED_AT_SECONDS);

    return target;
  });

const dft = (args: readonly string[]) =>
  spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repo,
    encoding: "utf-8",
    env: {
      ...process.env,
      DFT_CURSOR_USAGE: "off",
      DFT_HOME: dftHome,
      DFT_PRICE_CATALOG: "off",
      HOME: scratch,
    },
  });

const UsageJson = Schema.fromJsonString(
  Schema.Struct({
    coverage: Schema.Struct({
      facts: Schema.Number,
      tools: Schema.Array(Schema.String),
    }),
    groups: Schema.Array(
      Schema.Struct({
        key: Schema.String,
        values: Schema.Record(Schema.String, Schema.NullOr(Schema.Number)),
      })
    ),
    total: Schema.Struct({
      values: Schema.Record(Schema.String, Schema.NullOr(Schema.Number)),
    }),
  })
);

const decodeUsage = Schema.decodeUnknownSync(UsageJson);

const usage = () => {
  const result = dft([
    "usage",
    "--no-sync",
    "--by",
    "tool",
    "--json",
    "--tz",
    "UTC",
    "--since",
    "2026-01-01",
  ]);

  expect(result.status, result.stderr).toBe(0);

  return decodeUsage(result.stdout);
};

const storedBytes = (dir: string): string =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      readFileSync(path.join(entry.parentPath, entry.name)).toString("latin1")
    )
    .join("\n");

describe("D41 retention", () => {
  it(
    "keeps every tool's usage facts after the tool deletes its session files",
    { timeout: 120_000 },
    () => {
      makeRepo();

      const copied = copySessions();

      expect(
        copied.every((file) =>
          readFileSync(file, "utf-8").includes(PROMPT_MARKER)
        )
      ).toBe(true);

      const first = dft(["sync"]);

      expect(first.status, first.stderr).toBe(0);

      const before = usage();

      expect(before.coverage.tools).toEqual(
        expect.arrayContaining(["claude-code", "codex", "cursor", "omp", "pi"])
      );
      expect(
        before.groups
          .filter((group) => (group.values.requests ?? 0) > 0)
          .map((group) => group.key)
          .toSorted()
      ).toEqual(["claude-code", "codex", "omp", "pi"]);

      for (const file of copied) {
        rmSync(file);
      }

      const second = dft(["sync"]);

      expect(second.status, second.stderr).toBe(0);
      expect(usage()).toStrictEqual(before);
      expect(storedBytes(dftHome)).not.toContain(PROMPT_MARKER);
    }
  );
});
