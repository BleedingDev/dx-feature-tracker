// @effect-diagnostics nodeBuiltinImport:off -- The live dashboard serves one local page over node:http on 127.0.0.1 and runs the engine's Effects through a captured runtime at the process boundary.
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

import {
  HarnessRegistry,
  AGENT_PROFILE_VERSION,
  AgentError,
  AgentQueryOutputSchema,
  AgentStore,
  EventStore,
  harnessRegistryFor,
  resolveGitRepo,
  resolveSince,
  startLiveEngine,
} from "@rat-stack/core/dx";
import type {
  AgentScope,
  AgentStoreFailure,
  OperationArguments,
  DxUsageInputType,
  DxUsageOutputType,
  FlightHistoryRow,
  LiveChange,
  LiveEngine,
  OperationReceipt,
  SyncStep,
  dxStoreLayer,
} from "@rat-stack/core/dx";
import {
  Cause,
  Console,
  Context,
  Data,
  DateTime,
  Effect,
  FiberSet,
  Option,
  Predicate,
  Schedule,
  Schema,
  Struct,
  Layer,
} from "effect";

import { writeAgentDashboardCapability } from "./dft-agent-dashboard-write.js";
import { readAgentDashboardQuery } from "./dft-agent-dashboard.js";
import {
  DASHBOARD_OPERATION_BOUNDS,
  DashboardOperationBridge,
  DashboardOperationReviewSchema,
} from "./dft-agent-live-bridge.js";
import type { DashboardOperationReview } from "./dft-agent-live-bridge.js";
import { AgentApplication, agentScopeFor } from "./dft-agent-runtime.js";
import { hasCapture, isCaptureTool } from "./dft-capture.js";
import {
  baseName,
  branchChatsWith,
  chatList,
  openInBrowser,
  repoName,
  repoPathOf,
} from "./dft-dashboard.js";
import { hasDftHooks } from "./dft-install.js";
import {
  INTRO_ROUTE,
  introAssetsDir,
  loadIntroAssets,
  parseRange,
} from "./dft-intro.js";
import { TOOL_LABELS, liveDashboardPage } from "./dft-live-page.js";
import { OTLP_PATHS, receiveOtlp } from "./dft-otlp-receiver.js";
import {
  analyzeText,
  explainText,
  formatAgo,
  formatCount,
  formatDuration,
  sourceLabel,
  mergeSteps,
  sourceNote,
  tokenShares,
} from "./dft-render.js";
import { capabilitiesFor, capabilityAt } from "./dft-session.js";
import type { CostOptions, PriceEffects } from "./dft-session.js";
import { telemetryState, userToolDirs } from "./dft-telemetry.js";
import type { TelemetryState } from "./dft-telemetry.js";
import { lastEventTimes } from "./dft-tools.js";
import { usageInputFromQuery } from "./dft-usage.js";

export const DEFAULT_DASHBOARD_PORT = 7420;

export class DashboardServerError extends Data.TaggedError(
  "DashboardServerError"
)<{
  readonly message: string;
  readonly status: number;
}> {}

export interface LivePaths {
  readonly dftHome: string;
  readonly home: string;
  readonly repo: string;
  readonly store: Parameters<typeof dxStoreLayer>[0];
}

export interface LiveServerOptions {
  readonly costOptions: CostOptions;
  readonly prices: PriceEffects;
  readonly engine: LiveEngine;
  readonly introDir?: string;
  readonly paths: LivePaths;
  readonly port: number;
  readonly since: string | undefined;
}

export interface LiveServer {
  readonly port: number;
  readonly token: string;
  readonly trackCurrentRepo: Effect.Effect<string, AgentStoreFailure>;
  readonly url: string;
}

const DASH = "-";

const OTHER_KEY = "(other)";

const measure = (item: { readonly value: number | null }) => item.value;

const orDash = (value: number | null, format: (n: number) => string) =>
  value === null ? DASH : format(value);

const mainRoot = (commonDir: string | null): string | null =>
  commonDir === null || baseName(commonDir) !== ".git"
    ? null
    : path.dirname(commonDir);

const branchSummary = (row: FlightHistoryRow) => [
  { label: "Agent time", text: orDash(measure(row.agentTime), formatDuration) },
  { label: "Chats", text: orDash(measure(row.chats), formatCount) },
  { label: "Commits", text: orDash(measure(row.commits), formatCount) },
  {
    label: "Status",
    text: row.status.value === "unknown" ? DASH : row.status.value,
  },
];

const sinceParam = (value: string | null, fallback: string | undefined) => {
  const chosen =
    value === null || value.trim() === "" ? fallback : value.trim();

  return chosen === undefined || chosen === "all" ? undefined : chosen;
};

const BRANCH_METRICS = [
  "tokens",
  "requests",
  "estimate",
  "toolFigure",
  "billed",
];

export const branchUsageQuery = (
  url: URL,
  groupBy: "model" | "tool",
  since: string | undefined
): URLSearchParams => {
  const params = new URLSearchParams();

  for (const name of ["repo", "branch", "tz"]) {
    const value = url.searchParams.get(name);

    if (value !== null) {
      params.set(name, value);
    }
  }

  if (since !== undefined) {
    params.set("since", since);
  }

  params.set("groupBy", groupBy);
  params.set("metrics", BRANCH_METRICS.join(","));
  params.set("sortBy", "tokens");
  params.set("limit", groupBy === "model" ? "12" : "50");

  return params;
};

interface FoundTool {
  readonly installed: boolean;
  readonly name: string;
  readonly sessions: number;
  readonly tool: string;
}

const discoverTools = (home: string) =>
  Effect.gen(function* discover() {
    const registry = yield* HarnessRegistry;
    const found = yield* registry.discover;

    return found.map((discovery): FoundTool => ({
      installed:
        discovery.present ||
        discovery.roots.some(
          (root) => existsSync(root) || existsSync(path.dirname(root))
        ),
      name: registry.get(discovery.harness)?.displayName ?? discovery.harness,
      sessions: discovery.sessions,
      tool: discovery.harness,
    }));
  }).pipe(Effect.provide(harnessRegistryFor(home)));

interface ToolContext {
  readonly lastEvents: ReadonlyMap<string, string>;
  readonly now: number;
  readonly repos: readonly string[];
  readonly telemetry: TelemetryState;
}

const captureIn = (tool: string, repos: readonly string[]) =>
  repos.flatMap((root) => {
    const installed = isCaptureTool(tool)
      ? hasCapture(tool, root)
      : tool === "cursor" && hasDftHooks(root);

    return installed ? [baseName(root)] : [];
  });

const telemetryOf = (tool: string, telemetry: TelemetryState) => {
  if (tool === "claude-code") {
    return telemetry.claudeCode;
  }

  return tool === "codex" ? telemetry.codex : null;
};

export const toolsView = (found: readonly FoundTool[], context: ToolContext) =>
  found.map((item) => {
    const last = context.lastEvents.get(item.tool) ?? null;

    return {
      capture: captureIn(item.tool, context.repos),
      installed: item.installed,
      lastEvent: last === null ? null : formatAgo(last, context.now),
      name: item.name,
      sessions: item.sessions,
      telemetry: telemetryOf(item.tool, context.telemetry),
      tool: item.tool,
    };
  });

export const sourcesView = (output: DxUsageOutputType, now: number) => {
  const { coverage } = output;

  const rows = [
    ...output.groups,
    ...(output.other === null ? [] : [output.other]),
  ];

  const tools = [
    ...new Set([
      ...rows.map((row) => row.key),
      ...coverage.disagreements.flatMap((entry) =>
        entry.tool === null ? [] : [entry.tool]
      ),
    ]),
  ].filter((tool) => tool !== OTHER_KEY);

  return {
    derivedAt:
      coverage.derivedAt === null ? null : formatAgo(coverage.derivedAt, now),
    requests: output.total.values.requests ?? 0,
    tools: tools.map((tool) => {
      const fields = coverage.disagreements
        .filter((entry) => entry.tool === tool)
        .map((entry) => ({ count: entry.count, field: entry.field }))
        .toSorted((a, b) => b.count - a.count);

      return {
        disagreements: fields.reduce((sum, entry) => sum + entry.count, 0),
        fields,
        name: TOOL_LABELS.get(tool) ?? tool,
        requests: rows.find((row) => row.key === tool)?.values.requests ?? 0,
        tool,
      };
    }),
    unpriced: coverage.unpriced,
    unresolved: coverage.unresolved,
  };
};

const withSince = <A extends object>(
  base: A,
  since: string | undefined
): A & { since?: string } => (since === undefined ? base : { ...base, since });

const stepLabel = (source: string): string => {
  const tool = /^harness\.(?<tool>.+)$/u.exec(source)?.groups?.tool;
  const name = tool === undefined ? undefined : TOOL_LABELS.get(tool);

  return name === undefined ? sourceLabel(source) : `${name} sessions`;
};

const stepView = (step: SyncStep) => ({
  label: stepLabel(step.source),
  note: sourceNote(step),
  ok: step.status === "synced",
});

const usageOffByEnv = (): boolean =>
  (process.env.DFT_CURSOR_USAGE ?? "").toLowerCase() === "off";

const usageView = (
  saved: boolean,
  usage: {
    readonly lastError: string | null;
    readonly lastRunAt: string | null;
  },
  now: number
) => {
  if (usageOffByEnv()) {
    return {
      enabled: false,
      locked: true,
      note: "Off because DFT_CURSOR_USAGE=off is set. Unset it to turn the import on here.",
    };
  }

  return {
    enabled: saved,
    locked: false,
    note:
      usage.lastError ??
      (usage.lastRunAt === null
        ? "not run yet"
        : `last checked ${formatAgo(usage.lastRunAt, now)}`),
  };
};

const fail = (status: number, message: string) =>
  Effect.fail(new DashboardServerError({ message, status }));

const ActionSchema = Schema.Struct({
  action: Schema.Literals([
    "delete",
    "export",
    "hooks",
    "reset",
    "restore",
    "track",
    "untrack",
    "usage",
  ]),
  confirm: Schema.optional(Schema.String),
  enabled: Schema.optional(Schema.Boolean),
  id: Schema.optional(Schema.String),
  idempotencyKey: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  review: Schema.optional(DashboardOperationReviewSchema),
});

type Action = typeof ActionSchema.Type;

const decodeAction = Schema.decodeUnknownOption(
  Schema.fromJsonString(ActionSchema),
  { onExcessProperty: "error" }
);

const MAX_BODY = 64 * 1024;

const readBody = (request: IncomingMessage) =>
  Effect.callback<string, DashboardServerError>((resume) => {
    const chunks: Buffer[] = [];
    let size = 0;

    request.on("data", (chunk: Buffer) => {
      size += chunk.length;

      if (size > MAX_BODY) {
        resume(fail(413, "Request too large."));
        request.destroy();

        return;
      }

      chunks.push(chunk);
    });
    request.on("end", () => {
      resume(Effect.succeed(Buffer.concat(chunks).toString("utf-8")));
    });
    request.on("error", () => {
      resume(fail(400, "Could not read the request."));
    });
  });

const sendJson = (response: ServerResponse, status: number, text: string) =>
  Effect.sync(() => {
    response.writeHead(status, {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    });
    response.end(text);
  });

const requireString = (value: string | null | undefined, name: string) =>
  value === undefined || value === null || value.trim() === ""
    ? fail(400, `Missing ${name}.`)
    : Effect.succeed(value);

const receiptMessage = (receipt: OperationReceipt, success: string): string =>
  receipt.executionState === "succeeded" &&
  receipt.verificationState === "verified"
    ? success
    : `Operation ${receipt.id} is ${receipt.executionState}; verification is ${receipt.verificationState}. Review its receipt before continuing.`;

export const serveDashboard = (options: LiveServerOptions) =>
  Effect.gen(function* serve() {
    const { engine, paths } = options;
    const token = randomBytes(24).toString("hex");

    const run =
      yield* FiberSet.makeRuntime<
        Effect.Services<ReturnType<typeof discoverTools>>
      >();

    const clients = new Set<ServerResponse>();

    const intro = yield* Effect.sync(() =>
      loadIntroAssets(options.introDir ?? introAssetsDir())
    );

    let { port } = options;

    const applicationLayer = AgentApplication.layer({
      dftHome: paths.dftHome,
      engine,
      home: paths.home,
      repo: paths.repo,
      storePath: paths.store.path,
    }).pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.succeed(EventStore, engine.store),
          Layer.succeed(AgentStore, engine.agentStore),
          harnessRegistryFor(paths.home)
        )
      )
    );

    const services = yield* Layer.build(
      DashboardOperationBridge.layer({ currentRepo: paths.repo, engine }).pipe(
        Layer.provideMerge(applicationLayer)
      )
    );

    const bridge = Context.get(services, DashboardOperationBridge);
    const application = Context.get(services, AgentApplication);

    yield* engine.setAcquisitionExecutor(application.acquire);

    const reviews = new Map<string, DashboardOperationReview>();

    const provideStore = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.provide(services));

    const liveChats = branchChatsWith(options.costOptions);

    const withReadEffects = <A>(output: A) => ({
      ...output,
      effects: {
        acquisition: {
          performed: false,
          receipt: null,
          requested: false,
        },
        prices: options.prices,
      },
    });

    const capsFor = (repo: string, branch: string | null, since?: string) =>
      Effect.gen(function* caps() {
        const now = yield* DateTime.now;
        const from = yield* resolveSince(since, DateTime.toEpochMillis(now));

        return capabilityAt(
          capabilitiesFor({
            costOptions: options.costOptions,
            persistSnapshots: false,
            repo,
            selector: { allRepos: false, branch, from },
            storePath: paths.store.path,
          })
        );
      });

    const history = (since: string | undefined) =>
      Effect.gen(function* historyAll() {
        const caps = yield* capsFor(paths.repo, null, since);

        return yield* provideStore(
          caps.history.handler(
            withSince({ allRepos: true, repo: paths.repo }, since)
          )
        );
      });

    const usageOf = (input: DxUsageInputType) =>
      Effect.gen(function* usage() {
        const caps = yield* capsFor(paths.repo, null, options.since);

        return yield* provideStore(
          caps.usage.handler(Struct.omit(input, ["agentQuery"]))
        ).pipe(
          Effect.map(withReadEffects),
          Effect.catchTag("InvalidInput", (error) =>
            Effect.fail(
              new DashboardServerError({ message: error.message, status: 400 })
            )
          )
        );
      });

    const usageFromQuery = (params: URLSearchParams) =>
      usageInputFromQuery(params).pipe(
        Effect.mapError(
          (issue) =>
            new DashboardServerError({
              message: `Bad usage query: ${issue.message}`,
              status: 400,
            })
        ),
        Effect.flatMap(usageOf)
      );

    const branchView = (url: URL) =>
      Effect.gen(function* branch() {
        const since = sinceParam(url.searchParams.get("since"), options.since);
        const commonDir = url.searchParams.get("repo") ?? "";
        const name = url.searchParams.get("branch") ?? "";
        const data = yield* history(since);

        const row = data.rows.find(
          (candidate) =>
            candidate.repoCommonDir === commonDir && candidate.branch === name
        );

        if (row === undefined) {
          return yield* fail(
            404,
            "No activity on this branch in this time range."
          );
        }

        const repo = repoPathOf(row);

        if (repo === null) {
          return yield* fail(404, "This branch's repo folder is gone.");
        }

        const tools = yield* usageFromQuery(
          branchUsageQuery(url, "tool", since)
        );

        const models = yield* usageFromQuery(
          branchUsageQuery(url, "model", since)
        );

        const caps = yield* capsFor(repo, name, since);

        const report = withReadEffects(
          yield* provideStore(caps.analyze.handler({ repo }))
        );

        const chats = yield* provideStore(
          liveChats(withSince({ branch: name, repo }, since))
        ).pipe(Effect.option);

        const timeline = yield* provideStore(
          caps.explain.handler({ limit: 200 })
        ).pipe(Effect.option);

        const now = DateTime.toEpochMillis(yield* DateTime.now);

        return {
          data: report,
          view: {
            branch: name,
            chats: Option.isSome(chats)
              ? chatList(chats.value, name, true, now)
              : `<p class="muted">Chats for this branch could not be read.</p>`,
            repo: repoName(commonDir),
            repoRoot: mainRoot(row.repoCommonDir),
            report: analyzeText(
              report,
              {
                models: tokenShares(models.groups),
                status: row.status.value,
                toolFigure: models.total.values.toolFigure ?? null,
              },
              { now, verbose: false }
            ),
            root: repo,
            summary: branchSummary(row),
            timeline: Option.isSome(timeline)
              ? explainText(timeline.value, name)
              : "The timeline could not be read.",
            usage: { models, tools },
            worktrees: row.worktrees,
          },
        };
      });

    const toolRows = yield* Effect.cachedWithTTL(
      discoverTools(paths.home),
      "60 seconds"
    );

    const setupView = Effect.gen(function* setup() {
      const status = yield* engine.status;
      const config = yield* engine.config;
      const backups = yield* engine.listBackups;
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const found = yield* toolRows;
      const coverage = yield* usageOf({ groupBy: "tool", limit: 50 });

      return {
        backups: backups.map((backup) => ({
          id: backup.id,
          text: `${formatAgo(backup.createdAt, now)} · before ${backup.reason}${backup.repo === null ? "" : ` of ${baseName(backup.repo)}`} · ${formatCount(backup.bytes)} bytes`,
        })),
        dftHome: paths.dftHome,
        repos: config.repos.map((root) => {
          const live = status.repos.find((repo) => repo.repo === root);

          return {
            error: live?.lastError ?? null,
            hooks: hasDftHooks(root),
            lastSync:
              live?.lastSyncAt === null || live === undefined
                ? "not synced yet"
                : `synced ${formatAgo(live.lastSyncAt, now)}`,
            name: baseName(root),
            root,
            sources: mergeSteps(live?.sources ?? []).map(stepView),
          };
        }),
        sources: sourcesView(coverage, now),
        store: paths.store.path,
        tools: yield* Effect.sync(() =>
          toolsView(found, {
            lastEvents: lastEventTimes(paths.store.path),
            now,
            repos: config.repos,
            telemetry: telemetryState(
              userToolDirs(paths.home, process.env).claudeDir,
              userToolDirs(paths.home, process.env).codexDir
            ),
          })
        ),
        usage: usageView(config.cursorUsageImport, status.usage, now),
      };
    });

    const applyReviewed = (action: Action) =>
      Effect.gen(function* applyReview() {
        if (
          action.action !== "delete" &&
          action.action !== "reset" &&
          action.action !== "restore"
        ) {
          return yield* fail(400, "Select a destructive operation.");
        }

        let target: string | undefined;

        if (action.action === "delete") {
          target = action.path;
        } else if (action.action === "restore") {
          target = action.id;
        }

        const review =
          action.review ?? reviews.get(`${action.action}:${target ?? ""}`);

        if (review === undefined || review.kind !== action.action) {
          return yield* fail(
            400,
            "Review this exact operation before applying it."
          );
        }

        const retained = yield* engine.agentStore.getOperationPlan(review.plan);

        if (
          (action.action === "delete" &&
            retained.scope.worktreeId !== path.resolve(target ?? paths.repo)) ||
          (action.action === "restore" &&
            (retained.arguments.kind !== "restore" ||
              retained.arguments.backupId !== target))
        ) {
          return yield* fail(
            409,
            "The selected target does not match the reviewed operation."
          );
        }

        return yield* bridge.apply(
          review,
          action.confirm ?? "",
          action.idempotencyKey ?? `dashboard:${review.plan.id}`
        );
      });

    const applyLocalOperation = (
      arguments_: OperationArguments,
      scope: AgentScope,
      confirmationPrefix: string
    ) =>
      Effect.gen(function* applyLocal() {
        const caps = yield* capsFor(paths.repo, null);
        const target = yield* engine.agentStore.identity;

        const planned = yield* provideStore(
          caps.operation.handler({
            request: {
              action: "plan",
              arguments: arguments_,
              bounds: DASHBOARD_OPERATION_BOUNDS,
              purpose: `Apply the explicitly selected dashboard ${arguments_.kind} action.`,
              scope,
              target,
            },
          })
        );

        if (planned.action !== "plan") {
          return yield* fail(400, "The operation did not return a plan.");
        }

        const applied = yield* provideStore(
          caps.operation.handler({
            request: {
              action: "apply",
              confirmation: `${confirmationPrefix} ${planned.plan.consent.scopeDigest}`,
              consentReceiptIds: [],
              expectedDigest: planned.plan.planDigest,
              idempotencyKey: randomUUID(),
              plan: {
                id: planned.plan.id,
                storeGeneration: planned.plan.storeGeneration,
                storeId: planned.plan.storeId,
              },
            },
          })
        );

        if (applied.action !== "apply") {
          return yield* fail(
            400,
            "The operation did not return an application receipt."
          );
        }

        return applied.receipt;
      });

    const previewMetadataExport = Effect.gen(function* previewMetadataExport() {
      const caps = yield* capsFor(paths.repo, null, options.since);

      const output = yield* provideStore(
        caps.analyze.handler({
          agentQuery: {
            budget: {
              maxDecodedBytes: 67_108_864,
              maxElapsedMs: 60_000,
              maxFacts: 100_000,
              maxItems: 20,
              maxNetworkRequests: 0,
              maxOutputBytes: 1_048_576,
              maxSeriesBuckets: 32,
              maxStacks: 8,
            },
            detail: "summary",
            policies: {
              acquisition: "recorded-only",
              derivation: "bounded-refresh",
              learning: "hidden",
              prices: "cached-only",
            },
            profileVersion: AGENT_PROFILE_VERSION,
          },
        })
      );

      const analysis = yield* Schema.decodeUnknownEffect(
        AgentQueryOutputSchema
      )(output).pipe(
        Effect.mapError(
          () =>
            new DashboardServerError({
              message:
                "The recorded analysis did not return an exportable basis.",
              status: 400,
            })
        )
      );

      const { basisId } = analysis.context;

      if (basisId === null) {
        return yield* fail(
          400,
          "Complete the bounded recorded analysis before exporting its metadata."
        );
      }

      const destination = path.join(
        paths.repo,
        ".dft",
        "exports",
        `analysis-${randomUUID()}.json`
      );

      const prepared = yield* bridge.previewExport({
        basisId,
        destination,
        scope: analysis.context.scope,
      });

      return {
        ...prepared,
        context: analysis.context,
      };
    });

    const applyMetadataExport = (action: Action) =>
      Effect.gen(function* applyExportReview() {
        if (action.path !== undefined || action.id !== undefined) {
          return yield* fail(
            400,
            "Metadata exports apply only the destination retained in their review."
          );
        }

        if (action.review?.kind !== "export") {
          return yield* fail(
            400,
            "Preview this exact metadata export before applying it."
          );
        }

        const idempotencyKey = yield* requireString(
          action.idempotencyKey,
          "reviewed export idempotency key"
        );

        const confirmation = yield* requireString(
          action.confirm,
          "reviewed export confirmation"
        );

        const receipt = yield* bridge.apply(
          action.review,
          confirmation,
          idempotencyKey
        );

        const destination = receipt.effects.exportArtifacts[0]?.destination;

        return {
          message: receiptMessage(
            receipt,
            destination === undefined
              ? "Saved the reviewed metadata export."
              : `Saved ${destination}`
          ),
          receipt,
        };
      });

    const planView = (url: URL) =>
      Effect.gen(function* plan() {
        const kind = url.searchParams.get("kind");

        if (kind === "export") {
          return yield* previewMetadataExport;
        }

        if (kind !== "delete" && kind !== "reset" && kind !== "restore") {
          return yield* fail(400, "Select delete, reset, restore or export.");
        }

        let target: string | undefined;

        if (kind === "delete") {
          target = yield* requireString(url.searchParams.get("repo"), "repo");
        } else if (kind === "restore") {
          target = yield* requireString(
            url.searchParams.get("backup"),
            "backup"
          );
        }

        const prepared = yield* bridge.plan(kind, target);

        reviews.set(`${kind}:${target ?? ""}`, prepared.review);

        return prepared;
      });

    const act = (action: Action) =>
      Effect.gen(function* perform() {
        switch (action.action) {
          case "track": {
            const target = yield* requireString(action.path, "folder");
            const receipt = yield* bridge.configure("track", target);

            return {
              message: receiptMessage(
                receipt,
                `Now tracking ${baseName(target)}.`
              ),
              receipt,
            };
          }

          case "untrack": {
            const target = yield* requireString(action.path, "folder");
            const receipt = yield* bridge.configure("untrack", target);

            return {
              message: receiptMessage(
                receipt,
                `Stopped tracking ${baseName(target)}. Its data stays until you delete it.`
              ),
              receipt,
            };
          }

          case "hooks": {
            const target = yield* requireString(action.path, "folder");
            const repo = resolveGitRepo(target);

            if (repo === null) {
              return yield* fail(400, "That folder is not a git repo.");
            }

            const receipt = yield* applyLocalOperation(
              {
                expectedContentDigest: "current",
                kind: "configure",
                path: path.join(repo.root, ".cursor", "hooks.json"),
                settings: { action: "install-hooks", host: "cursor" },
              },
              agentScopeFor(repo.root),
              "INSTALL CURSOR HOOKS"
            );

            return {
              message: receiptMessage(
                receipt,
                `Cursor hooks and skills are set up in ${repo.name}.`
              ),
              receipt,
            };
          }

          case "usage": {
            const enabled = action.enabled === true;
            const receipt = yield* bridge.configure("usage", enabled);

            return {
              message: receiptMessage(
                receipt,
                enabled
                  ? "Cursor usage import is on."
                  : "Cursor usage import is off."
              ),
              receipt,
            };
          }

          case "export": {
            return yield* applyMetadataExport(action);
          }

          case "delete": {
            const receipt = yield* applyReviewed(action);
            const removed = receipt.effects.removedCount;
            const [backup] = receipt.effects.backupIds;

            return {
              message: receiptMessage(
                receipt,
                `Deleted ${removed === null ? "the reviewed" : formatCount(removed)} events. Backup ${backup ?? "unavailable"} can restore them.`
              ),
              receipt,
            };
          }

          case "reset": {
            const receipt = yield* applyReviewed(action);

            return {
              message: receiptMessage(
                receipt,
                `The store is empty. Backup ${receipt.effects.backupIds[0] ?? "unavailable"} can restore it.`
              ),
              receipt,
            };
          }

          case "restore": {
            const receipt = yield* applyReviewed(action);

            return {
              message: receiptMessage(
                receipt,
                `Restored ${action.id ?? "the reviewed backup"}. The data from before is in backup ${receipt.effects.backupIds[0] ?? "unavailable"}.`
              ),
              receipt,
            };
          }

          default: {
            return yield* fail(400, "Unknown action.");
          }
        }
      });

    const allowedHosts = () =>
      new Set([`127.0.0.1:${String(port)}`, `localhost:${String(port)}`]);

    const hostAllowed = (request: IncomingMessage) =>
      allowedHosts().has(request.headers.host ?? "");

    const originAllowed = (request: IncomingMessage) => {
      const { origin } = request.headers;

      return (
        origin !== undefined &&
        [...allowedHosts()].some((host) => origin === `http://${host}`)
      );
    };

    const openEvents = (response: ServerResponse) =>
      Effect.sync(() => {
        response.writeHead(200, {
          "cache-control": "no-store",
          connection: "keep-alive",
          "content-type": "text/event-stream; charset=utf-8",
        });
        response.write("retry: 2000\n\nevent: hello\ndata: {}\n\n");
        clients.add(response);
        response.on("close", () => {
          clients.delete(response);
        });
      });

    const sendIntro = (
      request: IncomingMessage,
      response: ServerResponse,
      name: string
    ) => {
      const asset = intro?.get(name);

      if (asset === undefined) {
        return fail(404, "Not found.");
      }

      const size = asset.body.length;
      const range = parseRange(request.headers.range, size);

      return Effect.sync(() => {
        if (range === "invalid") {
          response.writeHead(416, {
            "content-range": `bytes */${String(size)}`,
          });
          response.end();

          return;
        }

        const headers = {
          "accept-ranges": "bytes",
          "cache-control": "public, max-age=31536000, immutable",
          "content-type": asset.contentType,
          "x-content-type-options": "nosniff",
        };

        if (range === null) {
          response.writeHead(200, {
            ...headers,
            "content-length": String(size),
          });
          response.end(asset.body);

          return;
        }

        response.writeHead(206, {
          ...headers,
          "content-length": String(range.end - range.start + 1),
          "content-range": `bytes ${String(range.start)}-${String(range.end)}/${String(size)}`,
        });
        response.end(asset.body.subarray(range.start, range.end + 1));
      });
    };

    const agentQueryView = (url: URL) =>
      Effect.gen(function* agentView() {
        const capability = yield* requireString(
          url.searchParams.get("capability"),
          "capability"
        );

        const input = yield* requireString(
          url.searchParams.get("input"),
          "input"
        );

        const caps = yield* capsFor(paths.repo, null);

        return yield* provideStore(
          readAgentDashboardQuery(caps, capability, input)
        ).pipe(
          Effect.catchTag("InvalidInput", (error) => fail(400, error.message))
        );
      });

    const authorizeDashboardAction = (
      request: IncomingMessage,
      allowMissingOrigin = false
    ) =>
      Effect.gen(function* authorizeAction() {
        if (
          !originAllowed(request) &&
          !(allowMissingOrigin && request.headers.origin === undefined)
        ) {
          return yield* fail(
            403,
            "This request did not come from the dashboard page."
          );
        }

        if (request.headers["x-dft-token"] !== token) {
          return yield* fail(
            403,
            "Missing or wrong dashboard token. Reload the page."
          );
        }

        return yield* Effect.void;
      });

    const postAction = (
      request: IncomingMessage,
      response: ServerResponse,
      url: URL
    ) =>
      Effect.gen(function* postActionRequest() {
        if (url.pathname !== "/api/action" && url.pathname !== "/api/agent") {
          return yield* fail(404, "Not found.");
        }

        yield* authorizeDashboardAction(request);

        const body = yield* readBody(request);

        if (url.pathname === "/api/agent") {
          const capability = yield* requireString(
            url.searchParams.get("capability"),
            "capability"
          );

          const caps = yield* capsFor(paths.repo, null);

          const output = yield* provideStore(
            writeAgentDashboardCapability(caps, capability, body)
          ).pipe(
            Effect.catchTag("InvalidInput", (error) => fail(400, error.message))
          );

          return yield* sendJson(response, 200, JSON.stringify(output));
        }

        const action = decodeAction(body);

        if (Option.isNone(action)) {
          return yield* fail(400, "Unknown action.");
        }

        return yield* sendJson(
          response,
          200,
          JSON.stringify(yield* act(action.value))
        );
      });

    const route = (request: IncomingMessage, response: ServerResponse) =>
      Effect.gen(function* handle() {
        if (!hostAllowed(request)) {
          return yield* fail(
            403,
            "Open the dashboard at 127.0.0.1 or localhost."
          );
        }

        const url = new URL(
          request.url ?? "/",
          `http://127.0.0.1:${String(port)}`
        );

        const method = request.method ?? "GET";

        if (method === "POST" && OTLP_PATHS.has(url.pathname)) {
          return yield* receiveOtlp(request, response, paths.store);
        }

        if (method === "POST") {
          return yield* postAction(request, response, url);
        }

        if (method !== "GET") {
          return yield* fail(405, "Only GET and POST are allowed.");
        }

        switch (url.pathname) {
          case "/": {
            return yield* Effect.sync(() => {
              response.writeHead(200, {
                "cache-control": "no-store",
                "content-security-policy":
                  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data: 'self'; media-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
                "content-type": "text/html; charset=utf-8",
                "referrer-policy": "no-referrer",
                "x-content-type-options": "nosniff",
              });
              response.end(liveDashboardPage(token, { intro: intro !== null }));
            });
          }

          case "/events": {
            return yield* openEvents(response);
          }

          case "/api/branch": {
            return yield* sendJson(
              response,
              200,
              JSON.stringify(yield* branchView(url))
            );
          }

          case "/api/usage": {
            return yield* sendJson(
              response,
              200,
              JSON.stringify(yield* usageFromQuery(url.searchParams))
            );
          }

          case "/api/setup": {
            return yield* sendJson(
              response,
              200,
              JSON.stringify(yield* setupView)
            );
          }

          case "/api/query": {
            return yield* sendJson(
              response,
              200,
              JSON.stringify(yield* agentQueryView(url))
            );
          }

          case "/api/plan": {
            yield* authorizeDashboardAction(request, true);

            return yield* sendJson(
              response,
              200,
              JSON.stringify(yield* planView(url))
            );
          }

          default: {
            return url.pathname.startsWith(INTRO_ROUTE)
              ? yield* sendIntro(
                  request,
                  response,
                  url.pathname.slice(INTRO_ROUTE.length)
                )
              : yield* fail(404, "Not found.");
          }
        }
      }).pipe(
        Effect.catchTag("DashboardServerError", (failure) =>
          sendJson(
            response,
            failure.status,
            JSON.stringify({ error: failure.message })
          )
        ),
        Effect.catchTag("AgentError", (failure) =>
          sendJson(
            response,
            failure.code === "plan-stale" ||
              failure.code === "idempotency-conflict"
              ? 409
              : 400,
            JSON.stringify({ error: failure.message, failure })
          )
        ),
        Effect.catchCause((cause) => {
          const error = Cause.squash(cause);

          return sendJson(
            response,
            500,
            JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
            })
          );
        })
      );

    const server = createServer((request, response) => {
      run(route(request, response));
    });

    const broadcast = (change: LiveChange) => {
      const text = `event: change\ndata: ${JSON.stringify(change)}\n\n`;

      for (const client of clients) {
        client.write(text);
      }
    };

    const unsubscribe = engine.subscribe(broadcast);

    yield* Effect.addFinalizer(() =>
      Effect.callback<boolean>((resume) => {
        unsubscribe();

        for (const client of clients) {
          client.end();
        }

        clients.clear();
        server.close(() => {
          resume(Effect.succeed(true));
        });
        server.closeAllConnections();
      })
    );

    port = yield* Effect.callback<number, DashboardServerError>((resume) => {
      server.once("error", (error: NodeJS.ErrnoException) => {
        resume(
          Effect.fail(
            new DashboardServerError({
              message:
                error.code === "EADDRINUSE"
                  ? `Port ${String(options.port)} is in use. Try --port ${String(options.port + 1)}.`
                  : error.message,
              status: 0,
            })
          )
        );
      });
      server.listen(options.port, "127.0.0.1", () => {
        const address = server.address();

        resume(
          Effect.succeed(
            address === null || Predicate.isString(address)
              ? options.port
              : address.port
          )
        );
      });
    });

    yield* Effect.forkScoped(
      Effect.sync(() => {
        for (const client of clients) {
          client.write(": ping\n\n");
        }
      }).pipe(Effect.repeat(Schedule.spaced("20 seconds")))
    );

    return {
      port,
      token,
      trackCurrentRepo: bridge.configure("track", paths.repo).pipe(
        Effect.flatMap((receipt) =>
          receipt.executionState === "succeeded" &&
          receipt.verificationState === "verified"
            ? Effect.succeed(baseName(paths.repo))
            : Effect.fail(
                new AgentError({
                  code: "source-unavailable",
                  currentRevision: receipt.afterRevision,
                  expectedRevision: receipt.beforeRevision,
                  message: `Tracking was not verified. ${receiptMessage(receipt, baseName(paths.repo))} Receipt: ${receipt.id}.`,
                  recovery: { action: "replan", ref: null },
                  ref: null,
                  retryable: false,
                })
              )
        )
      ),
      url: `http://127.0.0.1:${String(port)}/`,
    } satisfies LiveServer;
  });

export interface LiveDashboardOptions {
  readonly costOptions: CostOptions;
  readonly prices: PriceEffects;
  readonly open: boolean;
  readonly paths: LivePaths;
  readonly port: number;
  readonly since: string | undefined;
}

export const runLiveDashboard = (options: LiveDashboardOptions) =>
  Effect.scoped(
    Effect.gen(function* live() {
      const engine = yield* startLiveEngine({
        deferAcquisitionUntilConfigured: true,
        dftHome: options.paths.dftHome,
        home: options.paths.home,
        signals: [],
        storePath: options.paths.store.path,
      });

      const server = yield* serveDashboard({ ...options, engine });

      const tracked = yield* server.trackCurrentRepo.pipe(
        Effect.catchTag("AgentError", (error) =>
          Console.error(
            `dft: not tracking this folder (${error.message})`
          ).pipe(Effect.as(null))
        )
      );

      yield* engine.ready;

      yield* Console.log(
        [
          `dft dashboard is running at ${server.url}`,
          tracked === null
            ? ""
            : `Tracking ${tracked}. It keeps syncing while this runs.`,
          "Press Ctrl+C to stop.",
        ]
          .filter((line) => line !== "")
          .join("\n")
      );

      if (options.open) {
        yield* openInBrowser(server.url, process.platform);
      }

      return yield* Effect.never.pipe(
        Effect.onInterrupt(() =>
          engine.stop.pipe(
            Effect.andThen(Console.error("dft dashboard stopped."))
          )
        )
      );
    })
  );
