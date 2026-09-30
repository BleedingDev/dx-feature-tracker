// @effect-diagnostics nodeBuiltinImport:off -- The dft composition root resolves the user home, reads the hook payload from stdin and asks git for the dirty flag at the process boundary.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { toCommand } from "@rat-stack/capability";
import {
  EventStore,
  allCollectors,
  autoSync,
  buildRegistry,
  contextForRepo,
  defaultCostOptions,
  dxStoreLayer,
  makeDxCapabilities,
  metricsWithCost,
  resolveDftHome,
  resolveDftStore,
  resolveSince,
  runCursorHook,
} from "@rat-stack/core/dx";
import type { FlightHistoryRow, SyncReport } from "@rat-stack/core/dx";
import { Console, Data, DateTime, Effect, Layer, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import { branchChats, dashboardText, writeDashboard } from "./dft-dashboard.js";
import {
  dftInvocation,
  hasDftHooks,
  installChecks,
  installCursorHooks,
  installGitHooks,
  installSkills,
  installText,
  installWorktree,
  otherWorktrees,
} from "./dft-install.js";
import { DEFAULT_DASHBOARD_PORT, runLiveDashboard } from "./dft-live.js";
import {
  analyzeText,
  branchOneline,
  chatsText,
  enterpriseLine,
  explainText,
  formatUsd,
  historyOneline,
  historyText,
  ledgerValues,
  modelShares,
  reportFacts,
  snapshotLine,
  statusText,
  syncNote,
  syncText,
  withEnterpriseLine,
} from "./dft-render.js";
import type { AnalyzeExtras } from "./dft-render.js";
import {
  capabilitiesFor,
  capabilityAt as capabilitiesOf,
  costOptionsFor,
} from "./dft-session.js";
import { mcpServer } from "./surfaces.js";
import { VERSION } from "./version.js";

export class CostLimitExceeded extends Data.TaggedError("CostLimitExceeded")<{
  readonly limit: number;
  readonly observed: number;
}> {}

const optionalString = (name: string, description: string) =>
  Flag.String(name).pipe(
    Flag.withDescription(description),
    Flag.optional,
    Flag.map(Option.getOrUndefined)
  );

const booleanFlag = (name: string, description: string) =>
  Flag.Boolean(name).pipe(
    Flag.withDefault(false),
    Flag.withDescription(description)
  );

const reportFlags = {
  allRepos: booleanFlag(
    "all-repos",
    "Include every repo dft has seen, not just this one"
  ),
  branch: optionalString(
    "branch",
    "Branch to report on, e.g. feature/x; defaults to the checked-out branch"
  ),
  db: optionalString(
    "db",
    "Database file; defaults to ~/.dft/dft.db (or $DFT_HOME/dft.db)"
  ),
  json: booleanFlag("json", "Print JSON instead of text"),
  noSync: booleanFlag(
    "no-sync",
    "Don't import new data first; use what is already stored"
  ),
  repo: optionalString(
    "repo",
    "Repository path; defaults to $DX_REPO, then the current directory"
  ),
  since: optionalString(
    "since",
    "Only count activity since then: 30m, 24h, 7d, 2w or a date like 2026-09-01"
  ),
  verbose: booleanFlag(
    "verbose",
    "Say why numbers are missing and list every source read"
  ),
};

const onelineFlags = {
  ...reportFlags,
  oneline: Flag.Boolean("oneline").pipe(
    Flag.withAlias("1"),
    Flag.withDefault(false),
    Flag.withDescription("Print one short line instead of the full report")
  ),
};

export interface ReportFlags {
  readonly allRepos: boolean;
  readonly branch: string | undefined;
  readonly db: string | undefined;
  readonly json: boolean;
  readonly noSync: boolean;
  readonly repo: string | undefined;
  readonly since: string | undefined;
  readonly verbose: boolean;
}

interface OnelineFlags extends ReportFlags {
  readonly oneline: boolean;
}

export const dftPaths = (flags: Pick<ReportFlags, "db" | "repo">) => {
  const { env } = process;
  const home = homedir();
  const store = resolveDftStore({ db: flags.db ?? null, env, home });

  return {
    dftHome: resolveDftHome(env, home),
    home,
    repo: path.resolve(flags.repo ?? env.DX_REPO ?? process.cwd()),
    store,
  };
};

const dftSession = (flags: ReportFlags) =>
  Effect.gen(function* session() {
    const paths = dftPaths(flags);
    const costOptions = yield* costOptionsFor(paths.dftHome, paths.home);
    const now = yield* DateTime.now;
    const from = yield* resolveSince(flags.since, DateTime.toEpochMillis(now));

    const capabilities = capabilitiesFor({
      costOptions,
      repo: paths.repo,
      selector: {
        allRepos: flags.allRepos,
        branch: flags.branch ?? null,
        from,
      },
      storePath: paths.store.path,
    });

    return { capabilities, costOptions, paths };
  });

type Session = Effect.Success<ReturnType<typeof dftSession>>;

const syncStep = (flags: ReportFlags, session: Session, quiet = false) =>
  Effect.gen(function* sync() {
    if (flags.noSync) {
      return null;
    }

    const store = yield* EventStore;

    const report = yield* autoSync(store, allCollectors, {
      cwd: process.cwd(),
      home: session.paths.home,
      repo: session.paths.repo,
      storePath: session.paths.store.path,
    });

    const note = quiet ? null : syncNote(report, flags.verbose);

    if (note !== null) {
      yield* Console.error(note);
    }

    return report;
  });

const stdoutColor = (): boolean =>
  process.stdout.isTTY && process.env.NO_COLOR === undefined;

const printOutput = (
  flags: Pick<ReportFlags, "json">,
  json: string,
  text?: string
): Effect.Effect<void> =>
  Console.log(flags.json || text === undefined ? json : text);

interface RenderContext {
  readonly flags: ReportFlags;
  readonly home: string;
  readonly now: number;
  readonly sync: SyncReport | null;
  readonly verbose: boolean;
}

interface ReportView<A, J> {
  readonly json?: (output: A) => J;
  readonly presync?: boolean;
  readonly render?: (output: A, context: RenderContext) => string;
}

const runReport = <F extends ReportFlags, A, E, R, J = A>(
  name: string,
  flags: F,
  run: (flags: F, session: Session) => Effect.Effect<A, E, R>,
  view: ReportView<A, J>
) =>
  Effect.gen(function* report() {
    const session = yield* dftSession(flags);

    yield* Effect.gen(function* withStore() {
      const sync =
        view.presync === false
          ? null
          : yield* syncStep(flags, session, name === "status");

      const output = yield* run(flags, session);
      const now = DateTime.toEpochMillis(yield* DateTime.now);

      yield* printOutput(
        flags,
        JSON.stringify(view.json?.(output) ?? output, null, 2),
        view.render?.(output, {
          flags,
          home: session.paths.home,
          now,
          sync,
          verbose: flags.verbose,
        })
      );
    }).pipe(Effect.provide(dxStoreLayer(session.paths.store)));
  });

const reportCommand = <A, E, R, J = A>(
  name: string,
  description: string,
  run: (flags: ReportFlags, session: Session) => Effect.Effect<A, E, R>,
  view: ReportView<A, J> = {}
) =>
  Command.make(name, reportFlags, (flags) =>
    runReport(name, flags, run, view)
  ).pipe(Command.withDescription(description));

const onelineCommand = <A, E, R, J = A>(
  name: string,
  description: string,
  run: (flags: OnelineFlags, session: Session) => Effect.Effect<A, E, R>,
  view: ReportView<A, J>
) =>
  Command.make(name, onelineFlags, (flags) =>
    runReport(name, flags, run, view)
  ).pipe(Command.withDescription(description));

const capabilityAt = (session: Session) => capabilitiesOf(session.capabilities);

const statusCommand = reportCommand(
  "status",
  "Check that dft is set up: where data is stored and which sources (git, Cursor) were found. Imports new data first.",
  (_flags, session) => capabilityAt(session).status.handler({}),
  {
    render: (output, context) =>
      statusText(output, context.sync, {
        home: context.home,
        now: context.now,
        verbose: context.verbose,
      }),
  }
).pipe(
  Command.withShortDescription("Check setup and which sources were found"),
  Command.withExamples([
    { command: "dft status", description: "Check setup for the current repo" },
    {
      command: "dft status --json --no-sync",
      description: "Machine-readable status without importing new data",
    },
  ])
);

interface OptionalInput {
  allRepos?: boolean;
  branch?: string;
  repo: string;
  since?: string;
}

const optionalInput = (
  base: OptionalInput,
  flags: Pick<ReportFlags, "branch" | "since">
): OptionalInput => {
  const input = { ...base };

  if (flags.branch !== undefined) {
    input.branch = flags.branch;
  }

  if (flags.since !== undefined) {
    input.since = flags.since;
  }

  return input;
};

const historyInput = (flags: ReportFlags, session: Session) =>
  optionalInput(
    { allRepos: flags.allRepos, repo: session.paths.repo },
    { branch: undefined, since: flags.since }
  );

const currentRow = (
  rows: readonly FlightHistoryRow[],
  branch: string | null
): FlightHistoryRow | null => rows.find((row) => row.branch === branch) ?? null;

const wantedBranch = (flags: ReportFlags, session: Session): string | null =>
  flags.branch ?? contextForRepo(session.paths.repo).branch ?? null;

const wantedRow = (flags: ReportFlags, session: Session) =>
  capabilityAt(session)
    .history.handler(historyInput(flags, session))
    .pipe(
      Effect.option,
      Effect.map((history) =>
        Option.isSome(history)
          ? currentRow(history.value.rows, wantedBranch(flags, session))
          : null
      )
    );

const analyzeExtras = (flags: ReportFlags, session: Session) =>
  Effect.gen(function* extras() {
    const chats = yield* capabilityAt(session)
      .chats.handler(optionalInput({ repo: session.paths.repo }, flags))
      .pipe(Effect.option);

    const row = yield* wantedRow(flags, session);

    return {
      models: Option.isSome(chats) ? modelShares(chats.value.chats) : [],
      status: row === null ? null : row.status.value,
    } satisfies AnalyzeExtras;
  });

const analyzeLine = (
  flags: OnelineFlags,
  session: Session,
  report: AnalyzeOutput["report"]
) =>
  Effect.gen(function* line() {
    if (flags.allRepos) {
      return branchOneline("all branches", null, reportFacts(report));
    }

    const row = yield* wantedRow(flags, session);

    return branchOneline(
      wantedBranch(flags, session) ?? "(detached)",
      row,
      reportFacts(report)
    );
  });

const analyzeHandler = (flags: OnelineFlags, session: Session) =>
  Effect.gen(function* analyze() {
    const report = yield* capabilityAt(session).analyze.handler(
      flags.allRepos ? {} : { repo: session.paths.repo }
    );

    if (flags.json) {
      return { extras: null, line: null, report };
    }

    if (flags.oneline) {
      return {
        extras: null,
        line: yield* analyzeLine(flags, session, report),
        report,
      };
    }

    const extras = flags.allRepos ? null : yield* analyzeExtras(flags, session);

    return { extras, line: null, report };
  });

interface AnalyzeOutput {
  readonly extras: AnalyzeExtras | null;
  readonly line: string | null;
  readonly report: Effect.Success<
    ReturnType<ReturnType<typeof capabilityAt>["analyze"]["handler"]>
  >;
}

const analyzeView: ReportView<AnalyzeOutput, AnalyzeOutput["report"]> = {
  json: (output) => output.report,
  render: (output, context) =>
    output.line ??
    analyzeText(output.report, output.extras, {
      now: context.now,
      verbose: context.verbose,
    }),
};

const analyzeExamples = [
  {
    command: "dft analyze",
    description: "Cost, tokens and time for the checked-out branch",
  },
  {
    command: "dft analyze --branch feature/x --json",
    description: "Another branch, as JSON",
  },
  {
    command: "dft analyze --since 7d --no-sync",
    description: "Last 7 days only, without importing new data first",
  },
  {
    command: "dft analyze --oneline",
    description: "Just one line: cost, tokens, agent time, chats, commits",
  },
];

const analyzeCommand = onelineCommand(
  "analyze",
  "AI cost of one branch: what Cursor billed, Cursor's own figure and a list-price estimate (shown apart, never added), plus tokens, time and commits. Add --oneline (-1) for a single line. Imports new data first unless --no-sync.",
  analyzeHandler,
  analyzeView
).pipe(
  Command.withShortDescription("Cost, tokens and time for a branch"),
  Command.withExamples(analyzeExamples)
);

const analyseCommand = onelineCommand(
  "analyse",
  "Same as analyze",
  analyzeHandler,
  analyzeView
).pipe(Command.withExamples(analyzeExamples));

const explainCommand = reportCommand(
  "explain",
  "Show what happened on a branch, by time: chats, tool calls, commits. Use it to see where a cost came from. Shows up to 200 events.",
  (_flags, session) => capabilityAt(session).explain.handler({ limit: 200 }),
  {
    render: (output, context) =>
      explainText(
        output,
        context.flags.branch ?? context.sync?.context.branch ?? null
      ),
  }
).pipe(
  Command.withShortDescription("What happened on a branch, by time"),
  Command.withExamples([
    {
      command: "dft explain",
      description: "Explain the checked-out branch",
    },
    {
      command: "dft explain --branch feature/x --since 24h",
      description: "Another branch, last 24 hours",
    },
  ])
);

const historyCommand = onelineCommand(
  "history",
  "One row per branch: status, agent time, tokens, billed cost and estimate. Add --oneline (-1) for one short line per branch. This repo only unless --all-repos. --branch is ignored here.",
  (flags, session) =>
    capabilityAt(session)
      .history.handler(historyInput(flags, session))
      .pipe(Effect.map((history) => ({ history, oneline: flags.oneline }))),
  {
    json: (output) => output.history,
    render: (output, context) =>
      output.oneline
        ? historyOneline(output.history.rows, {
            allRepos: output.history.allRepos,
          })
        : withEnterpriseLine(
            historyText(output.history.rows, {
              allRepos: output.history.allRepos,
              now: context.now,
              verbose: context.verbose,
            }),
            stdoutColor()
          ),
  }
).pipe(
  Command.withShortDescription("Cost of every branch, one row each"),
  Command.withExamples([
    { command: "dft history", description: "All branches in this repo" },
    {
      command: "dft history --since 30d --all-repos",
      description: "Every repo, last 30 days",
    },
    {
      command: "dft history --oneline",
      description: "One short line per branch",
    },
    {
      command: "dft history --json",
      description: "Rows as JSON for scripts",
    },
  ])
);

const dashboardFlags = {
  allRepos: booleanFlag(
    "all-repos",
    "Show every repo dft has seen, not just the tracked ones (with --one-time: not just this one)"
  ),
  db: reportFlags.db,
  json: booleanFlag(
    "json",
    "With --one-time: print where the file was saved as JSON"
  ),
  noOpen: booleanFlag("no-open", "Don't open the page in the browser"),
  noSync: booleanFlag(
    "no-sync",
    "With --one-time: don't import new data first; use what is already stored"
  ),
  oneTime: booleanFlag(
    "one-time",
    "Save a static page once and exit instead of running the live dashboard"
  ),
  out: optionalString(
    "out",
    "With --one-time: where to save the page; defaults to ~/.dft/dashboard.html (or $DFT_HOME/dashboard.html)"
  ),
  port: Flag.Int("port").pipe(
    Flag.withDefault(DEFAULT_DASHBOARD_PORT),
    Flag.withDescription(
      `Port for the live dashboard on 127.0.0.1 (default ${String(DEFAULT_DASHBOARD_PORT)})`
    )
  ),
  repo: reportFlags.repo,
  since: optionalString(
    "since",
    "Time range to start with: 7d or 30d (with --one-time, any range like 24h or 2026-09-01)"
  ),
  verbose: reportFlags.verbose,
};

interface DashboardCommandFlags {
  readonly allRepos: boolean;
  readonly db: string | undefined;
  readonly json: boolean;
  readonly noOpen: boolean;
  readonly noSync: boolean;
  readonly oneTime: boolean;
  readonly out: string | undefined;
  readonly port: number;
  readonly repo: string | undefined;
  readonly since: string | undefined;
  readonly verbose: boolean;
}

const oneTimeDashboard = (flags: DashboardCommandFlags) =>
  runReport(
    "dashboard",
    { ...flags, branch: undefined },
    (input, session) =>
      writeDashboard(
        {
          dftHome: session.paths.dftHome,
          open: !input.noOpen,
          outPath: input.out,
          repo: session.paths.repo,
          scope: input.allRepos ? "all" : "repo",
          since: input.since,
        },
        { chats: branchChats, history: capabilityAt(session).history.handler }
      ),
    { render: (output) => dashboardText(output) }
  );

const liveDashboard = (flags: DashboardCommandFlags) =>
  Effect.gen(function* live() {
    const paths = dftPaths(flags);
    const costOptions = yield* costOptionsFor(paths.dftHome, paths.home);

    return yield* runLiveDashboard({
      allRepos: flags.allRepos,
      costOptions,
      open: !flags.noOpen,
      paths,
      port: flags.port,
      since: flags.since,
    });
  });

const dashboardCommand = Command.make("dashboard", dashboardFlags, (flags) =>
  Effect.gen(function* dashboard() {
    if (flags.oneTime) {
      return yield* oneTimeDashboard(flags);
    }

    return yield* liveDashboard(flags);
  })
).pipe(
  Command.withDescription(
    "Run a live dashboard on http://127.0.0.1:7420 that keeps syncing and updates as you work. It tracks this repo, opens your browser and runs until Ctrl+C. It only listens on this computer and loads nothing from the internet. Add --one-time to save a static page once and exit."
  ),
  Command.withShortDescription("Live cost dashboard in your browser"),
  Command.withExamples([
    {
      command: "dft dashboard",
      description:
        "Live dashboard for the tracked repos, opened in the browser",
    },
    {
      command: "dft dashboard --port 8080 --no-open",
      description: "Another port, without opening the browser",
    },
    {
      command: "dft dashboard --one-time --all-repos --since 30d",
      description: "Save a static page for every repo, last 30 days",
    },
    {
      command: "dft dashboard --one-time --out costs.html --no-open",
      description: "Save to a file of your choice without opening it",
    },
  ])
);

const lineCommand = reportCommand(
  "line",
  "Print one line for the checked-out branch: billed cost, estimate, tokens, agent time, chats and commits. Same as dft analyze --oneline.",
  (flags, session) => analyzeHandler({ ...flags, oneline: true }, session),
  analyzeView
).pipe(
  Command.withShortDescription("One line: cost of the current branch"),
  Command.withExamples([
    { command: "dft line", description: "One line for the checked-out branch" },
    {
      command: "dft line --branch feature/x --since 7d",
      description: "Another branch, last 7 days",
    },
  ])
);

const chatsCommand = reportCommand(
  "chats",
  "Show the chats on a branch as a tree, with cost, tokens and the models used.",
  (flags, session) =>
    capabilityAt(session).chats.handler(
      optionalInput({ repo: session.paths.repo }, flags)
    ),
  {
    render: (output, context) =>
      chatsText(output, { now: context.now, verbose: context.verbose }),
  }
).pipe(
  Command.withShortDescription("Chats on a branch, with cost and models used"),
  Command.withExamples([
    { command: "dft chats", description: "Chats on the checked-out branch" },
    {
      command: "dft chats --branch feature/x --since 7d",
      description: "Another branch, last 7 days",
    },
  ])
);

const syncCommand = reportCommand(
  "sync",
  "Import new data for this repo from Cursor hooks, git and Cursor chats. Safe to run again. Other commands do this first, so you rarely need it.",
  (flags, session) =>
    Effect.gen(function* sync() {
      const store = yield* EventStore;

      return yield* autoSync(store, allCollectors, {
        cwd: process.cwd(),
        home: session.paths.home,
        repo: session.paths.repo,
        storePath: session.paths.store.path,
      });
    }),
  {
    presync: false,
    render: (output, context) => syncText(output, context.verbose),
  }
).pipe(
  Command.withShortDescription(
    "Import new data now; other commands do this for you"
  ),
  Command.withExamples([
    { command: "dft sync", description: "Import new data for this repo" },
    {
      command: "dft sync --repo ~/code/app --db /tmp/dft.db",
      description: "Another repo into a separate store",
    },
  ])
);

const gitDirty = (worktree: string): boolean | null => {
  try {
    return (
      execFileSync("git", ["status", "--porcelain"], {
        cwd: worktree,
        encoding: "utf-8",
      }).trim() !== ""
    );
  } catch {
    return null;
  }
};

const persistSnapshot = (flags: ReportFlags) =>
  Effect.gen(function* snapshot() {
    const session = yield* dftSession(flags);
    const context = contextForRepo(session.paths.repo);
    const worktree = context.worktreePath ?? session.paths.repo;

    const result = yield* Effect.gen(function* withStore() {
      yield* syncStep(flags, session);

      const caps = capabilityAt(session);

      const analyzed = yield* caps.analyze.handler({
        repo: session.paths.repo,
      });

      const history = yield* caps.history.handler({
        allRepos: false,
        repo: session.paths.repo,
      });

      return { analyzed, row: currentRow(history.rows, context.branch) };
    }).pipe(Effect.provide(dxStoreLayer(session.paths.store)));

    const record = {
      at: DateTime.formatIso(yield* DateTime.now),
      branch: context.branch,
      dirty: gitDirty(worktree),
      headSha: context.headSha,
      repoCommonDir: context.repoCommonDir,
      row: result.row,
      snapshotId: result.analyzed.snapshot.snapshotId,
      worktree,
    };

    const snapshotsFile = path.join(
      path.dirname(session.paths.store.path),
      "snapshots.jsonl"
    );

    yield* Effect.sync(() => {
      mkdirSync(path.dirname(snapshotsFile), { recursive: true });
      appendFileSync(snapshotsFile, `${JSON.stringify(record)}\n`);
    });

    yield* printOutput(
      flags,
      JSON.stringify(record, null, 2),
      snapshotLine(context.branch, result.row)
    );

    return result.row;
  });

export const ledgerOverLimit = (
  row: FlightHistoryRow | null,
  limit: number | undefined
): number | undefined =>
  row === null || limit === undefined
    ? undefined
    : ledgerValues(row).find((value) => value > limit);

const enforceMaxCost = (
  row: FlightHistoryRow | null,
  limit: number | undefined
): Effect.Effect<void, CostLimitExceeded> => {
  const over = ledgerOverLimit(row, limit);

  return over === undefined || limit === undefined
    ? Effect.void
    : Console.error(
        `dft: ${formatUsd(over)} is over --max-cost ${formatUsd(limit)} (each cost figure is checked on its own)`
      ).pipe(
        Effect.andThen(
          Effect.fail(new CostLimitExceeded({ limit, observed: over }))
        )
      );
};

const snapshotCommand = Command.make(
  "snapshot",
  {
    ...reportFlags,
    maxCost: Flag.Finite("max-cost").pipe(
      Flag.withDescription(
        "Exit 1 when any one cost figure (billed, Cursor's, estimate) is over this many dollars"
      ),
      Flag.optional,
      Flag.map(Option.getOrUndefined)
    ),
  },
  (flags) =>
    persistSnapshot(flags).pipe(
      // oxlint-disable-next-line promise/prefer-await-to-callbacks, promise/prefer-await-to-then -- Oxlint mistakes this Effect handler for a Promise callback.
      Effect.catch((error) =>
        Console.error(
          `dft: snapshot not saved (${error.message}); commit continues`
        ).pipe(Effect.as(null))
      ),
      Effect.flatMap((row) => enforceMaxCost(row, flags.maxCost))
    )
).pipe(
  Command.withDescription(
    "Record the branch's cost at the current commit and print it on one line. Made for git hooks: it never blocks a commit, except with --max-cost when the cost is over the limit. Saved to snapshots.jsonl next to the database."
  ),
  Command.withShortDescription(
    "Record cost at this commit (used by git hooks)"
  ),
  Command.withExamples([
    { command: "dft snapshot", description: "Record and print the cost now" },
    {
      command: "dft snapshot --max-cost 5",
      description: "Exit 1 if any cost figure is over $5",
    },
  ])
);

const installCommand = Command.make(
  "install",
  {
    allWorktrees: booleanFlag(
      "all-worktrees",
      "Also set up every other git worktree of this repo (needed for worktrees you open in Cursor on their own)"
    ),
    gitHooks: booleanFlag(
      "git-hooks",
      "Also record cost on every commit and push (adds to your git hooks, keeps what is there)"
    ),
    json: reportFlags.json,
    repo: reportFlags.repo,
  },
  (flags) =>
    Effect.gen(function* install() {
      const paths = dftPaths({ db: undefined, repo: flags.repo });
      const context = contextForRepo(paths.repo);
      const worktree = context.worktreePath ?? paths.repo;
      const command = dftInvocation(process.execPath, process.argv[1] ?? "dft");

      const result = yield* Effect.sync(() => {
        const hooks = installCursorHooks(worktree, `${command} hook`);
        const skills = installSkills(worktree);
        const git = flags.gitHooks ? installGitHooks(worktree, command) : null;
        const others = otherWorktrees(worktree);

        return flags.allWorktrees
          ? {
              git,
              hooks,
              others: others.map((other) =>
                installWorktree(other, `${command} hook`)
              ),
              skills,
              worktree,
            }
          : {
              git,
              hooks,
              others: null,
              skills,
              waiting: others.filter((other) => !hasDftHooks(other)),
              worktree,
            };
      });

      const steps = [result.hooks, ...result.skills, ...(result.git ?? [])];

      if (flags.json) {
        const worktrees =
          result.others === null
            ? {}
            : {
                worktrees: result.others.map((other) => ({
                  steps: [other.hooks, ...other.skills],
                  worktree: other.worktree,
                })),
              };

        yield* Console.log(
          JSON.stringify({ command, steps, worktree, ...worktrees }, null, 2)
        );

        return;
      }

      const checks = yield* Effect.sync(() =>
        installChecks(worktree, homedir(), process.platform, process.version)
      );

      yield* Console.log(installText(result, checks, homedir(), stdoutColor()));
    })
).pipe(
  Command.withDescription(
    "Set up dft in this repo: add Cursor hooks to .cursor/hooks.json and the Cursor skills (/dx-line, /dx-analyze, /dx-history, /dx-chats, /dx-explain, /dx-dashboard). Agents and subagents started from this folder are covered, even when they work in other worktrees. Add --all-worktrees to also set up every other worktree of the repo, for worktrees you open in Cursor on their own. Changes only this repo, never ~/.cursor. Safe to run again."
  ),
  Command.withShortDescription("Set up Cursor hooks and skills in this repo"),
  Command.withExamples([
    { command: "dft install", description: "Set up Cursor hooks and skills" },
    {
      command: "dft install --git-hooks",
      description: "Also record cost on every commit and push",
    },
    {
      command: "dft install --all-worktrees",
      description: "Also set up every other worktree of this repo",
    },
  ])
);

const readStdin = (): string => {
  try {
    return readFileSync(0, "utf-8");
  } catch {
    return "";
  }
};

const hookCommand = Command.make("hook", {}, () =>
  DateTime.now.pipe(
    Effect.map((now) =>
      runCursorHook(readStdin(), process.cwd(), DateTime.toDate(now))
    ),
    Effect.flatMap((result) => Console.log(result.stdout))
  )
).pipe(
  Command.withDescription(
    "Internal: called by Cursor hooks written by dft install. Reads one hook JSON payload on stdin, stores sanitized metadata and prints the hook response."
  ),
  Command.withShortDescription("Internal: Cursor hook entrypoint")
);

const staticSession = () => {
  const paths = dftPaths({ db: undefined, repo: undefined });
  const costOptions = defaultCostOptions();

  return {
    capabilities: makeDxCapabilities({
      collectors: allCollectors,
      costOptions,
      defaultRepo: paths.repo,
      registry: buildRegistry(allCollectors, metricsWithCost(costOptions)),
      storePath: paths.store.path,
    }),
    store: paths.store,
  };
};

const fixed = staticSession();

const fixedCaps = {
  collect: fixed.capabilities[4],
  evidence: fixed.capabilities[3],
  mark: fixed.capabilities[5],
};

const collectCommand = toCommand(fixedCaps.collect, { name: "collect" }).pipe(
  Command.provide(dxStoreLayer(fixed.store)),
  Command.withShortDescription(
    "Advanced: import one source by hand; most people want dft sync"
  )
);

const markCommand = toCommand(fixedCaps.mark, { name: "mark" }).pipe(
  Command.provide(dxStoreLayer(fixed.store)),
  Command.withDescription(
    "Advanced, optional: add a start, stop or wait mark by hand. Not needed: branch and time are detected on their own."
  ),
  Command.withShortDescription(
    "Advanced: add a start/stop mark by hand (not needed)"
  )
);

const evidenceCommand = toCommand(fixedCaps.evidence, {
  name: "evidence",
}).pipe(
  Command.provide(dxStoreLayer(fixed.store)),
  Command.withShortDescription("Advanced: look up the raw stored records")
);

const mcpCommand = Command.make("mcp", {}, () =>
  Layer.launch(mcpServer.tools).pipe(Effect.orDie)
).pipe(
  Command.withDescription(
    "Run dft as an MCP server over stdio so agents can call the same reports as tools."
  ),
  Command.withShortDescription("Serve dft reports as an MCP server (stdio)")
);

export const dftCommand = Command.make("dft").pipe(
  Command.withDescription(
    [
      "See what AI coding costs per branch: billed cost, tokens and time, from Cursor and git on this machine.",
      "",
      "  Quick start:",
      "    dft install                  set up this repo (safe to run again)",
      "    dft analyze                  cost of the current branch",
      "    dft line                     the same, on one line",
      "    dft history --all-repos      every branch in every repo, one row each",
      "    dft history --oneline        every branch in this repo, one line each",
      "    dft dashboard                every branch as a web page, opens in your browser",
      "    dft <command> --help         flags and examples",
    ].join("\n")
  ),
  Command.withSubcommands([
    installCommand,
    statusCommand,
    analyzeCommand,
    analyseCommand,
    lineCommand,
    explainCommand,
    historyCommand,
    dashboardCommand,
    chatsCommand,
    markCommand,
    collectCommand,
    syncCommand,
    evidenceCommand,
    hookCommand,
    snapshotCommand,
    mcpCommand,
  ])
);

const runCommand = Command.runWith(dftCommand, { version: VERSION });

export const isTopLevelHelp = (args: readonly string[]): boolean =>
  args.length === 0 ||
  (args.length === 1 && (args[0] === "--help" || args[0] === "-h"));

export const runDft = (args: readonly string[]) =>
  isTopLevelHelp(args)
    ? runCommand(args).pipe(
        Effect.ensuring(Console.log(`\n${enterpriseLine(stdoutColor())}`))
      )
    : runCommand(args);
