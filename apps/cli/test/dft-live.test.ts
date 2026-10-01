// @effect-diagnostics nodeBuiltinImport:off asyncFunction:off newPromise:off globalTimers:off -- The live dashboard test scripts a throwaway git repo and DFT_HOME, talks to the real node:http server and spawns the built dft binary to compare its JSON.
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { request } from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { NodeServices } from "@effect/platform-node";
import { afterAll, describe, expect, it } from "@effect/vitest";
import { runCursorHook, startLiveEngine } from "@rat-stack/core/dx";
import { DateTime, Effect, Schema } from "effect";

import { dashboardStateKit } from "../src/dft-dashboard-state.js";
import type { UsageViewState } from "../src/dft-dashboard-state.js";
import { serveDashboard } from "../src/dft-live.js";
import type { LiveServer } from "../src/dft-live.js";
import { costOptionsFor } from "../src/dft-session.js";
import { claudeLogsJson } from "./otlp-payloads.js";

const scratch = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "dft-live-cli-"))
);

afterAll(() => {
  fs.rmSync(scratch, { force: true, recursive: true });
});

const dftHome = path.join(scratch, "dft-home");

const storePath = path.join(dftHome, "dft.db");

const repo = path.join(scratch, "app");

const cliPath = path.resolve(import.meta.dirname, "../dist/dft-main.js");

const introDir = path.resolve(import.meta.dirname, "../assets/intro");

const git = (...args: readonly string[]) =>
  execFileSync("git", ["-C", repo, "-c", "core.hooksPath=/dev/null", ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  });

const makeRepo = () => {
  fs.mkdirSync(repo);
  git("init", "-q", "-b", "main");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "fixture");
  fs.writeFileSync(path.join(repo, "a.txt"), "app\n");
  git("add", ".");
  git("commit", "-q", "--no-gpg-sign", "-m", "init");
};

makeRepo();

process.env.DFT_CURSOR_USAGE = "off";

const cliEnv = {
  ...process.env,
  DFT_CURSOR_USAGE: "off",
  DFT_HOME: dftHome,
  HOME: scratch,
};

const runCli = (args: readonly string[]) =>
  spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repo,
    encoding: "utf-8",
    env: cliEnv,
  });

const decodeJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Unknown)
);

const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/gu;

const BRANCH_AGE =
  /(?<head>"reason":"start=[^"]*",(?:"unit":"ms",)?"value":)\d+/gu;

const normalized = (text: string): string =>
  JSON.stringify(decodeJson(text))
    .replaceAll(ISO, "<time>")
    .replaceAll(BRANCH_AGE, "$<head>0");

interface Reply {
  readonly body: string;
  readonly bytes: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly status: number;
}

const call = (
  server: LiveServer,
  target: string,
  options: {
    readonly body?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly method?: string;
  } = {}
) =>
  Effect.callback<Reply>((resume) => {
    const req = request(
      {
        headers: options.headers ?? {},
        host: "127.0.0.1",
        method: options.method ?? "GET",
        path: target,
        port: server.port,
      },
      (res) => {
        const chunks: Buffer[] = [];

        res.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        res.on("end", () => {
          const raw = Buffer.concat(chunks);

          resume(
            Effect.succeed({
              body: raw.toString("utf-8"),
              bytes: raw.length,
              headers: res.headers,
              status: res.statusCode ?? 0,
            })
          );
        });
      }
    );

    req.end(options.body);
  });

const postAction = (
  server: LiveServer,
  body: string,
  headers: Readonly<Record<string, string>>
) =>
  call(server, "/api/action", {
    body,
    headers: { "content-type": "application/json", ...headers },
    method: "POST",
  });

const own = (server: LiveServer) => ({
  origin: `http://127.0.0.1:${String(server.port)}`,
  "x-dft-token": server.token,
});

const DataReply = Schema.fromJsonString(
  Schema.Struct({ data: Schema.Unknown, view: Schema.Unknown })
);

const decodeData = Schema.decodeUnknownSync(DataReply);

const ErrorReply = Schema.fromJsonString(
  Schema.Struct({ error: Schema.String })
);

const decodeError = Schema.decodeUnknownSync(ErrorReply);

const MessageReply = Schema.fromJsonString(
  Schema.Struct({ message: Schema.String })
);

const decodeMessage = Schema.decodeUnknownSync(MessageReply);

const PlanReply = Schema.fromJsonString(
  Schema.Struct({
    confirmText: Schema.String,
    totals: Schema.Struct({ events: Schema.Number }),
  })
);

const decodePlan = Schema.decodeUnknownSync(PlanReply);

const decodeSetup = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      backups: Schema.Array(Schema.Struct({ text: Schema.String })),
    })
  )
);

const withDashboard = <A, E>(
  body: (
    server: LiveServer,
    engine: Effect.Success<ReturnType<typeof startLiveEngine>>
  ) => Effect.Effect<A, E>,
  extra: { readonly introDir?: string } = {}
) =>
  Effect.scoped(
    Effect.gen(function* run() {
      const engine = yield* startLiveEngine({
        debounceMs: 50,
        dftHome,
        home: scratch,
        signals: [],
        storePath,
      });

      yield* engine.addRepo(repo);
      yield* engine.ready;

      const costOptions = yield* costOptionsFor(dftHome);

      const server = yield* serveDashboard({
        costOptions,
        engine,
        paths: {
          dftHome,
          home: scratch,
          repo,
          store: { kind: "live", path: storePath, source: "env" },
        },
        port: 0,
        since: undefined,
        ...extra,
      });

      return yield* body(server, engine);
    })
  ).pipe(Effect.provide(NodeServices.layer));

const hook = (generation: string) =>
  runCursorHook(
    JSON.stringify({
      conversation_id: "conv-live",
      generation_id: generation,
      hook_event_name: "postToolUse",
      tool_name: "Shell",
      workspace_roots: [repo],
    }),
    repo,
    DateTime.toDateUtc(DateTime.makeUnsafe("2026-09-30T12:00:00.000Z")),
    dftHome
  );

describe("dft dashboard live server", () => {
  it.live(
    "serves the page on 127.0.0.1 with its token and no outside requests",
    () =>
      withDashboard((server) =>
        Effect.gen(function* page() {
          expect(server.url).toBe(`http://127.0.0.1:${String(server.port)}/`);

          const reply = yield* call(server, "/");

          expect(reply.status).toBe(200);
          expect(reply.body).toContain(server.token);
          expect(
            reply.body.replace(/<footer class="foot">.*?<\/footer>/u, "")
          ).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)/u);
          expect(reply.body).not.toMatch(/[–—]/u);

          const foreign = yield* call(server, "/", {
            headers: { host: "evil.example" },
          });

          expect(foreign.status).toBe(403);
        })
      )
  );

  it.live("serves the intro video files with their types and ranges", () =>
    withDashboard((server) =>
      Effect.gen(function* intro() {
        const page = yield* call(server, "/");

        expect(page.body).toContain('id="intro"');
        expect(page.body).toMatch(
          /<nav class="main">.*<button type="button" id="nav-intro">Intro<\/button><\/nav>/u
        );
        expect(page.body).toContain("/intro/dft-intro.webm?v=");
        expect(page.body).toMatch(/<video id="intro-video" muted playsinline/u);
        expect(page.headers["content-security-policy"]).toContain(
          "media-src 'self'"
        );

        for (const [name, type] of [
          ["dft-intro.webm", "video/webm"],
          ["dft-intro.mp4", "video/mp4"],
          ["dft-intro-poster.png", "image/png"],
        ] as const) {
          const reply = yield* call(server, `/intro/${name}?v=1`);

          expect(reply.status).toBe(200);
          expect(reply.headers["content-type"]).toBe(type);
          expect(reply.headers["cache-control"]).toContain("immutable");
          expect(reply.bytes).toBe(fs.statSync(path.join(introDir, name)).size);
        }

        const part = yield* call(server, "/intro/dft-intro.mp4", {
          headers: { range: "bytes=0-99" },
        });

        const { size } = fs.statSync(path.join(introDir, "dft-intro.mp4"));

        expect(part.status).toBe(206);
        expect(part.bytes).toBe(100);
        expect(part.headers["content-range"]).toBe(
          `bytes 0-99/${String(size)}`
        );

        const tail = yield* call(server, "/intro/dft-intro.mp4", {
          headers: { range: "bytes=-10" },
        });

        expect(tail.status).toBe(206);
        expect(tail.bytes).toBe(10);

        const outside = yield* call(server, "/intro/dft-intro.mp4", {
          headers: { range: `bytes=${String(size)}-` },
        });

        expect(outside.status).toBe(416);

        const other = yield* call(server, "/intro/../dft.db");

        expect(other.status).toBe(404);
      })
    )
  );

  it.live("leaves the intro out when its files are missing", () =>
    withDashboard(
      (server) =>
        Effect.gen(function* noIntro() {
          const page = yield* call(server, "/");

          expect(page.status).toBe(200);
          expect(page.body).not.toContain('id="intro"');
          expect(page.body).not.toContain('id="nav-intro"');
          expect(page.body).not.toContain("<video");

          const video = yield* call(server, "/intro/dft-intro.webm");

          expect(video.status).toBe(404);
        }),
      { introDir: path.join(scratch, "no-intro") }
    )
  );

  it.live("returns the same JSON as dft usage and dft analyze", () =>
    withDashboard((server) =>
      Effect.gen(function* json() {
        const usage = yield* call(server, "/api/usage?groupBy=tool&tz=UTC");

        expect(usage.status).toBe(200);

        const cli = runCli([
          "usage",
          "--json",
          "--no-sync",
          "--by",
          "tool",
          "--tz",
          "UTC",
        ]);

        expect(cli.status).toBe(0);
        expect(normalized(usage.body)).toBe(normalized(cli.stdout));

        const branch = yield* call(
          server,
          `/api/branch?repo=${encodeURIComponent(path.join(repo, ".git"))}&branch=main&since=all`
        );

        expect(branch.status).toBe(200);

        const analyze = runCli([
          "analyze",
          "--json",
          "--no-sync",
          "--branch",
          "main",
        ]);

        expect(analyze.status).toBe(0);
        expect(normalized(JSON.stringify(decodeData(branch.body).data))).toBe(
          normalized(analyze.stdout)
        );
      })
    )
  );

  it.live("pushes a change event after a hook file lands in the spool", () =>
    withDashboard((server) =>
      Effect.gen(function* events() {
        const received = yield* Effect.callback<string>((resume) => {
          let text = "";

          const req = request(
            {
              host: "127.0.0.1",
              path: "/events",
              port: server.port,
            },
            (res) => {
              res.on("data", (chunk: Buffer) => {
                text += chunk.toString("utf-8");

                if (text.includes(`"reason":"sync"`)) {
                  req.destroy();
                  resume(Effect.succeed(text));
                }
              });
            }
          );

          req.end(() => {
            expect(hook("gen-live-1").outcome.state).toBe("spooled");
          });
        }).pipe(Effect.timeout("10 seconds"));

        expect(received).toContain('"reason":"sync"');
        expect(received).toContain(`"repo":${JSON.stringify(repo)}`);
      })
    )
  );

  it.live("rejects actions without the token or from another origin", () =>
    withDashboard((server) =>
      Effect.gen(function* guard() {
        const body = JSON.stringify({ action: "usage", enabled: false });

        const noToken = yield* postAction(server, body, {
          origin: own(server).origin,
        });

        expect(noToken.status).toBe(403);

        const foreign = yield* postAction(server, body, {
          origin: "http://evil.example",
          "x-dft-token": server.token,
        });

        expect(foreign.status).toBe(403);

        const noOrigin = yield* postAction(server, body, {
          "x-dft-token": server.token,
        });

        expect(noOrigin.status).toBe(403);

        const viaGet = yield* call(server, "/api/action");

        expect(viaGet.status).toBe(404);

        const allowed = yield* postAction(server, body, own(server));

        expect(allowed.status).toBe(200);
        expect(decodeMessage(allowed.body).message).toBe(
          "Cursor usage import is off."
        );
      })
    )
  );

  it.live(
    "deletes a repo's data only with the exact confirmation and keeps a backup",
    () =>
      withDashboard((server) =>
        Effect.gen(function* remove() {
          const planned = yield* call(
            server,
            `/api/plan?kind=delete&repo=${encodeURIComponent(repo)}`
          );

          const plan = decodePlan(planned.body);

          expect(plan.confirmText).toBe("app");
          expect(plan.totals.events).toBeGreaterThan(0);

          const wrong = yield* postAction(
            server,
            JSON.stringify({ action: "delete", confirm: "App", path: repo }),
            own(server)
          );

          expect(wrong.status).toBe(400);
          expect(decodeError(wrong.body).error).not.toBe("");
          expect(fs.existsSync(path.join(dftHome, "backups"))).toBe(false);

          const done = yield* postAction(
            server,
            JSON.stringify({ action: "delete", confirm: "app", path: repo }),
            own(server)
          );

          expect(done.status).toBe(200);
          expect(decodeMessage(done.body).message).toMatch(
            /Backup \S+ can restore/u
          );

          const setup = decodeSetup((yield* call(server, "/api/setup")).body);

          expect(setup.backups).toHaveLength(1);
          expect(setup.backups[0]?.text).toContain("before delete of app");

          const after = decodePlan(
            (yield* call(
              server,
              `/api/plan?kind=delete&repo=${encodeURIComponent(repo)}`
            )).body
          );

          expect(after.totals.events).toBe(0);
        })
      )
  );
});

const UsageReply = Schema.fromJsonString(
  Schema.Struct({
    contractVersion: Schema.Literal("dx.usage.v1"),
    groupBy: Schema.NullOr(Schema.String),
    metrics: Schema.Array(Schema.String),
    window: Schema.Struct({ tz: Schema.String }),
  })
);

const decodeUsage = Schema.decodeUnknownSync(UsageReply);

describe("dft dashboard usage endpoint", () => {
  it.live("answers GET /api/usage with the dx_usage query contract", () =>
    withDashboard((server) =>
      Effect.gen(function* usage() {
        const reply = yield* call(
          server,
          "/api/usage?groupBy=tool&tz=UTC&metrics=tokens,requests&tool=codex&tool=pi"
        );

        expect(reply.status).toBe(200);
        expect(decodeUsage(reply.body)).toMatchObject({
          groupBy: "tool",
          metrics: ["tokens", "requests"],
          window: { tz: "UTC" },
        });

        const zone = yield* call(server, "/api/usage?tz=Mars/Olympus");

        expect(zone.status).toBe(400);
        expect(decodeError(zone.body).error).toContain("Mars/Olympus");

        const dimension = yield* call(server, "/api/usage?groupBy=color");

        expect(dimension.status).toBe(400);
      })
    )
  );
});

const PageQueryReply = Schema.fromJsonString(
  Schema.Struct({
    groupBy: Schema.NullOr(Schema.String),
    limit: Schema.Int,
    metrics: Schema.Array(Schema.String),
    sortBy: Schema.String,
    stackBy: Schema.NullOr(Schema.String),
  })
);

const decodePageQuery = Schema.decodeUnknownSync(PageQueryReply);

const SetupTools = Schema.fromJsonString(
  Schema.Struct({
    sources: Schema.Struct({
      facts: Schema.Int,
      tools: Schema.Array(Schema.Struct({ tool: Schema.String })),
    }),
    tools: Schema.Array(
      Schema.Struct({
        capture: Schema.Array(Schema.String),
        installed: Schema.Boolean,
        tool: Schema.String,
      })
    ),
  })
);

const decodeSetupTools = Schema.decodeUnknownSync(SetupTools);

const BranchUsage = Schema.fromJsonString(
  Schema.Struct({
    view: Schema.Struct({
      summary: Schema.Array(Schema.Struct({ label: Schema.String })),
      usage: Schema.Struct({
        models: Schema.Struct({ groupBy: Schema.NullOr(Schema.String) }),
        tools: Schema.Struct({ groupBy: Schema.NullOr(Schema.String) }),
      }),
    }),
  })
);

const decodeBranchUsage = Schema.decodeUnknownSync(BranchUsage);

describe("dft dashboard page queries", () => {
  const kit = dashboardStateKit();

  const state: UsageViewState = {
    by: "model",
    filters: [
      ["tool", "cursor"],
      ["tool", "codex"],
      ["repo", path.join(repo, ".git")],
    ],
    metric: "toolFigure",
    since: "2026-09-01",
    until: "2026-10-01",
  };

  it.live(
    "answers every query the page builds with the shape it asks for",
    () =>
      withDashboard((server) =>
        Effect.gen(function* queries() {
          const table = yield* call(
            server,
            `/api/usage?${kit.tableQuery(state, "UTC")}`
          );

          expect(table.status).toBe(200);
          expect(decodePageQuery(table.body)).toMatchObject({
            groupBy: "model",
            limit: 25,
            sortBy: "toolFigure",
          });

          const chart = decodePageQuery(
            (yield* call(server, `/api/usage?${kit.chartQuery(state, "UTC")}`))
              .body
          );

          expect(chart).toMatchObject({
            groupBy: null,
            limit: 6,
            metrics: ["toolFigure"],
            stackBy: "model",
          });

          const facet = decodePageQuery(
            (yield* call(
              server,
              `/api/usage?${kit.facetQuery(state, "UTC", "tool")}`
            )).body
          );

          expect(facet.groupBy).toBe("tool");

          const daily = yield* call(
            server,
            `/api/usage?${kit.tableQuery({ ...state, by: "day", since: "all" }, "UTC")}`
          );

          expect(daily.status).toBe(200);

          const bad = yield* call(
            server,
            `/api/usage?${kit.tableQuery({ ...state, since: "someday" }, "UTC")}`
          );

          expect(bad.status).toBe(400);
          expect(decodeError(bad.body).error).toContain("someday");
        })
      )
  );

  it.live("lists every tool and the sources panel on the setup screen", () =>
    withDashboard((server) =>
      Effect.gen(function* setup() {
        const reply = decodeSetupTools(
          (yield* call(server, "/api/setup")).body
        );

        expect(reply.tools.map((tool) => tool.tool).toSorted()).toEqual(
          [
            "claude-code",
            "codex",
            "cursor",
            "deepseek",
            "omp",
            "opencode",
            "pi",
          ].toSorted()
        );
        expect(reply.tools.every((tool) => !tool.installed)).toBe(true);
        expect(reply.sources.facts).toBe(0);
      })
    )
  );

  it.live("gives the branch screen its usage by tool and by model", () =>
    withDashboard((server) =>
      Effect.gen(function* branch() {
        const reply = yield* call(
          server,
          `/api/branch?repo=${encodeURIComponent(path.join(repo, ".git"))}&branch=main&since=all&tz=UTC&tool=cursor`
        );

        expect(reply.status).toBe(200);

        const { view } = decodeBranchUsage(reply.body);

        expect(view.usage.tools.groupBy).toBe("tool");
        expect(view.usage.models.groupBy).toBe("model");
        expect(view.summary.map((tile) => tile.label)).toEqual([
          "Agent time",
          "Chats",
          "Commits",
          "Status",
        ]);
      })
    )
  );
});

describe("dft dashboard --one-time", () => {
  it("still writes the static page and exits", () => {
    const out = path.join(scratch, "static.html");

    const result = runCli([
      "dashboard",
      "--one-time",
      "--no-open",
      "--no-sync",
      "--out",
      out,
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Dashboard saved: ${out}`);

    const html = fs.readFileSync(out, "utf-8");

    expect(html).toContain("AI usage and cost");
    expect(html).toContain("Estimate per day, by tool");
    expect(html).not.toMatch(/[–—]/u);
    expect(html).not.toContain("dft-intro");
    expect(html).not.toContain("<video");
  });
});

const storedRequests = (requestKey: string): number => {
  const db = new DatabaseSync(storePath, { readOnly: true });

  try {
    return db
      .prepare(
        "SELECT event_id FROM events WHERE json_extract(body, '$.usage.requestKey') = ?"
      )
      .all(requestKey).length;
  } finally {
    db.close();
  }
};

describe("dft dashboard OpenTelemetry receiver", () => {
  it.live(
    "stores each OTLP request once and refuses browser posts and junk",
    () =>
      withDashboard((server) =>
        Effect.gen(function* receiver() {
          const body = claudeLogsJson("req_dashboard_1");
          const headers = { "content-type": "application/json" };
          const post = { body, headers, method: "POST" };
          const first = yield* call(server, "/v1/logs", post);

          expect(first.status).toBe(200);

          const again = yield* call(server, "/v1/logs", post);

          expect(again.status).toBe(200);
          expect(storedRequests("req_dashboard_1")).toBe(1);

          const metrics = yield* call(server, "/v1/metrics", {
            ...post,
            body: "{}",
          });

          expect(metrics.status).toBe(200);

          const browser = yield* call(server, "/v1/logs", {
            body: claudeLogsJson("req_dashboard_2"),
            headers: { ...headers, origin: "http://evil.example" },
            method: "POST",
          });

          expect(browser.status).toBe(403);
          expect(storedRequests("req_dashboard_2")).toBe(0);

          const junk = yield* call(server, "/v1/logs", {
            ...post,
            body: "not otlp",
          });

          expect(junk.status).toBe(400);
        })
      )
  );
});
