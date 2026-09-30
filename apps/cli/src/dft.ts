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
  defaultPriceProvider,
  dxStoreLayer,
  formatSyncLine,
  loadUserPriceTable,
  makeDxCapabilities,
  metricsWithCost,
  resolveDftHome,
  resolveDftStore,
  resolveSince,
  runCursorHook,
  selectPriceTable,
} from "@rat-stack/core/dx";
import type { FlightHistoryRow } from "@rat-stack/core/dx";
import { Console, Data, DateTime, Effect, Layer, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import {
  dftInvocation,
  installCursorHooks,
  installGitHooks,
  installSkills,
} from "./dft-install.js";
import type { InstallStep } from "./dft-install.js";
import {
  analyzeText,
  historyText,
  ledgerValues,
  moneyLines,
  usageLines,
} from "./dft-render.js";
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
    "Report every repository in the store, not just the current one"
  ),
  branch: optionalString(
    "branch",
    "Branch to report on, e.g. feature/x; defaults to the checked-out branch"
  ),
  db: optionalString(
    "db",
    "Path to the SQLite store; defaults to $DFT_HOME/dft.db (~/.dft/dft.db)"
  ),
  json: booleanFlag(
    "json",
    "Print JSON on stdout instead of text; sync notes go to stderr"
  ),
  noSync: booleanFlag(
    "no-sync",
    "Skip importing new local data first; report only what is already stored"
  ),
  repo: optionalString(
    "repo",
    "Repository path; defaults to $DX_REPO, then the current directory"
  ),
  since: optionalString(
    "since",
    "Only count activity after this point: 30m, 24h, 7d, 2w or an ISO timestamp like 2026-09-01T00:00:00Z"
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
    const userTable = yield* loadUserPriceTable(paths.dftHome);
    const selection = selectPriceTable(userTable);

    if (selection.warning !== null) {
      yield* Console.error(selection.warning);
    }

    const costOptions =
      userTable.kind === "loaded"
        ? defaultCostOptions(userTable)
        : yield* defaultPriceProvider(paths.home).pipe(
            Effect.tap((provider) =>
              Console.error(provider.warnings.join("\n")).pipe(
                Effect.when(Effect.succeed(provider.warnings.length > 0))
              )
            ),
            Effect.map((provider) => ({
              priceTable: provider.table,
              subscription: null,
            }))
          );

    const now = yield* DateTime.now;
    const from = yield* resolveSince(flags.since, DateTime.toEpochMillis(now));
    const registry = buildRegistry(allCollectors, metricsWithCost(costOptions));

    const capabilities = makeDxCapabilities({
      collectors: allCollectors,
      costOptions,
      defaultRepo: paths.repo,
      registry,
      selector: {
        allRepos: flags.allRepos,
        branch: flags.branch ?? null,
        from,
      },
      storePath: paths.store.path,
    });

    return { capabilities, paths };
  });

type Session = Effect.Success<ReturnType<typeof dftSession>>;

const syncStep = (flags: ReportFlags, session: Session) =>
  Effect.gen(function* sync() {
    if (flags.noSync) {
      return;
    }

    const store = yield* EventStore;

    const report = yield* autoSync(store, allCollectors, {
      cwd: process.cwd(),
      home: session.paths.home,
      repo: session.paths.repo,
      storePath: session.paths.store.path,
    });

    yield* Console.error(formatSyncLine(report));
  });

const printOutput = (
  flags: Pick<ReportFlags, "json">,
  json: string,
  text?: string
): Effect.Effect<void> =>
  Console.log(flags.json || text === undefined ? json : text);

const reportCommand = <A, E, R>(
  name: string,
  description: string,
  run: (flags: ReportFlags, session: Session) => Effect.Effect<A, E, R>,
  render?: (output: A) => string,
  presync = true
) =>
  Command.make(name, reportFlags, (flags) =>
    Effect.gen(function* report() {
      const session = yield* dftSession(flags);

      yield* Effect.gen(function* withStore() {
        if (presync) {
          yield* syncStep(flags, session);
        }

        const output = yield* run(flags, session);
        yield* printOutput(
          flags,
          JSON.stringify(output, null, 2),
          render?.(output)
        );
      }).pipe(Effect.provide(dxStoreLayer(session.paths.store)));
    })
  ).pipe(Command.withDescription(description));

const capabilityAt = (session: Session) => {
  const [status, analyze, explain, evidence, collect, mark, history, chats] =
    session.capabilities;

  return { analyze, chats, collect, evidence, explain, history, mark, status };
};

const statusCommand = reportCommand(
  "status",
  "Check that dft is set up: store path, which local sources were found and whether each report is ready. Syncs this repo first.",
  (_flags, session) => capabilityAt(session).status.handler({})
).pipe(
  Command.withShortDescription(
    "Check setup: store, local sources found, report readiness"
  ),
  Command.withExamples([
    { command: "dft status", description: "Check setup for the current repo" },
    {
      command: "dft status --json --no-sync",
      description: "Machine-readable status without importing new data",
    },
  ])
);

const analyzeHandler = (flags: ReportFlags, session: Session) =>
  capabilityAt(session).analyze.handler(
    flags.allRepos ? {} : { repo: session.paths.repo }
  );

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
];

const analyzeCommand = reportCommand(
  "analyze",
  "AI cost report for one branch: each money ledger listed separately (never summed), plus tokens, active time and git activity. Syncs this repo first unless --no-sync.",
  analyzeHandler,
  analyzeText
).pipe(
  Command.withShortDescription(
    "Cost report for a branch: money ledgers, tokens, time, git"
  ),
  Command.withExamples(analyzeExamples)
);

const analyseCommand = reportCommand(
  "analyse",
  "Same as analyze",
  analyzeHandler,
  analyzeText
).pipe(Command.withExamples(analyzeExamples));

const explainCommand = reportCommand(
  "explain",
  "Show the timeline of events behind a branch's numbers, each linked to its source evidence (up to 200 entries). Use it to check where a cost came from.",
  (_flags, session) => capabilityAt(session).explain.handler({ limit: 200 })
).pipe(
  Command.withShortDescription(
    "Timeline of events behind a branch's numbers, with evidence"
  ),
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

const historyCommand = reportCommand(
  "history",
  "List every branch worked on (one row per repo and branch) with status, active time, tokens and each money ledger. Covers the current repo unless --all-repos. --branch is ignored here.",
  (flags, session) =>
    capabilityAt(session).history.handler(historyInput(flags, session)),
  (output) => historyText(output.rows)
).pipe(
  Command.withShortDescription(
    "All branches with status, time, tokens and money ledgers"
  ),
  Command.withExamples([
    { command: "dft history", description: "All branches in this repo" },
    {
      command: "dft history --since 30d --all-repos",
      description: "Every repo, last 30 days",
    },
    {
      command: "dft history --json",
      description: "Rows as JSON for scripts",
    },
  ])
);

const chatsCommand = reportCommand(
  "chats",
  "Show the chat sessions for a branch as a tree, with the model and reasoning level used on each turn.",
  (flags, session) =>
    capabilityAt(session).chats.handler(
      optionalInput({ repo: session.paths.repo }, flags)
    )
).pipe(
  Command.withShortDescription(
    "Chat tree for a branch with per-turn model and reasoning level"
  ),
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
  "Import new local data for this repo: Cursor hook spool, git history and chat transcripts. Safe to re-run; only new data is added. Other commands already sync first, so you rarely need this.",
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
  (output) => formatSyncLine(output),
  false
).pipe(
  Command.withShortDescription(
    "Import new local data (hook spool, git, transcripts); safe to re-run"
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

const currentRow = (
  rows: readonly FlightHistoryRow[],
  branch: string | null
): FlightHistoryRow | null => rows.find((row) => row.branch === branch) ?? null;

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

    const head = `dft snapshot ${record.snapshotId} ${context.branch ?? "(detached)"}@${(context.headSha ?? "unknown").slice(0, 12)}${record.dirty === true ? " (dirty)" : ""}`;

    const lines =
      result.row === null
        ? [head, "  no activity recorded for this branch yet"]
        : [head, ...moneyLines(result.row), ...usageLines(result.row)];

    yield* printOutput(
      flags,
      JSON.stringify(record, null, 2),
      lines.join("\n")
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
        `dft snapshot: a money ledger (${over}) exceeds --max-cost ${limit}; ledgers are compared one by one, never summed`
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
        "Fail (exit 1) when any single money ledger exceeds this amount; ledgers are never summed"
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
          `dft snapshot: not persisted (${error.message}); never blocking`
        ).pipe(Effect.as(null))
      ),
      Effect.flatMap((row) => enforceMaxCost(row, flags.maxCost))
    )
).pipe(
  Command.withDescription(
    "Save the branch's current cost to snapshots.jsonl next to the store, keyed to HEAD and the dirty flag, and print one line per money ledger. Meant for git hooks: it never fails on its own errors, and exits 1 only when --max-cost is exceeded."
  ),
  Command.withShortDescription(
    "Record cost at HEAD; optional --max-cost budget check for git hooks"
  ),
  Command.withExamples([
    { command: "dft snapshot", description: "Record and print the cost now" },
    {
      command: "dft snapshot --max-cost 5",
      description: "Exit 1 if any single ledger is over 5",
    },
  ])
);

const installLine = (step: InstallStep): string =>
  `${step.action.padEnd(9)} ${step.path}: ${step.detail}`;

const installCommand = Command.make(
  "install",
  {
    gitHooks: booleanFlag(
      "git-hooks",
      "Also add `dft snapshot` to the pre-commit and pre-push git hooks; existing hooks are kept"
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

      const steps = yield* Effect.sync(() => [
        installCursorHooks(worktree, `${command} hook`),
        ...installSkills(worktree),
        ...(flags.gitHooks ? installGitHooks(worktree, command) : []),
      ]);

      yield* Console.log(
        flags.json
          ? JSON.stringify({ command, steps, worktree }, null, 2)
          : steps.map(installLine).join("\n")
      );
    })
).pipe(
  Command.withDescription(
    "Set up dft in this repo: add dft entries to .cursor/hooks.json and install the dft Cursor skills. Only touches the project; never writes to ~/.cursor. Run once: running it again adds duplicate dft hook entries."
  ),
  Command.withShortDescription(
    "Set up Cursor hooks and skills in this repo (run once)"
  ),
  Command.withExamples([
    { command: "dft install", description: "Set up Cursor hooks and skills" },
    {
      command: "dft install --git-hooks",
      description: "Also snapshot cost on every commit and push",
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
    "Advanced: run collectors directly; most users want dft sync"
  )
);

const markCommand = toCommand(fixedCaps.mark, { name: "mark" }).pipe(
  Command.provide(dxStoreLayer(fixed.store)),
  Command.withDescription(
    "Advanced, optional: write an explicit flight start/stop/wait marker or labelled claim. Reports work without manual marks; branch and time are detected automatically."
  ),
  Command.withShortDescription(
    "Advanced, optional: add a manual marker; not needed for normal reports"
  )
);

const evidenceCommand = toCommand(fixedCaps.evidence, {
  name: "evidence",
}).pipe(
  Command.provide(dxStoreLayer(fixed.store)),
  Command.withShortDescription("Advanced: look up stored evidence records")
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
      "AI engineering cost tracker: tokens, active time and every money ledger per branch, from local Cursor and git data.",
      "",
      "  Quick start:",
      "    dft install                           set up Cursor hooks and skills in this repo (once)",
      "    dft analyze                           cost report for the current branch",
      "    dft history --since 30d --all-repos   every branch you worked on, all repos",
      "    dft <command> --help                  flags and examples for one command",
    ].join("\n")
  ),
  Command.withSubcommands([
    installCommand,
    statusCommand,
    analyzeCommand,
    analyseCommand,
    explainCommand,
    historyCommand,
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

export const runDft = Command.runWith(dftCommand, { version: VERSION });
