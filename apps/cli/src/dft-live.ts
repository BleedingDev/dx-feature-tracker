// @effect-diagnostics nodeBuiltinImport:off -- The live dashboard serves one local page over node:http on 127.0.0.1 and runs the engine's Effects through a captured runtime at the process boundary.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

import {
  dxStoreLayer,
  resolveGitRepo,
  resolveSince,
  startLiveEngine,
} from "@rat-stack/core/dx";
import type {
  FlightHistoryRow,
  LiveChange,
  LiveEngine,
  SyncStep,
} from "@rat-stack/core/dx";
import {
  Cause,
  Console,
  Data,
  DateTime,
  Effect,
  FiberSet,
  Option,
  Predicate,
  Schedule,
  Schema,
} from "effect";

import {
  baseName,
  branchChats,
  chatList,
  openInBrowser,
  repoName,
  repoPathOf,
  rowBilled,
  rowCursorFigure,
  rowEstimate,
  rowTokens,
  writeDashboard,
} from "./dft-dashboard.js";
import {
  dftInvocation,
  hasDftHooks,
  installCursorHooks,
  installSkills,
} from "./dft-install.js";
import {
  INTRO_ROUTE,
  introAssetsDir,
  loadIntroAssets,
  parseRange,
} from "./dft-intro.js";
import { liveDashboardPage } from "./dft-live-page.js";
import {
  analyzeText,
  explainText,
  formatAgo,
  formatCount,
  formatDuration,
  formatUsd,
  modelShares,
  sourceLabel,
  sourceNote,
} from "./dft-render.js";
import { capabilitiesFor, capabilityAt } from "./dft-session.js";
import type { CostOptions } from "./dft-session.js";

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
  readonly allRepos: boolean;
  readonly costOptions: CostOptions;
  readonly engine: LiveEngine;
  readonly introDir?: string;
  readonly paths: LivePaths;
  readonly port: number;
  readonly since: string | undefined;
}

export interface LiveServer {
  readonly port: number;
  readonly token: string;
  readonly url: string;
}

interface Cell {
  readonly t: string;
  readonly v: number | string;
}

const DASH = "-";

const SINCE_CHOICES = new Set(["7d", "30d", "all"]);

const measure = (item: { readonly value: number | null }) => item.value;

const orDash = (value: number | null, format: (n: number) => string) =>
  value === null ? DASH : format(value);

const numberCell = (
  value: number | null,
  format: (n: number) => string
): Cell => ({ t: orDash(value, format), v: value ?? -1 });

const sumOrNull = (values: readonly (number | null)[]): number | null => {
  const present = values.filter((value): value is number => value !== null);

  return present.length === 0
    ? null
    : present.reduce((sum, value) => sum + value, 0);
};

const mainRoot = (commonDir: string | null): string | null =>
  commonDir === null || baseName(commonDir) !== ".git"
    ? null
    : path.dirname(commonDir);

const worktreeMarker = (row: FlightHistoryRow): Cell => {
  const main = mainRoot(row.repoCommonDir);
  const linked = row.worktrees.filter((worktree) => worktree !== main);

  if (linked.length === 0) {
    return { t: "", v: "" };
  }

  return {
    t: linked.length === 1 ? "worktree" : `${String(linked.length)} worktrees`,
    v: linked.join("\n"),
  };
};

const rowCells = (row: FlightHistoryRow, now: number) => {
  const last =
    row.lastActivityAt === null ? Number.NaN : Date.parse(row.lastActivityAt);

  return {
    agent: numberCell(measure(row.agentTime), formatDuration),
    billed: numberCell(rowBilled(row), formatUsd),
    branch: { t: row.branch ?? "unassigned", v: row.branch ?? "" },
    chats: numberCell(measure(row.chats), formatCount),
    commits: numberCell(measure(row.commits), formatCount),
    estimate: numberCell(rowEstimate(row), formatUsd),
    last: {
      t: formatAgo(row.lastActivityAt, now),
      v: Number.isNaN(last) ? -1 : last,
    },
    repo: { t: repoName(row.repoCommonDir), v: repoName(row.repoCommonDir) },
    status: {
      t: row.status.value === "unknown" ? DASH : row.status.value,
      v: row.status.value,
    },
    tokens: numberCell(rowTokens(row), formatCount),
    worktree: worktreeMarker(row),
  };
};

const tiles = (rows: readonly FlightHistoryRow[]) => [
  {
    label: "Billed",
    note: "what Cursor charged",
    text: orDash(
      sumOrNull(rows.map((row) => measure(row.money.billed))),
      formatUsd
    ),
  },
  {
    label: "Cursor's figure",
    note: "from Cursor's usage data",
    text: orDash(sumOrNull(rows.map(rowCursorFigure)), formatUsd),
  },
  {
    label: "Estimate",
    note: rows.some(
      (row) => rowTokens(row) !== null && rowEstimate(row) === null
    )
      ? "some tokens have no price"
      : "list price for the tokens",
    text: orDash(sumOrNull(rows.map(rowEstimate)), formatUsd),
  },
  {
    label: "Tokens",
    note: "",
    text: orDash(sumOrNull(rows.map(rowTokens)), formatCount),
  },
  {
    label: "Agent time",
    note: "",
    text: orDash(
      sumOrNull(rows.map((row) => measure(row.agentTime))),
      formatDuration
    ),
  },
];

const accountLine = (
  rows: readonly FlightHistoryRow[],
  now: number
): string | null => {
  if (rows.length === 0) {
    return null;
  }

  const billed = sumOrNull(rows.map(rowBilled));
  const estimate = sumOrNull(rows.map(rowEstimate));
  const tokens = sumOrNull(rows.map(rowTokens));

  const last = rows
    .flatMap((row) => (row.lastActivityAt === null ? [] : [row.lastActivityAt]))
    .toSorted()
    .at(-1);

  return [
    "Account usage not linked to a branch",
    ...(billed === null ? [] : [`${formatUsd(billed)} billed`]),
    ...(estimate === null ? [] : [`${formatUsd(estimate)} estimate`]),
    ...(tokens === null ? [] : [`${formatCount(tokens)} tokens`]),
    `last active ${formatAgo(last ?? null, now)}`,
  ].join(" · ");
};

const sinceParam = (value: string | null, fallback: string | undefined) => {
  const chosen = value !== null && SINCE_CHOICES.has(value) ? value : fallback;

  return chosen === undefined || chosen === "all" ? undefined : chosen;
};

const trackedCommonDirs = (repos: readonly string[]): ReadonlySet<string> =>
  new Set(
    repos.flatMap((repo) => {
      const resolved = resolveGitRepo(repo);

      return resolved === null ? [] : [resolved.commonDir];
    })
  );

const withSince = <A extends object>(
  base: A,
  since: string | undefined
): A & { since?: string } => (since === undefined ? base : { ...base, since });

const stepView = (step: SyncStep) => ({
  label: sourceLabel(step.source),
  note: sourceNote(step),
  ok: step.status === "synced",
});

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
  path: Schema.optional(Schema.String),
});

type Action = typeof ActionSchema.Type;

const decodeAction = Schema.decodeUnknownOption(
  Schema.fromJsonString(ActionSchema)
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

const requireString = (value: string | undefined, name: string) =>
  value === undefined || value.trim() === ""
    ? fail(400, `Missing ${name}.`)
    : Effect.succeed(value);

export const serveDashboard = (options: LiveServerOptions) =>
  Effect.gen(function* serve() {
    const { engine, paths } = options;
    const token = randomBytes(24).toString("hex");
    const run = yield* FiberSet.makeRuntime();
    const clients = new Set<ServerResponse>();

    const intro = yield* Effect.sync(() =>
      loadIntroAssets(options.introDir ?? introAssetsDir())
    );

    let { port } = options;

    const provideStore = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.provide(dxStoreLayer(paths.store)));

    const capsFor = (
      repo: string,
      branch: string | null,
      since: string | undefined
    ) =>
      Effect.gen(function* caps() {
        const now = yield* DateTime.now;
        const from = yield* resolveSince(since, DateTime.toEpochMillis(now));

        return capabilityAt(
          capabilitiesFor({
            costOptions: options.costOptions,
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

    const branchesView = (url: URL) =>
      Effect.gen(function* branches() {
        const since = sinceParam(url.searchParams.get("since"), options.since);
        const repoFilter = url.searchParams.get("repo") ?? "";
        const data = yield* history(since);
        const config = yield* engine.config;
        const tracked = trackedCommonDirs(config.repos);
        const now = DateTime.toEpochMillis(yield* DateTime.now);

        const shown = data.rows.filter(
          (row) =>
            row.repoCommonDir !== null &&
            (options.allRepos || tracked.has(row.repoCommonDir))
        );

        const repos = [
          ...new Set(
            shown.flatMap((row) =>
              row.repoCommonDir === null ? [] : [row.repoCommonDir]
            )
          ),
        ].map((commonDir) => ({ id: commonDir, name: repoName(commonDir) }));

        const rows = shown.filter(
          (row) => repoFilter === "" || row.repoCommonDir === repoFilter
        );

        const account =
          repoFilter === ""
            ? data.rows.filter((row) => row.repoCommonDir === null)
            : [];

        return {
          data,
          view: {
            account: accountLine(account, now),
            repos,
            rows: rows.map((row) => ({
              branch: row.branch,
              cells: rowCells(row, now),
              commonDir: row.repoCommonDir,
              key: `${row.repoCommonDir ?? ""}\n${row.branch ?? ""}`,
              root: repoPathOf(row),
            })),
            since: since ?? "all",
            totals: tiles([...rows, ...account]),
          },
        };
      });

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

        const caps = yield* capsFor(repo, name, since);
        const report = yield* provideStore(caps.analyze.handler({ repo }));

        const chats = yield* provideStore(
          branchChats(withSince({ branch: name, repo }, since))
        ).pipe(Effect.option);

        const timeline = yield* provideStore(
          caps.explain.handler({ limit: 200 })
        ).pipe(Effect.option);

        const now = DateTime.toEpochMillis(yield* DateTime.now);
        const cells = rowCells(row, now);

        return {
          data: report,
          view: {
            branch: name,
            chats: Option.isSome(chats)
              ? chatList(chats.value, name, true)
              : `<p class="muted">Chats for this branch could not be read.</p>`,
            repo: repoName(commonDir),
            repoRoot: mainRoot(row.repoCommonDir),
            report: analyzeText(
              report,
              {
                models: Option.isSome(chats)
                  ? modelShares(chats.value.chats)
                  : [],
                status: row.status.value,
              },
              { now, verbose: false }
            ),
            root: repo,
            summary: [
              {
                label: "Billed",
                text: orDash(measure(row.money.billed), formatUsd),
              },
              {
                label: "Cursor's figure",
                text: orDash(rowCursorFigure(row), formatUsd),
              },
              { label: "Estimate", text: cells.estimate.t },
              { label: "Tokens", text: cells.tokens.t },
              { label: "Agent time", text: cells.agent.t },
              { label: "Chats", text: cells.chats.t },
              { label: "Commits", text: cells.commits.t },
              { label: "Status", text: cells.status.t },
            ],
            timeline: Option.isSome(timeline)
              ? explainText(timeline.value, name)
              : "The timeline could not be read.",
            worktrees: row.worktrees,
          },
        };
      });

    const setupView = Effect.gen(function* setup() {
      const status = yield* engine.status;
      const config = yield* engine.config;
      const backups = yield* engine.listBackups;
      const now = DateTime.toEpochMillis(yield* DateTime.now);

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
            sources: (live?.sources ?? []).map(stepView),
          };
        }),
        store: paths.store.path,
        usage: {
          enabled: config.cursorUsageImport,
          note:
            status.usage.lastError ??
            (status.usage.lastRunAt === null
              ? "not run yet"
              : `last checked ${formatAgo(status.usage.lastRunAt, now)}`),
        },
      };
    });

    const planView = (url: URL) =>
      Effect.gen(function* plan() {
        const kind = url.searchParams.get("kind");

        if (kind === "reset") {
          const reset = yield* engine.planResetStore;

          return {
            confirmText: reset.confirmText,
            repos: reset.repos.length,
            totals: reset.totals,
          };
        }

        const target = yield* requireString(
          url.searchParams.get("repo") ?? undefined,
          "repo"
        );

        const repoPlan = yield* engine.planDeleteRepoData(target);

        return {
          branches: repoPlan.branches.length,
          confirmText: repoPlan.confirmText,
          repos: 1,
          totals: repoPlan.totals,
        };
      });

    const act = (action: Action) =>
      Effect.gen(function* perform() {
        switch (action.action) {
          case "track": {
            const result = yield* engine.addRepo(
              yield* requireString(action.path, "folder")
            );

            return {
              message: result.added
                ? `Now tracking ${result.repo.name}.`
                : `${result.repo.name} was already tracked.`,
            };
          }

          case "untrack": {
            const result = yield* engine.removeRepo(
              yield* requireString(action.path, "folder")
            );

            return {
              message:
                result.removed.length === 0
                  ? "That repo was not tracked."
                  : `Stopped tracking ${baseName(result.removed[0] ?? "")}. Its data stays until you delete it.`,
            };
          }

          case "hooks": {
            const target = yield* requireString(action.path, "folder");
            const repo = resolveGitRepo(target);

            if (repo === null) {
              return yield* fail(400, "That folder is not a git repo.");
            }

            const command = dftInvocation(
              process.execPath,
              process.argv[1] ?? "dft"
            );

            yield* Effect.sync(() => {
              installCursorHooks(repo.root, `${command} hook`);
              installSkills(repo.root);
            });

            return {
              message: `Cursor hooks and skills are set up in ${repo.name}.`,
            };
          }

          case "usage": {
            const enabled = action.enabled === true;

            yield* engine.setCursorUsageImport(enabled);

            return {
              message: enabled
                ? "Cursor usage import is on."
                : "Cursor usage import is off.",
            };
          }

          case "export": {
            const written = yield* provideStore(
              Effect.gen(function* exportPage() {
                const caps = yield* capsFor(paths.repo, null, options.since);

                return yield* writeDashboard(
                  {
                    dftHome: paths.dftHome,
                    open: false,
                    repo: paths.repo,
                    scope: "all",
                    since: options.since,
                  },
                  { chats: branchChats, history: caps.history.handler }
                );
              })
            );

            return { message: `Saved ${written.path}` };
          }

          case "delete": {
            const target = yield* requireString(action.path, "repo");

            const result = yield* engine.deleteRepoData(
              target,
              action.confirm ?? ""
            );

            return {
              message: `Deleted ${formatCount(result.plan.totals.events)} events. Backup ${result.backup.id} can restore them.`,
            };
          }

          case "reset": {
            const result = yield* engine.resetStore(action.confirm ?? "");

            return {
              message: `The store is empty. Backup ${result.backup.id} can restore it.`,
            };
          }

          case "restore": {
            const result = yield* engine.restoreBackup(
              yield* requireString(action.id, "backup")
            );

            return {
              message: `Restored ${result.restored.id}. The data from before is in backup ${result.safety.id}.`,
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

        if (method === "POST") {
          if (url.pathname !== "/api/action") {
            return yield* fail(404, "Not found.");
          }

          if (!originAllowed(request)) {
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

          const body = yield* readBody(request);
          const action = decodeAction(body);

          if (Option.isNone(action)) {
            return yield* fail(400, "Unknown action.");
          }

          return yield* sendJson(
            response,
            200,
            JSON.stringify(yield* act(action.value))
          );
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

          case "/api/branches": {
            return yield* sendJson(
              response,
              200,
              JSON.stringify(yield* branchesView(url))
            );
          }

          case "/api/branch": {
            return yield* sendJson(
              response,
              200,
              JSON.stringify(yield* branchView(url))
            );
          }

          case "/api/setup": {
            return yield* sendJson(
              response,
              200,
              JSON.stringify(yield* setupView)
            );
          }

          case "/api/plan": {
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
        Effect.catchTag("LiveActionError", (failure) =>
          sendJson(response, 400, JSON.stringify({ error: failure.message }))
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
      url: `http://127.0.0.1:${String(port)}/`,
    } satisfies LiveServer;
  });

export interface LiveDashboardOptions {
  readonly allRepos: boolean;
  readonly costOptions: CostOptions;
  readonly open: boolean;
  readonly paths: LivePaths;
  readonly port: number;
  readonly since: string | undefined;
}

export const runLiveDashboard = (options: LiveDashboardOptions) =>
  Effect.scoped(
    Effect.gen(function* live() {
      const engine = yield* startLiveEngine({
        dftHome: options.paths.dftHome,
        home: options.paths.home,
        signals: [],
        storePath: options.paths.store.path,
      });

      const tracked = yield* engine.addRepo(options.paths.repo).pipe(
        Effect.map((result) => result.repo.name),
        Effect.catchTag("LiveActionError", (error) =>
          Console.error(
            `dft: not tracking this folder (${error.message})`
          ).pipe(Effect.as(null))
        )
      );

      const server = yield* serveDashboard({ ...options, engine });

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
