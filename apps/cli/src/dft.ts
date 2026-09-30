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
  allRepos: booleanFlag("all-repos", "Include every repository in the store"),
  branch: optionalString(
    "branch",
    "Branch to report; defaults to the current branch"
  ),
  db: optionalString(
    "db",
    "SQLite store; defaults to $DFT_HOME/dft.db (~/.dft/dft.db)"
  ),
  json: booleanFlag("json", "Print machine-readable JSON on stdout"),
  noSync: booleanFlag("no-sync", "Skip the incremental sync of local sources"),
  repo: optionalString(
    "repo",
    "Repository path; defaults to the current directory"
  ),
  since: optionalString(
    "since",
    "Lower time bound: 7d, 24h, 30m, 2w or an ISO timestamp"
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

    const costOptions = defaultCostOptions(userTable);
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
  "Show the store, enabled sources and module readiness (syncs this repo first)",
  (_flags, session) => capabilityAt(session).status.handler({})
);

const analyzeHandler = (flags: ReportFlags, session: Session) =>
  capabilityAt(session).analyze.handler(
    flags.allRepos ? {} : { repo: session.paths.repo }
  );

const analyzeCommand = reportCommand(
  "analyze",
  "Per-branch AI cost report: every money ledger separately, tokens, time, git",
  analyzeHandler
);

const analyseCommand = reportCommand(
  "analyse",
  "Alias of analyze",
  analyzeHandler
);

const explainCommand = reportCommand(
  "explain",
  "Evidence-linked timeline behind the current branch's numbers",
  (_flags, session) => capabilityAt(session).explain.handler({ limit: 200 })
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
  "Every feature flight (repo, branch) with status, time, tokens and each money ledger",
  (flags, session) =>
    capabilityAt(session).history.handler(historyInput(flags, session)),
  (output) => historyText(output.rows)
);

const chatsCommand = reportCommand(
  "chats",
  "Chat tree for a branch with the per-turn model and reasoning level",
  (flags, session) =>
    capabilityAt(session).chats.handler(
      optionalInput({ repo: session.paths.repo }, flags)
    )
);

const syncCommand = reportCommand(
  "sync",
  "Incrementally import this repo's local sources (hook spool, git, transcripts); idempotent",
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
    "Persist an analyze snapshot keyed to HEAD (+dirty) and print one line per money ledger; exit 0 unless --max-cost is exceeded"
  )
);

const installLine = (step: InstallStep): string =>
  `${step.action.padEnd(9)} ${step.path}: ${step.detail}`;

const installCommand = Command.make(
  "install",
  {
    gitHooks: booleanFlag(
      "git-hooks",
      "Also chain `dft snapshot` into pre-commit and pre-push (never clobbers existing hooks)"
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
    "Write project .cursor/hooks.json entries and Cursor skills (never ~/.cursor); --git-hooks adds snapshot hooks"
  )
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
    "Cursor hook entrypoint: read one hook JSON payload on stdin, spool sanitized metadata, print the hook response"
  )
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
  Command.provide(dxStoreLayer(fixed.store))
);

const markCommand = toCommand(fixedCaps.mark, { name: "mark" }).pipe(
  Command.provide(dxStoreLayer(fixed.store))
);

const evidenceCommand = toCommand(fixedCaps.evidence, {
  name: "evidence",
}).pipe(Command.provide(dxStoreLayer(fixed.store)));

const mcpCommand = Command.make("mcp", {}, () =>
  Layer.launch(mcpServer.tools).pipe(Effect.orDie)
).pipe(
  Command.withDescription(
    "Serve the dx capabilities as an MCP server over stdio"
  )
);

export const dftCommand = Command.make("dft").pipe(
  Command.withDescription(
    "AI engineering cost tracker: per-branch tokens, time and every money ledger from local Cursor and git data"
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
