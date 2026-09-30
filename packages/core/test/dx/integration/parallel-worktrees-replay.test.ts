// @effect-diagnostics nodeBuiltinImport:off -- This test owns a temporary git repo with linked worktrees, a DFT_HOME and a SQLite store, and replays sanitized Cursor captures into them.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  EventStore,
  allCollectors,
  allMetrics,
  autoSync,
  contextForRepo,
  gitSelectorResolver,
  hookSpoolDirFor,
  makeDxChatsCapability,
  makeDxHistoryCapability,
  openSqliteEventStore,
  runAnalyze,
  runCollect,
  selectorForContext,
} from "../../../src/dx/index.js";
import type {
  DxCommandEnv,
  EventStoreService,
  FlightHistoryRow,
} from "../../../src/dx/index.js";

const FIXTURES = path.join(
  import.meta.dirname,
  "fixtures",
  "parallel-worktrees"
);

const CAPTURE_ROOT = "/replay/parallel-worktrees";

const GIT_EPOCH = "2026-09-30T11:30:00Z";

const COMMIT_TIMES = [
  "2026-09-30T12:40:00Z",
  "2026-09-30T12:40:01Z",
  "2026-09-30T12:40:02Z",
];

interface Run {
  readonly branch: string;
  readonly name: "main" | "sub-a" | "sub-b" | "sub-c";
}

const PARENT: Run = { branch: "main", name: "main" };

const RUNS: readonly Run[] = [
  PARENT,
  { branch: "feature/sub-a", name: "sub-a" },
  { branch: "feature/sub-b", name: "sub-b" },
  { branch: "feature/sub-c", name: "sub-c" },
];

const BRANCHES = RUNS.map((run) => run.branch).toSorted((a, b) =>
  a.localeCompare(b)
);

const UsageSchema = Schema.Struct({
  cacheReadTokens: Schema.Finite,
  cacheWriteTokens: Schema.Finite,
  inputTokens: Schema.Finite,
  outputTokens: Schema.Finite,
});

const StreamLineSchema = Schema.Struct({
  request_id: Schema.optionalKey(Schema.String),
  session_id: Schema.optionalKey(Schema.String),
  type: Schema.String,
  usage: Schema.optionalKey(UsageSchema),
});

const decodeStreamLine = Schema.decodeUnknownSync(
  Schema.fromJsonString(StreamLineSchema)
);

const SpoolHookSchema = Schema.Struct({
  hook: Schema.Struct({
    filePath: Schema.NullOr(Schema.String),
    hookEvent: Schema.String,
    subagentId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
});

const decodeSpoolHook = Schema.decodeUnknownSync(
  Schema.fromJsonString(SpoolHookSchema)
);

interface StreamResult {
  readonly requestId: string | null;
  readonly sessionId: string | null;
  readonly usage: typeof UsageSchema.Type | null;
}

const byText = (a: string, b: string) => a.localeCompare(b);

const streamText = (run: Run) =>
  fs.readFileSync(
    path.join(FIXTURES, "streams", `${run.name}.stream.jsonl`),
    "utf-8"
  );

const resultOf = (run: Run): StreamResult => {
  const line = streamText(run)
    .trim()
    .split("\n")
    .map((raw) => decodeStreamLine(raw))
    .find((parsed) => parsed.type === "result");

  return {
    requestId: line?.request_id ?? null,
    sessionId: line?.session_id ?? null,
    usage: line?.usage ?? null,
  };
};

const spoolFixtures = (run: Run) =>
  fs
    .readdirSync(path.join(FIXTURES, "spool", run.name))
    .toSorted(byText)
    .map((name) => ({
      name,
      text: fs.readFileSync(
        path.join(FIXTURES, "spool", run.name, name),
        "utf-8"
      ),
    }));

const parent = resultOf(PARENT);

const parentHooks = spoolFixtures(PARENT).map(({ text }) =>
  decodeSpoolHook(text)
);

const subagentIds = [
  ...new Set(
    parentHooks.flatMap(({ hook }) =>
      hook.subagentId === undefined || hook.subagentId === null
        ? []
        : [hook.subagentId]
    )
  ),
].toSorted(byText);

const foreignEditPaths = parentHooks.flatMap(({ hook }) =>
  hook.hookEvent === "afterFileEdit" &&
  hook.filePath !== null &&
  !hook.filePath.startsWith(`${CAPTURE_ROOT}/main/`)
    ? [hook.filePath]
    : []
);

const scratch = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "dft-parallel-replay-"))
);

const root = path.join(scratch, "pw");

const dftHome = path.join(scratch, "dft-home");

const storePath = path.join(scratch, "store", "dft.db");

const worktreeOf = (run: Run) => path.join(root, run.name);

const mainWorktree = path.join(root, "main");

const git = (cwd: string, at: string, ...args: readonly string[]) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: at,
      GIT_COMMITTER_DATE: at,
    },
  }).trim();

const buildRepo = () => {
  fs.mkdirSync(mainWorktree, { recursive: true });
  git(mainWorktree, GIT_EPOCH, "init", "-q", "-b", "main");
  git(
    mainWorktree,
    GIT_EPOCH,
    "config",
    "user.email",
    "replay@example.invalid"
  );
  git(mainWorktree, GIT_EPOCH, "config", "user.name", "replay");
  git(mainWorktree, GIT_EPOCH, "config", "commit.gpgsign", "false");

  for (const file of ["math.js", "math.test.js", "parse.js", "format.js"]) {
    fs.writeFileSync(path.join(mainWorktree, file), "export {};\n");
  }

  git(mainWorktree, GIT_EPOCH, "add", ".");
  git(mainWorktree, GIT_EPOCH, "commit", "-q", "--no-verify", "-m", "init");

  for (const run of RUNS.slice(1)) {
    git(
      mainWorktree,
      GIT_EPOCH,
      "worktree",
      "add",
      "-q",
      "-b",
      run.branch,
      worktreeOf(run)
    );
  }
};

const heads = () =>
  new Map(
    RUNS.map((run) => [
      run.name,
      git(worktreeOf(run), GIT_EPOCH, "rev-parse", "HEAD"),
    ])
  );

const localize = (text: string, head: ReadonlyMap<string, string>) => {
  let out = text.replaceAll(CAPTURE_ROOT, root);

  for (const run of RUNS) {
    out = out.replaceAll(`@head:${run.name}@`, head.get(run.name) ?? "");
  }

  return out;
};

const replaySpools = () => {
  const head = heads();

  for (const run of RUNS) {
    const dir = hookSpoolDirFor(worktreeOf(run), dftHome);
    fs.mkdirSync(dir, { recursive: true });

    for (const { name, text } of spoolFixtures(run)) {
      fs.writeFileSync(path.join(dir, name), localize(text, head));
    }
  }
};

const streamPathOf = (run: Run) =>
  path.join(scratch, "streams", `${run.name}.stream.jsonl`);

const replayStreams = () => {
  fs.mkdirSync(path.join(scratch, "streams"), { recursive: true });

  for (const run of RUNS) {
    fs.writeFileSync(
      streamPathOf(run),
      streamText(run).replaceAll(CAPTURE_ROOT, root)
    );
  }
};

const commitRunWork = () => {
  for (const [index, run] of RUNS.slice(1).entries()) {
    const at = COMMIT_TIMES[index] ?? GIT_EPOCH;
    fs.appendFileSync(
      path.join(worktreeOf(run), "math.js"),
      `export const ${run.name.replace("-", "_")} = 1;\n`
    );
    git(worktreeOf(run), at, "commit", "-q", "--no-verify", "-am", run.name);
  }
};

beforeAll(() => {
  buildRepo();
  replaySpools();
  replayStreams();
  commitRunWork();
});

afterAll(() => {
  fs.rmSync(scratch, { force: true, recursive: true });
});

const syncOptions = {
  cwd: mainWorktree,
  dftHome,
  home: path.join(scratch, "home"),
  repo: mainWorktree,
  storePath,
};

const syncEverything = (store: EventStoreService) =>
  Effect.gen(function* syncAll() {
    const env: DxCommandEnv = { store, storePath };
    const report = yield* autoSync(store, allCollectors, syncOptions);

    // oxlint-disable-next-line unicorn/no-array-method-this-argument -- Effect.forEach takes an options object, not a thisArg.
    const streams = yield* Effect.forEach(RUNS, (run) =>
      runCollect(env, allCollectors, {
        context: contextForRepo(worktreeOf(run)),
        input: streamPathOf(run),
        source: "collector/cursor-cli",
      })
    );

    return { report, streams };
  });

const openStore = Effect.gen(function* openReplayStore() {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });

  return yield* openSqliteEventStore({ kind: "live", path: storePath });
});

const tokenOf = (row: FlightHistoryRow | undefined, category: string) =>
  row?.tokens.find((t) => t.category === category)?.measure.value ?? null;

const expectedTokens = (result: StreamResult) => ({
  "cached-input": result.usage?.cacheReadTokens ?? null,
  input: result.usage?.inputTokens ?? null,
  output: result.usage?.outputTokens ?? null,
});

const historyOf = (store: EventStoreService) =>
  makeDxHistoryCapability({ defaultRepo: mainWorktree })
    .handler({ repo: mainWorktree })
    .pipe(Effect.provideService(EventStore, store));

const chatsOf = (store: EventStoreService, branch: string) =>
  makeDxChatsCapability({ resolveSelector: gitSelectorResolver(mainWorktree) })
    .handler({ branch, repo: mainWorktree })
    .pipe(Effect.provideService(EventStore, store));

const withStore = <A, E>(
  body: (
    store: EventStoreService
  ) => Effect.Effect<A, E, NodeServices.NodeServices>
) =>
  Effect.acquireUseRelease(
    openStore,
    (opened) => body(opened.service),
    (opened) => Effect.sync(opened.close)
  ).pipe(Effect.provide(NodeServices.layer));

describe("parallel worktrees replay from captured Cursor data", () => {
  it.effect(
    "sync reads every worktree spool and stream once and a resync adds nothing",
    () =>
      withStore((store) =>
        Effect.gen(function* syncOnce() {
          const first = yield* syncEverything(store);

          const spools = first.report.steps.filter(
            (step) => step.source === "collector.cursor-hooks"
          );

          expect(
            spools.map((step) => step.input ?? "").toSorted(byText)
          ).toEqual(
            RUNS.map((run) =>
              hookSpoolDirFor(worktreeOf(run), dftHome)
            ).toSorted(byText)
          );
          expect(spools.every((step) => (step.inserted ?? 0) > 0)).toBe(true);
          expect(first.streams.map((s) => s.inserted)).toEqual([1, 1, 1, 1]);

          const again = yield* syncEverything(store);

          expect(
            again.report.steps
              .filter((step) => step.status === "synced")
              .map((step) => step.inserted ?? 0)
              .reduce((a, b) => a + b, 0)
          ).toBe(0);
          expect(again.streams.map((s) => s.inserted)).toEqual([0, 0, 0, 0]);

          const snapshot = yield* store.snapshot({
            branch: null,
            flightId: null,
            from: null,
            repoCommonDir: path.join(mainWorktree, ".git"),
            to: null,
          });

          const usage = snapshot.events.filter(
            (e) => e.adapterId === "cursor-cli" && e.kind === "ai.usage"
          );

          expect(usage).toHaveLength(RUNS.length);
          expect(new Set(usage.map((e) => e.identity.requestId)).size).toBe(
            RUNS.length
          );
          expect(
            usage
              .map(
                (e) =>
                  `${e.identity.requestId ?? "-"} ${e.context.branch ?? "-"}`
              )
              .toSorted(byText)
          ).toEqual(
            RUNS.map(
              (run) => `${resultOf(run).requestId ?? "?"} ${run.branch}`
            ).toSorted(byText)
          );
        })
      ),
    60_000
  );

  it.effect(
    "history lists all four branches with each run's result.usage exactly and every request once",
    () =>
      withStore((store) =>
        Effect.gen(function* historyExact() {
          yield* syncEverything(store);

          const history = yield* historyOf(store);

          const rows = history.rows.filter(
            (row) => row.repoCommonDir === path.join(mainWorktree, ".git")
          );

          expect(rows.map((row) => row.branch ?? "").toSorted(byText)).toEqual(
            BRANCHES
          );

          for (const run of RUNS) {
            const row = rows.find((r) => r.branch === run.branch);
            const expected = expectedTokens(resultOf(run));

            expect({
              "cached-input": tokenOf(row, "cached-input"),
              input: tokenOf(row, "input"),
              output: tokenOf(row, "output"),
            }).toEqual(expected);
            expect(row?.worktrees).toContain(worktreeOf(run));
          }

          expect(
            rows
              .map((row) => row.requests.value ?? 0)
              .reduce((a, b) => a + b, 0)
          ).toBe(RUNS.length);
        })
      ),
    60_000
  );

  it.effect(
    "analyze per branch reports exactly its own run's tokens and one request",
    () =>
      withStore((store) =>
        Effect.gen(function* analyzeEach() {
          yield* syncEverything(store);

          for (const run of RUNS) {
            const selector = selectorForContext(
              contextForRepo(worktreeOf(run))
            );

            expect(selector.branch).toBe(run.branch);

            const analyzed = yield* runAnalyze(
              { store, storePath },
              allMetrics,
              {
                asOf: null,
                selector,
                snapshotId: null,
              }
            );

            const value = (id: string) =>
              analyzed.report.metrics.find((m) => m.metricId === id)?.value ??
              null;

            const expected = expectedTokens(resultOf(run));

            expect({
              "cached-input": value("dx.ai-usage.tokens.cached-input"),
              input: value("dx.ai-usage.tokens.input"),
              output: value("dx.ai-usage.tokens.output"),
              requests: value("dx.ai-usage.requests"),
            }).toEqual({ ...expected, requests: 1 });
          }
        })
      ),
    60_000
  );

  it.effect(
    "chats show the parent conversation with its subagents linked",
    () =>
      withStore((store) =>
        Effect.gen(function* parentTree() {
          yield* syncEverything(store);

          const report = yield* chatsOf(store, "main");

          const node = report.chats.find(
            (c) => c.sessionId === parent.sessionId
          );

          expect(subagentIds).toHaveLength(2);
          expect(report.rootSessionIds).toContain(parent.sessionId);
          expect(node?.childSessionIds).toEqual(subagentIds);

          for (const id of subagentIds) {
            const child = report.chats.find((c) => c.sessionId === id);

            expect(child?.parentSessionId).toBe(parent.sessionId);
            expect(child?.isSubagent).toBe(true);
            expect(report.rootSessionIds).not.toContain(id);
          }

          const tokens = Object.fromEntries(
            (node?.tokens ?? []).map((line) => [line.category, line.value])
          );

          expect({
            "cached-input": tokens["cached-input"],
            input: tokens.input,
            output: tokens.output,
          }).toEqual(expectedTokens(parent));

          for (const run of RUNS.slice(1)) {
            const own = yield* chatsOf(store, run.branch);

            expect(own.rootSessionIds).toContain(resultOf(run).sessionId);
          }
        })
      ),
    60_000
  );

  it.effect(
    "the parent's edits in other worktrees count on those branches without moving its tokens",
    () =>
      withStore((store) =>
        Effect.gen(function* foreignEdits() {
          yield* syncEverything(store);

          expect(foreignEditPaths.length).toBeGreaterThan(0);

          const report = yield* chatsOf(store, "main");

          const node = report.chats.find(
            (c) => c.sessionId === parent.sessionId
          );

          expect(node?.branches.toSorted(byText)).toEqual([
            "feature/sub-b",
            "feature/sub-c",
            "main",
          ]);

          for (const branch of ["feature/sub-b", "feature/sub-c"]) {
            const chats = yield* chatsOf(store, branch);

            expect(chats.chats.map((c) => c.sessionId)).toContain(
              parent.sessionId
            );
            expect(chats.rootSessionIds).toContain(parent.sessionId);
          }

          const history = yield* historyOf(store);

          const chatsOn = (branch: string) =>
            history.rows.find((row) => row.branch === branch)?.chats.value;

          expect(
            ["feature/sub-a", "feature/sub-b", "feature/sub-c", "main"].map(
              chatsOn
            )
          ).toEqual([1, 2, 2, 1]);
        })
      ),
    60_000
  );
});
