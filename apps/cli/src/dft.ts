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
  cachedPriceProvider,
  contextForRepo,
  dxStoreLayer,
  makeDxCapabilities,
  metricsWithCost,
  rebuildUsageFacts,
  resolveDftHome,
  resolveDftStore,
  resolveSince,
  runToolHook,
} from "@rat-stack/core/dx";
import type {
  DxUsageOutputType,
  FlightHistoryRow,
  SyncReport,
  UsageDimension,
} from "@rat-stack/core/dx";
import { Console, Data, DateTime, Effect, Layer, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";

import {
  CAPTURE_TOOL_NAMES,
  CAPTURE_TOOLS,
  dftCommandFor,
  hasSomeCapture,
  installCapture,
  isCaptureTool,
  uninstallCapture,
  writtenUntracked,
} from "./dft-capture.js";
import type { CaptureTool } from "./dft-capture.js";
import { chatsInputOf, chatsText, withoutTitles } from "./dft-chats.js";
import type { ChatsFlagValues } from "./dft-chats.js";
import {
  branchChatsWith,
  dashboardText,
  writeDashboard,
} from "./dft-dashboard.js";
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
  uninstallCursorHooks,
  uninstallGitHooks,
  uninstallSkills,
} from "./dft-install.js";
import { DEFAULT_DASHBOARD_PORT, runLiveDashboard } from "./dft-live.js";
import {
  analyzeText,
  branchOneline,
  enterpriseLine,
  explainText,
  formatUsd,
  historyOneline,
  historyText,
  ledgerValues,
  tokenShares,
  turnShares,
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
  providerCostOptions,
} from "./dft-session.js";
import {
  installTelemetry,
  telemetryState,
  uninstallTelemetry,
  userToolDirs,
} from "./dft-telemetry.js";
import type { TelemetryChange, TelemetryOptions } from "./dft-telemetry.js";
import {
  captureText,
  codexTrusted,
  detectTools,
  lastEventTimes,
  telemetryText,
  toolStatuses,
  toolsText,
  uninstallText,
} from "./dft-tools.js";
import { USAGE_BY_CHOICES, usageInputOf, usageText } from "./dft-usage.js";
import type { UsageFlagValues } from "./dft-usage.js";
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
    const costOptions = yield* costOptionsFor(paths.dftHome);
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
  "Check that dft is set up: where data is stored, which sources (git, Cursor) were found, and for each other tool whether it is installed, how many sessions it has, whether project capture and user telemetry are set up and when its last event arrived. Imports new data first.",
  (_flags, session) =>
    Effect.gen(function* status() {
      const base = yield* capabilityAt(session).status.handler({});
      const detected = yield* detectTools(session.paths.home);
      const context = contextForRepo(session.paths.repo);
      const dirs = userToolDirs(session.paths.home, process.env);

      const tools = yield* Effect.sync(() =>
        toolStatuses(
          detected,
          context.worktreePath ?? session.paths.repo,
          telemetryState(dirs.claudeDir, dirs.codexDir),
          lastEventTimes(session.paths.store.path)
        )
      );

      return { base, tools };
    }),
  {
    json: (output) => ({ ...output.base, tools: output.tools }),
    render: (output, context) =>
      [
        statusText(output.base, context.sync, {
          home: context.home,
          now: context.now,
          verbose: context.verbose,
        }),
        toolsText(output.tools),
      ].join("\n\n"),
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

const turnModelShares = (flags: ReportFlags, session: Session) =>
  capabilityAt(session)
    .chats.handler(optionalInput({ repo: session.paths.repo }, flags))
    .pipe(
      Effect.map((output) => turnShares(output.chats)),
      Effect.orElseSucceed(() => [])
    );

const analyzeExtras = (flags: ReportFlags, session: Session) =>
  Effect.gen(function* extras() {
    const branch = wantedBranch(flags, session);

    const usage = yield* usageInputOf({
      by: "model",
      filters: {
        branch: branch === null ? [] : [branch],
        repo: [session.paths.repo],
      },
      limit: 50,
      metrics: ["tokens", "toolFigure"],
      since: flags.since,
      tz: undefined,
      until: undefined,
    }).pipe(
      Effect.flatMap((input) => capabilityAt(session).usage.handler(input)),
      Effect.option
    );

    const row = yield* wantedRow(flags, session);

    const byTokens = Option.isSome(usage)
      ? tokenShares(usage.value.groups)
      : [];

    const models =
      byTokens.length > 0 ? byTokens : yield* turnModelShares(flags, session);

    return {
      models,
      status: row === null ? null : row.status.value,
      toolFigure: Option.isSome(usage)
        ? (usage.value.total.values.toolFigure ?? null)
        : null,
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
  "AI cost of one branch across every tool: billed cost, each tool's own figure and an estimate at the model maker's public price (shown apart, never added), plus tokens, models, time and commits. Add --oneline (-1) for a single line. Imports new data first unless --no-sync.",
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

const usageByFlag = (name: string, description: string) =>
  Flag.Literals(name, USAGE_BY_CHOICES).pipe(
    Flag.withDescription(description),
    Flag.optional,
    Flag.map(Option.getOrUndefined)
  );

const runUsage = (session: Session, values: UsageFlagValues) =>
  usageInputOf(values).pipe(
    Effect.flatMap((input) => capabilityAt(session).usage.handler(input))
  );

type HistoryOutput =
  | {
      readonly history: Effect.Success<
        ReturnType<ReturnType<typeof capabilityAt>["history"]["handler"]>
      >;
      readonly kind: "history";
      readonly oneline: boolean;
    }
  | { readonly kind: "usage"; readonly usage: DxUsageOutputType };

interface HistoryFlags extends OnelineFlags {
  readonly groupBy: UsageDimension | undefined;
}

const historyRun = (flags: HistoryFlags, session: Session) =>
  flags.groupBy === undefined
    ? capabilityAt(session)
        .history.handler(historyInput(flags, session))
        .pipe(
          Effect.map((history): HistoryOutput => ({
            history,
            kind: "history",
            oneline: flags.oneline,
          }))
        )
    : runUsage(session, {
        by: flags.groupBy,
        filters: flags.allRepos ? {} : { repo: [session.paths.repo] },
        limit: undefined,
        metrics: [],
        since: flags.since,
        tz: undefined,
        until: undefined,
      }).pipe(Effect.map((usage): HistoryOutput => ({ kind: "usage", usage })));

const historyView: ReportView<HistoryOutput, unknown> = {
  json: (output) => (output.kind === "usage" ? output.usage : output.history),
  render: (output, context) => {
    if (output.kind === "usage") {
      return usageText(output.usage, { verbose: context.verbose });
    }

    return output.oneline
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
        );
  },
};

const historyCommand = Command.make(
  "history",
  {
    ...onelineFlags,
    groupBy: usageByFlag(
      "group-by",
      "Group AI usage by one dimension instead of listing branches; same as dft usage --by"
    ),
  },
  (flags) => runReport("history", flags, historyRun, historyView)
).pipe(
  Command.withDescription(
    "One row per branch: status, agent time, tokens, billed cost and estimate. Add --oneline (-1) for one short line per branch, or --group-by tool (or model, provider, day...) to group AI usage instead. This repo only unless --all-repos. --branch is ignored here."
  ),
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
      command: "dft history --group-by model --since 7d",
      description: "This repo's AI usage per model, last 7 days",
    },
    {
      command: "dft history --json",
      description: "Rows as JSON for scripts",
    },
  ])
);

const listFlag = (name: string, description: string) =>
  Flag.String(name).pipe(Flag.withDescription(description), Flag.atLeast(0));

const usageFlags = {
  branch: listFlag(
    "branch",
    "Only these branches (repeat or separate with commas)"
  ),
  by: usageByFlag(
    "by",
    "Group by tool, provider, via, model, effort, repo, branch, worktree, session, day, week or month (default tool)"
  ),
  db: reportFlags.db,
  json: reportFlags.json,
  limit: Flag.Int("limit").pipe(
    Flag.withDescription(
      "Most groups to list; the rest are summed into one Other row (default 10)"
    ),
    Flag.optional,
    Flag.map(Option.getOrUndefined)
  ),
  metric: listFlag(
    "metric",
    "Columns to show: tokens, input, cacheRead, cacheWrite, output, reasoning, requests, sessions, estimate, billed, toolFigure"
  ),
  model: listFlag("model", "Only these models"),
  noSync: reportFlags.noSync,
  provider: listFlag(
    "provider",
    "Only models from these makers (anthropic, openai, google, deepseek...)"
  ),
  repo: listFlag(
    "repo",
    'Only these repositories (paths); "(no repo)" for usage outside a repo. Every repo by default'
  ),
  since: optionalString(
    "since",
    "Start of the window: 30m, 24h, 7d, 2w, an ISO time or a date like 2026-09-01"
  ),
  tool: listFlag(
    "tool",
    "Only these tools (cursor, claude-code, codex, opencode, pi, omp, deepseek)"
  ),
  tz: optionalString(
    "tz",
    "Time zone for day, week and month, e.g. Europe/Prague; defaults to this computer's"
  ),
  until: optionalString(
    "until",
    "End of the window (not included), same forms as --since; defaults to now"
  ),
  verbose: reportFlags.verbose,
  via: listFlag(
    "via",
    "Only requests through these gateways or local runtimes (openrouter, ollama...)"
  ),
};

interface UsageCommandFlags {
  readonly branch: readonly string[];
  readonly by: UsageDimension | undefined;
  readonly db: string | undefined;
  readonly json: boolean;
  readonly limit: number | undefined;
  readonly metric: readonly string[];
  readonly model: readonly string[];
  readonly noSync: boolean;
  readonly provider: readonly string[];
  readonly repo: readonly string[];
  readonly since: string | undefined;
  readonly tool: readonly string[];
  readonly tz: string | undefined;
  readonly until: string | undefined;
  readonly verbose: boolean;
  readonly via: readonly string[];
}

const usageValues = (flags: UsageCommandFlags): UsageFlagValues => ({
  by: flags.by ?? "tool",
  filters: {
    branch: flags.branch,
    model: flags.model,
    provider: flags.provider,
    repo: flags.repo,
    tool: flags.tool,
    via: flags.via,
  },
  limit: flags.limit,
  metrics: flags.metric,
  since: flags.since,
  tz: flags.tz,
  until: flags.until,
});

const usageCommand = Command.make("usage", usageFlags, (flags) =>
  runReport(
    "usage",
    {
      allRepos: true,
      branch: undefined,
      db: flags.db,
      json: flags.json,
      noSync: flags.noSync,
      repo: undefined,
      since: undefined,
      verbose: flags.verbose,
    },
    (_flags, session) => runUsage(session, usageValues(flags)),
    {
      render: (output, context) =>
        usageText(output, { verbose: context.verbose }),
    }
  )
).pipe(
  Command.withDescription(
    "AI usage across every tool, one deduplicated row per request: tokens, requests and each cost figure (estimate, billed, the tool's own figure) shown apart, never added. Group with --by and narrow with --tool, --provider, --via, --model, --repo or --branch. Every figure counts only the --since/--until window. Imports new data first unless --no-sync."
  ),
  Command.withShortDescription("AI usage by tool, model, repo or day"),
  Command.withExamples([
    {
      command: "dft usage --by tool --since 30d",
      description: "Each tool's tokens and cost, last 30 days",
    },
    {
      command: "dft usage --by model --tool codex --since 7d",
      description: "Codex usage per model, last 7 days",
    },
    {
      command: "dft usage --by day --tz Europe/Prague --metric tokens,estimate",
      description: "Tokens and estimate per day in Prague time",
    },
    {
      command: "dft usage --by repo --provider anthropic --json",
      description: "Anthropic models per repo, as JSON",
    },
  ])
);

const dashboardFlags = {
  allRepos: booleanFlag(
    "all-repos",
    "With --one-time: include every repo dft has seen, not just this one (the live dashboard always shows every repo)"
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
  titles: booleanFlag(
    "titles",
    "With --one-time: keep chat titles in the saved page; they are left out by default"
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
  readonly titles: boolean;
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
          titles: input.titles,
        },
        {
          chats: branchChatsWith(session.costOptions),
          history: capabilityAt(session).history.handler,
          usage: capabilityAt(session).usage.handler,
        }
      ),
    { render: (output) => dashboardText(output) }
  );

const liveDashboard = (flags: DashboardCommandFlags) =>
  Effect.gen(function* live() {
    const paths = dftPaths(flags);
    const costOptions = yield* costOptionsFor(paths.dftHome);

    return yield* runLiveDashboard({
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
    "Run a live dashboard on http://127.0.0.1:7420 that keeps syncing and updates as you work. It tracks this repo, opens your browser and runs until Ctrl+C. It only listens on this computer and loads nothing from the internet. Add --one-time to save a static page once and exit; it leaves chat titles out unless you add --titles."
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

const chatsFlags = {
  ...reportFlags,
  allBranches: booleanFlag(
    "all-branches",
    "List chats on every branch of this repo, not just one"
  ),
  effort: listFlag("effort", "Only requests at these reasoning levels"),
  model: listFlag("model", "Only chats that used these models"),
  provider: listFlag(
    "provider",
    "Only chats that used models from these makers (anthropic, openai, google, deepseek...)"
  ),
  titles: booleanFlag(
    "titles",
    "Keep chat titles in --json output; they are left out by default"
  ),
  tool: listFlag(
    "tool",
    "Only these tools (cursor, claude-code, codex, opencode, pi, omp, deepseek)"
  ),
  via: listFlag(
    "via",
    "Only requests through these gateways or local runtimes (openrouter, ollama...)"
  ),
};

interface ChatsCommandFlags extends ReportFlags, ChatsFlagValues {
  readonly titles: boolean;
}

const chatsCommand = Command.make("chats", chatsFlags, (flags) =>
  runReport(
    "chats",
    flags,
    (chatFlags: ChatsCommandFlags, session) =>
      capabilityAt(session).chats.handler(
        chatsInputOf(chatFlags, session.paths.repo)
      ),
    {
      json: (output) => (flags.titles ? output : withoutTitles(output)),
      render: (output, context) =>
        chatsText(output, { now: context.now, verbose: context.verbose }),
    }
  )
).pipe(
  Command.withDescription(
    "Show the chats of every tool (Cursor, Claude Code, Codex, OpenCode, Pi, OMP, DeepSeek Harness) on a branch as one tree: each chat's tool, title, models and reasoning levels per turn, subagents under their parent, and its estimate, the tool's own figure, billed amount, tokens, requests and time. Narrow with --tool, --provider, --model, --via or --effort, like dft usage. Titles stay on this computer: --json leaves them out unless you add --titles. No prompt text is ever stored."
  ),
  Command.withShortDescription("Chats of every tool, with cost and models"),
  Command.withExamples([
    { command: "dft chats", description: "Chats on the checked-out branch" },
    {
      command: "dft chats --branch feature/x --since 7d",
      description: "Another branch, last 7 days",
    },
    {
      command: "dft chats --all-branches --tool claude-code,codex",
      description: "Claude Code and Codex chats on every branch of this repo",
    },
    {
      command: "dft chats --provider anthropic --json",
      description: "Chats that used Anthropic models, as JSON without titles",
    },
  ])
);

const syncCommand = reportCommand(
  "sync",
  "Import new data for this repo from git and every AI coding tool on this machine (session files, hooks and extensions). Safe to run again. Other commands do this first, so you rarely need it.",
  (flags, session) =>
    Effect.gen(function* sync() {
      const store = yield* EventStore;

      const report = yield* autoSync(store, allCollectors, {
        cwd: process.cwd(),
        home: session.paths.home,
        repo: session.paths.repo,
        storePath: session.paths.store.path,
      });

      yield* rebuildUsageFacts.pipe(Effect.ignore);

      return report;
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
        "Exit 1 when any one cost figure (billed, the tool's own, estimate) is over this many dollars"
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

const telemetryOptions = (
  paths: ReturnType<typeof dftPaths>,
  dryRun: boolean,
  port: number,
  now: Date
): TelemetryOptions => ({
  ...userToolDirs(paths.home, process.env),
  backupRoot: path.join(paths.dftHome, "backups", "telemetry"),
  dryRun,
  now,
  port,
  shell: process.env,
  stateFile: path.join(paths.dftHome, "telemetry.json"),
});

const toolIds = (value: string): readonly string[] =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");

const toolFlag = Flag.String("tool").pipe(
  Flag.withDescription(
    `Also set up these tools even when dft did not find them, comma-separated: ${CAPTURE_TOOLS.join(", ")}`
  ),
  Flag.filterMap(
    (value) => {
      const ids = toolIds(value);
      const tools = ids.filter(isCaptureTool);

      return tools.length === ids.length ? Option.some(tools) : Option.none();
    },
    (value) =>
      `one or more of ${CAPTURE_TOOLS.join(", ")} (unknown: ${toolIds(value)
        .filter((id) => !isCaptureTool(id))
        .join(", ")})`
  ),
  Flag.optional,
  Flag.map(Option.getOrElse((): readonly CaptureTool[] => []))
);

const captureFlags = {
  dryRun: booleanFlag(
    "dry-run",
    "Write nothing; with --telemetry, show the exact user settings change"
  ),
  json: reportFlags.json,
  port: Flag.Int("port").pipe(
    Flag.withDefault(DEFAULT_DASHBOARD_PORT),
    Flag.withDescription(
      `With --telemetry: the dft dashboard port that receives OpenTelemetry (default ${String(DEFAULT_DASHBOARD_PORT)})`
    )
  ),
  repo: reportFlags.repo,
  telemetry: booleanFlag(
    "telemetry",
    "Also send Claude Code and Codex OpenTelemetry to dft dashboard on 127.0.0.1 (changes ~/.claude/settings.json and ~/.codex/config.toml, keeps a backup, only adds)"
  ),
};

const entryScript = (): string => process.argv[1] ?? "dft";

const installDryRunText = (
  worktree: string,
  tools: readonly CaptureTool[],
  telemetry: readonly TelemetryChange[] | null
): string =>
  [
    ...(telemetry === null
      ? []
      : [
          telemetryText(
            telemetry,
            "Run it again without --dry-run to make this change."
          ),
        ]),
    `Dry run: dft wrote nothing. Without --dry-run it also sets up Cursor hooks and skills${tools.length === 0 ? "" : ` and local capture for ${tools.map((tool) => CAPTURE_TOOL_NAMES[tool]).join(", ")}`} in ${worktree}.`,
  ].join("\n\n");

const installCommand = Command.make(
  "install",
  {
    ...captureFlags,
    allWorktrees: booleanFlag(
      "all-worktrees",
      "Also set up every other git worktree of this repo (needed for worktrees you open in Cursor on their own)"
    ),
    gitHooks: booleanFlag(
      "git-hooks",
      "Also record cost on every commit and push (adds to your git hooks, keeps what is there)"
    ),
    tool: toolFlag,
  },
  (flags) =>
    Effect.gen(function* install() {
      const paths = dftPaths({ db: undefined, repo: flags.repo });
      const context = contextForRepo(paths.repo);
      const worktree = context.worktreePath ?? paths.repo;
      const command = dftInvocation(process.execPath, entryScript());
      const capture = dftCommandFor(process.execPath, entryScript());
      const detected = yield* detectTools(paths.home);
      const forced = flags.tool;

      const tools = CAPTURE_TOOLS.filter(
        (tool) =>
          forced.includes(tool) ||
          detected.some((item) => item.tool === tool && item.installed) ||
          hasSomeCapture(tool, worktree)
      );

      const now = DateTime.toDate(yield* DateTime.now);

      if (flags.dryRun) {
        const preview = flags.telemetry
          ? yield* Effect.sync(() =>
              installTelemetry(telemetryOptions(paths, true, flags.port, now))
            )
          : null;

        yield* Console.log(
          flags.json
            ? JSON.stringify(
                { dryRun: true, telemetry: preview, tools, worktree },
                null,
                2
              )
            : installDryRunText(worktree, tools, preview)
        );

        return;
      }

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

      const tooling = yield* Effect.sync(() =>
        installCapture(
          tools,
          worktree,
          capture,
          writtenUntracked(worktree, [result.hooks, ...result.skills])
        )
      );

      const telemetry = flags.telemetry
        ? yield* Effect.sync(() =>
            installTelemetry(
              telemetryOptions(paths, flags.dryRun, flags.port, now)
            )
          )
        : null;

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
          JSON.stringify(
            {
              capture: tooling,
              command,
              detected,
              steps,
              telemetry,
              worktree,
              ...worktrees,
            },
            null,
            2
          )
        );

        return;
      }

      const checks = yield* Effect.sync(() => ({
        ...installChecks(
          worktree,
          homedir(),
          process.platform,
          process.version
        ),
        otherTools: tools,
      }));

      const trusted = yield* Effect.sync(() =>
        codexTrusted(userToolDirs(paths.home, process.env).codexDir, [
          worktree,
          context.repoCommonDir === null
            ? worktree
            : path.dirname(context.repoCommonDir),
        ])
      );

      const extra = [
        captureText(worktree, detected, tooling, { codexTrusted: trusted }),
        ...(telemetry === null
          ? []
          : [
              telemetryText(
                telemetry,
                `Keep dft dashboard --port ${String(flags.port)} running to receive it. Undo with dft uninstall --telemetry.`
              ),
            ]),
      ];

      yield* Console.log(
        installText(result, checks, homedir(), stdoutColor(), extra)
      );
    })
).pipe(
  Command.withDescription(
    "Set up dft in this repo: add Cursor hooks to .cursor/hooks.json and the Cursor skills (/dx-line, /dx-analyze, /dx-history, /dx-chats, /dx-explain, /dx-dashboard), plus local capture for every other tool found on this machine: Claude Code hooks in .claude/settings.local.json, Codex hooks in .codex/hooks.json, the Pi and OMP extensions in .pi/extensions and .omp/extensions, the OpenCode plugin in .opencode/plugins and the DeepSeek Harness hook bridge in .dsh. These files stay out of git (listed in this clone's .git/info/exclude), so teammates are never affected. Existing entries are kept, and running it again only points dft's own entries at the Node and dft that ran it. Add --telemetry to also send Claude Code and Codex OpenTelemetry to dft dashboard (user settings, with a backup). Add --all-worktrees to also set up every other worktree of the repo for Cursor."
  ),
  Command.withShortDescription(
    "Set up hooks and capture for every tool in this repo"
  ),
  Command.withExamples([
    {
      command: "dft install",
      description: "Set up Cursor and every other tool found",
    },
    {
      command: "dft install --telemetry --dry-run",
      description: "Show the user-level OpenTelemetry change without writing",
    },
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

const uninstallCommand = Command.make("uninstall", captureFlags, (flags) =>
  Effect.gen(function* uninstall() {
    const paths = dftPaths({ db: undefined, repo: flags.repo });
    const context = contextForRepo(paths.repo);
    const worktree = context.worktreePath ?? paths.repo;
    const now = DateTime.toDate(yield* DateTime.now);

    if (flags.dryRun && !flags.telemetry) {
      yield* Console.log(
        flags.json
          ? JSON.stringify({ dryRun: true, steps: [], worktree }, null, 2)
          : `Dry run: dft removed nothing. Without --dry-run it removes what dft install added in ${worktree}.`
      );

      return;
    }

    if (flags.telemetry) {
      const changes = yield* Effect.sync(() =>
        uninstallTelemetry(
          telemetryOptions(paths, flags.dryRun, flags.port, now)
        )
      );

      yield* Console.log(
        flags.json
          ? JSON.stringify({ telemetry: changes }, null, 2)
          : telemetryText(
              changes,
              "Only what dft added was removed. The backups stay under ~/.dft/backups/telemetry."
            )
      );

      return;
    }

    const steps = yield* Effect.sync(() => {
      const cursor = [
        ...uninstallCursorHooks(worktree),
        ...uninstallSkills(worktree),
        ...uninstallGitHooks(worktree),
      ].map((item) => ({ ...item, tool: "cursor" as const }));

      return [
        ...cursor,
        ...uninstallCapture(
          worktree,
          dftCommandFor(process.execPath, entryScript())
        ),
      ];
    });

    yield* Console.log(
      flags.json
        ? JSON.stringify({ steps, worktree }, null, 2)
        : uninstallText(worktree, steps)
    );
  })
).pipe(
  Command.withDescription(
    "Remove only what dft install added to this repo: dft entries in tool hook files (other entries stay), the dft extension and plugin files, the Cursor skills it copied, the dft line in git hooks and its lines in .git/info/exclude. Add --telemetry to instead remove the user-level OpenTelemetry settings that dft install --telemetry added."
  ),
  Command.withShortDescription("Remove what dft install added"),
  Command.withExamples([
    { command: "dft uninstall", description: "Remove dft from this repo" },
    {
      command: "dft uninstall --telemetry",
      description: "Remove the user-level OpenTelemetry settings dft added",
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

const hookCommand = Command.make(
  "hook",
  // oxlint-disable-next-line sort-keys -- positional arguments parse in key order, so tool must come before event
  {
    tool: Argument.String("tool").pipe(
      Argument.withDescription(
        "Tool that runs the hook (cursor, claude-code, codex, opencode, pi, omp, deepseek); cursor when left out"
      ),
      Argument.optional
    ),
    event: Argument.String("event").pipe(
      Argument.withDescription(
        "Hook event name; read from the payload when left out"
      ),
      Argument.optional
    ),
  },
  ({ event, tool }) =>
    DateTime.now.pipe(
      Effect.map((now) =>
        runToolHook({
          cwd: process.cwd(),
          event: Option.getOrNull(event),
          now: DateTime.toDate(now),
          stdinText: readStdin(),
          tool: Option.getOrNull(tool),
        })
      ),
      Effect.flatMap((result) =>
        result.stdout === "" ? Effect.void : Console.log(result.stdout)
      )
    )
).pipe(
  Command.withDescription(
    "Internal: called by tool hooks written by dft install, as dft hook <tool> <event>. Reads one hook JSON payload on stdin, stores a small sanitized observation under ~/.dft and prints only the response the tool needs."
  ),
  Command.withShortDescription("Internal: tool hook entrypoint")
);

const staticSession = () => {
  const paths = dftPaths({ db: undefined, repo: undefined });

  const costOptions = providerCostOptions(
    cachedPriceProvider(resolveDftHome(process.env, homedir()))
  );

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
      "See what AI coding costs per branch: an estimate at the model maker's price, billed cost, tokens and time, from every AI coding tool and git on this machine.",
      "",
      "  Quick start:",
      "    dft install                  set up this repo (safe to run again)",
      "    dft analyze                  cost of the current branch",
      "    dft line                     the same, on one line",
      "    dft history --all-repos      every branch in every repo, one row each",
      "    dft history --oneline        every branch in this repo, one line each",
      "    dft usage --by tool          AI usage per tool, model, repo or day",
      "    dft dashboard                every branch as a web page, opens in your browser",
      "    dft <command> --help         flags and examples",
    ].join("\n")
  ),
  Command.withSubcommands([
    installCommand,
    uninstallCommand,
    statusCommand,
    analyzeCommand,
    analyseCommand,
    lineCommand,
    explainCommand,
    historyCommand,
    usageCommand,
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
