// @effect-diagnostics nodeBuiltinImport:off asyncFunction:off newPromise:off globalTimers:off -- The live dashboard test scripts a throwaway git repo and DFT_HOME, talks to the real node:http server and spawns the built dft binary to compare its JSON.
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { request } from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { NodeServices } from "@effect/platform-node";
import { afterAll, describe, expect, it } from "@effect/vitest";
import {
  OperationOutputSchema,
  OperationPlanSchema,
  runCursorHook,
  startLiveEngine,
} from "@rat-stack/core/dx";
import { Clock, DateTime, Effect, Predicate, Schema } from "effect";

import { DashboardOperationReviewSchema } from "../src/dft-agent-live-bridge.js";
import { dashboardStateKit } from "../src/dft-dashboard-state.js";
import type { UsageViewState } from "../src/dft-dashboard-state.js";
import { branchUsageQuery, serveDashboard } from "../src/dft-live.js";
import type { LiveServer } from "../src/dft-live.js";
import { MAX_OTLP_BODY } from "../src/dft-otlp.js";
import { costSessionFor } from "../src/dft-session.js";
import { claudeLogsJson, gzip } from "./otlp-payloads.js";

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

const decodeReport = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
);

const decodeNotes = Schema.decodeUnknownSync(
  Schema.Struct({ notes: Schema.Array(Schema.String) })
);

const withoutPersistNote = (text: string): string => {
  const report = decodeReport(text);

  return JSON.stringify({
    ...report,
    notes: decodeNotes(report).notes.filter(
      (note) => !note.startsWith("Persisted snapshot metadata")
    ),
  });
};

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
    readonly body?: string | Uint8Array;
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

const decodeReceipt = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ receipt: OperationOutputSchema.members[1].fields.receipt })
  )
);

const ReviewedPlanReply = Schema.Struct({
  confirmText: Schema.String,
  review: DashboardOperationReviewSchema,
});

const decodeReviewedPlan = Schema.decodeUnknownSync(
  Schema.fromJsonString(ReviewedPlanReply)
);

const PlanReply = Schema.fromJsonString(
  Schema.Struct({
    ...ReviewedPlanReply.fields,
    totals: Schema.Struct({ events: Schema.Number }),
  })
);

const decodePlan = Schema.decodeUnknownSync(PlanReply);

const decodeExportPlan = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      ...ReviewedPlanReply.fields,
      basisId: Schema.String,
      context: Schema.Struct({ basisId: Schema.NullOr(Schema.String) }),
      destination: Schema.String,
      idempotencyKey: Schema.String,
      plan: OperationPlanSchema,
    })
  )
);

const decodeOperationGet = Schema.decodeUnknownSync(
  Schema.fromJsonString(OperationOutputSchema.members[2])
);

const exportDirectory = path.join(repo, ".dft", "exports");

const exportSnapshot = () =>
  fs.existsSync(exportDirectory)
    ? fs
        .readdirSync(exportDirectory)
        .toSorted()
        .map((name) => ({
          body: fs.readFileSync(path.join(exportDirectory, name), "utf-8"),
          name,
        }))
    : [];

const decodeSetup = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      backups: Schema.Array(
        Schema.Struct({ id: Schema.String, text: Schema.String })
      ),
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

      const priced = yield* costSessionFor(dftHome);

      const server = yield* serveDashboard({
        costOptions: priced.costOptions,
        engine,
        paths: {
          dftHome,
          home: scratch,
          repo,
          store: { kind: "live", path: storePath, source: "env" },
        },
        port: 0,
        prices: priced.prices,
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

class SseFixtureError extends Schema.TaggedError<SseFixtureError>()(
  "SseFixtureError",
  {
    message: Schema.String,
    stage: Schema.Literals(["request", "response", "closed", "hook"]),
  }
) {}

interface SseFixturePhases {
  changeEventHeaders: number;
  engineChanges: number;
  engineSyncAtMs: number | null;
  engineSyncChanges: number;
  engineSyncInserted: number | null;
  helloAtMs: number | null;
  hookCompletedAtMs: number | null;
  hookOutcome: "not-invoked" | "recorded" | "spooled" | "skipped";
  hookReason: string | null;
  hookStartedAtMs: number | null;
  responseAtMs: number | null;
  responseBytes: number;
  responseChunks: number;
  responseStatus: number | null;
  spoolPath: string | null;
  syncTextAtMs: number | null;
}

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
          normalized(withoutPersistNote(analyze.stdout))
        );
      })
    )
  );

  it.live("pushes a change event after a hook file lands in the spool", () =>
    withDashboard((server, engine) =>
      Effect.gen(function* events() {
        const clock = yield* Clock.Clock;
        const baseline = yield* engine.status;
        const started = clock.monotonicTimeNanosUnsafe();

        const elapsedMs = () =>
          Number(clock.monotonicTimeNanosUnsafe() - started) / 1_000_000;

        const phases: SseFixturePhases = {
          changeEventHeaders: 0,
          engineChanges: 0,
          engineSyncAtMs: null,
          engineSyncChanges: 0,
          engineSyncInserted: null,
          helloAtMs: null,
          hookCompletedAtMs: null,
          hookOutcome: "not-invoked",
          hookReason: null,
          hookStartedAtMs: null,
          responseAtMs: null,
          responseBytes: 0,
          responseChunks: 0,
          responseStatus: null,
          spoolPath: null,
          syncTextAtMs: null,
        };

        const received = yield* Effect.acquireUseRelease(
          Effect.sync(() =>
            engine.subscribe((change) => {
              phases.engineChanges += 1;

              if (change.reason === "sync" && change.repo === repo) {
                phases.engineSyncChanges += 1;
                phases.engineSyncAtMs = elapsedMs();
                phases.engineSyncInserted = change.inserted;
              }
            })
          ),
          () =>
            Effect.callback<string, SseFixtureError>((resume) => {
              let text = "";
              let wroteHook = false;
              let finished = false;

              const req = request({
                host: "127.0.0.1",
                path: "/events",
                port: server.port,
              });

              const finish = (
                result: Effect.Effect<string, SseFixtureError>
              ) => {
                if (finished) {
                  return;
                }

                finished = true;
                req.destroy();
                resume(result);
              };

              const fail = (
                stage: SseFixtureError["stage"],
                message: string
              ) => {
                finish(Effect.fail(new SseFixtureError({ message, stage })));
              };

              req.once("error", (error) => {
                fail("request", error.message);
              });
              req.once("response", (res) => {
                phases.responseAtMs = elapsedMs();
                phases.responseStatus = res.statusCode ?? null;
                res.once("error", (error) => {
                  fail("response", error.message);
                });
                res.once("aborted", () => {
                  fail("closed", "SSE response aborted before the sync event.");
                });
                res.once("end", () => {
                  fail("closed", "SSE response ended before the sync event.");
                });
                res.once("close", () => {
                  fail("closed", "SSE response closed before the sync event.");
                });
                res.on("data", (chunk: Buffer) => {
                  if (finished) {
                    return;
                  }

                  phases.responseChunks += 1;
                  phases.responseBytes += chunk.length;
                  text += chunk.toString("utf-8");

                  if (!wroteHook) {
                    if (!text.includes("event: hello\ndata: {}\n\n")) {
                      return;
                    }

                    wroteHook = true;
                    phases.helloAtMs = elapsedMs();
                    text = "";
                    phases.hookStartedAtMs = elapsedMs();

                    try {
                      const { outcome } = hook("gen-live-1");

                      phases.hookCompletedAtMs = elapsedMs();
                      phases.hookOutcome = outcome.state;

                      if (outcome.state === "skipped") {
                        phases.hookReason = outcome.reason;
                      } else {
                        phases.spoolPath = outcome.path;
                      }

                      expect(outcome.state).toBe("spooled");
                    } catch (error) {
                      phases.hookCompletedAtMs = elapsedMs();
                      fail(
                        "hook",
                        error instanceof Error ? error.message : String(error)
                      );
                    }

                    return;
                  }

                  phases.changeEventHeaders = [
                    ...text.matchAll(/event: change\n/gu),
                  ].length;

                  if (text.includes(`"reason":"sync"`)) {
                    phases.syncTextAtMs = elapsedMs();
                    finish(Effect.succeed(text));
                  }
                });
              });
              req.end();

              return Effect.sync(() => {
                finished = true;
                req.destroy();
              });
            }).pipe(
              Effect.timeout("10 seconds"),
              Effect.tapError((error) =>
                Effect.gen(function* evidence() {
                  const failedAtMs = elapsedMs();
                  const observed = { ...phases };
                  const status = yield* engine.status;

                  const before = baseline.repos.find(
                    (entry) => entry.repo === repo
                  );

                  const current = status.repos.find(
                    (entry) => entry.repo === repo
                  );

                  yield* Effect.logError(
                    "SSE fixture failure phase evidence",
                    JSON.stringify({
                      acquisitionBudget: {
                        reason:
                          "LiveStatus does not expose operation budget snapshots.",
                        state: "unavailable",
                      },
                      acquisitionReceipts: {
                        reason:
                          "LiveStatus does not expose acquisition receipt handles.",
                        state: "unavailable",
                      },
                      baseline:
                        before === undefined
                          ? null
                          : {
                              lastInserted: before.lastInserted,
                              lastSyncAt: before.lastSyncAt,
                              syncs: before.syncs,
                            },
                      engine: {
                        repository:
                          current === undefined
                            ? null
                            : {
                                lastError: current.lastError,
                                lastInserted: current.lastInserted,
                                lastSyncAt: current.lastSyncAt,
                                sources: current.sources.map((source) => ({
                                  duplicates: source.duplicates,
                                  eventsRead: source.eventsRead ?? null,
                                  inserted: source.inserted,
                                  reason: source.reason,
                                  recordsRead: source.recordsRead ?? null,
                                  rejected: source.rejected ?? null,
                                  source: source.source,
                                  state: source.state ?? null,
                                  status: source.status,
                                  unavailableReasons:
                                    source.unavailableReasons ?? null,
                                  unsettled: source.unsettled ?? null,
                                })),
                                syncing: current.syncing,
                                syncs: current.syncs,
                              },
                        running: status.running,
                      },
                      failedAtMs,
                      failureStage: Predicate.isTagged(error, "SseFixtureError")
                        ? error.stage
                        : "timeout",
                      failureTag: error._tag,
                      phases: observed,
                      sourceCountersUnavailableReason:
                        "Null or absent counters were not reported by LiveStatus.",
                      statusReadAtMs: elapsedMs(),
                    })
                  );
                })
              )
            ),
          (unsubscribe) => Effect.sync(unsubscribe)
        );

        expect(received).toContain('"reason":"sync"');
        expect(received).toContain(`"repo":${JSON.stringify(repo)}`);
      })
    )
  );

  it.live("guards actions and operation reviews with the dashboard token", () =>
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

        const planWithoutToken = yield* call(server, "/api/plan?kind=reset", {
          headers: { origin: own(server).origin },
        });

        expect(planWithoutToken.status).toBe(403);

        const foreignPlan = yield* call(server, "/api/plan?kind=reset", {
          headers: {
            origin: "http://evil.example",
            "x-dft-token": server.token,
          },
        });

        expect(foreignPlan.status).toBe(403);

        const trustedPlan = yield* call(server, "/api/plan?kind=reset", {
          headers: { "x-dft-token": server.token },
        });

        expect(trustedPlan.status).toBe(200);
        expect(decodeReviewedPlan(trustedPlan.body).review.kind).toBe("reset");

        const allowed = yield* postAction(server, body, own(server));

        expect(allowed.status).toBe(200);
        expect(decodeMessage(allowed.body).message).toBe(
          "Cursor usage import is off."
        );
      })
    )
  );

  it.live(
    "previews metadata exports without artifacts and rejects foreign reviews or replacement destinations",
    () =>
      withDashboard((server) =>
        Effect.gen(function* reviewExport() {
          const before = exportSnapshot();

          const unauthenticated = yield* call(server, "/api/plan?kind=export");

          expect(unauthenticated.status).toBe(403);

          const foreignOrigin = yield* call(server, "/api/plan?kind=export", {
            headers: { ...own(server), origin: "http://evil.example" },
          });

          expect(foreignOrigin.status).toBe(403);

          const planned = yield* call(server, "/api/plan?kind=export", {
            headers: own(server),
          });

          expect(planned.status).toBe(200);
          const preview = decodeExportPlan(planned.body);

          expect(preview.review.kind).toBe("export");
          expect(preview.plan.arguments).toMatchObject({
            basisId: preview.basisId,
            destination: preview.destination,
            disclosure: "metadata-only",
            kind: "export",
          });
          expect(preview.context.basisId).toBe(preview.basisId);
          expect(preview.idempotencyKey).toBe(
            `dashboard:export:${preview.plan.id}`
          );
          expect(preview.confirmText).toBe(
            `EXPORT METADATA ${preview.plan.consent.scopeDigest}`
          );
          expect(path.dirname(preview.destination)).toBe(exportDirectory);
          expect(fs.existsSync(preview.destination)).toBe(false);
          expect(exportSnapshot()).toEqual(before);

          const body = {
            action: "export",
            confirm: preview.confirmText,
            idempotencyKey: preview.idempotencyKey,
            review: preview.review,
          };

          const foreignDestination = path.join(scratch, "foreign-export.json");

          const replacement = yield* postAction(
            server,
            JSON.stringify({ ...body, path: foreignDestination }),
            own(server)
          );

          expect(replacement.status).toBe(400);
          expect(decodeError(replacement.body).error).toContain(
            "destination retained in their review"
          );

          const foreignReview = yield* postAction(
            server,
            JSON.stringify({
              ...body,
              review: {
                ...preview.review,
                expectedDigest: "foreign-reviewed-digest",
              },
            }),
            own(server)
          );

          expect(foreignReview.status).toBe(409);
          expect(decodeError(foreignReview.body).error).toContain(
            "does not match the retained operation plan"
          );
          expect(fs.existsSync(foreignDestination)).toBe(false);
          expect(fs.existsSync(preview.destination)).toBe(false);
          expect(exportSnapshot()).toEqual(before);
        })
      )
  );

  it.live(
    "recovers an ignored export reply with the same review and key and returns its fixed plan through the shared API",
    () =>
      withDashboard((server) =>
        Effect.gen(function* recoverExport() {
          const before = exportSnapshot();

          const planned = yield* call(server, "/api/plan?kind=export", {
            headers: own(server),
          });

          expect(planned.status).toBe(200);
          const preview = decodeExportPlan(planned.body);

          const body = JSON.stringify({
            action: "export",
            confirm: preview.confirmText,
            idempotencyKey: preview.idempotencyKey,
            review: preview.review,
          });

          yield* postAction(server, body, own(server));

          const afterIgnoredReply = exportSnapshot();

          expect(afterIgnoredReply.map((file) => file.name)).toEqual(
            [
              ...before.map((file) => file.name),
              path.basename(preview.destination),
            ].toSorted()
          );
          expect(fs.existsSync(preview.destination)).toBe(true);

          const retried = yield* postAction(server, body, own(server));

          expect(retried.status).toBe(200);
          const { receipt } = decodeReceipt(retried.body);

          expect(receipt).toMatchObject({
            executionState: "succeeded",
            idempotencyKey: preview.idempotencyKey,
            planDigest: preview.plan.planDigest,
            planId: preview.plan.id,
            verificationState: "verified",
          });
          expect(receipt.effects.exportArtifacts).toEqual([
            expect.objectContaining({
              basisId: preview.basisId,
              destination: preview.destination,
              disclosure: "metadata-only",
            }),
          ]);
          expect(receipt.effects.exports).toEqual([preview.destination]);
          expect(exportSnapshot()).toEqual(afterIgnoredReply);

          const repeated = yield* postAction(server, body, own(server));

          expect(repeated.status).toBe(200);
          expect(decodeReceipt(repeated.body).receipt).toMatchObject({
            id: receipt.id,
            idempotencyKey: receipt.idempotencyKey,
            planId: receipt.planId,
          });

          const changedKey = yield* postAction(
            server,
            JSON.stringify({
              action: "export",
              confirm: preview.confirmText,
              idempotencyKey: `${preview.idempotencyKey}-different`,
              review: preview.review,
            }),
            own(server)
          );

          expect(changedKey.status).toBe(409);
          expect(exportSnapshot()).toEqual(afterIgnoredReply);

          const recovered = yield* call(
            server,
            "/api/agent?capability=dx_operation",
            {
              body: JSON.stringify({
                request: {
                  action: "get",
                  operation: {
                    id: receipt.id,
                    storeGeneration: receipt.storeGeneration,
                    storeId: receipt.storeId,
                  },
                },
              }),
              headers: { "content-type": "application/json", ...own(server) },
              method: "POST",
            }
          );

          expect(recovered.status).toBe(200);
          const retained = decodeOperationGet(recovered.body);

          expect(retained.receipt.id).toBe(receipt.id);
          expect(retained.receipt.idempotencyKey).toBe(preview.idempotencyKey);
          expect(retained.receipt.effects.exportArtifacts).toEqual(
            receipt.effects.exportArtifacts
          );
          expect(retained.reviewedPlan).toEqual(preview.plan);
          expect(retained.reviewedPlanUnavailableReason).toBeNull();
          expect(exportSnapshot()).toEqual(afterIgnoredReply);
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
            `/api/plan?kind=delete&repo=${encodeURIComponent(repo)}`,
            { headers: { "x-dft-token": server.token } }
          );

          expect(planned.status).toBe(200);

          const plan = decodePlan(planned.body);

          expect(plan.confirmText).toBe("app");
          expect(plan.totals.events).toBeGreaterThan(0);

          const mismatchedDelete = yield* postAction(
            server,
            JSON.stringify({
              action: "delete",
              confirm: plan.confirmText,
              path: scratch,
              review: plan.review,
            }),
            own(server)
          );

          expect(mismatchedDelete.status).toBe(409);
          expect(decodeError(mismatchedDelete.body).error).toContain(
            "selected target does not match"
          );
          expect(fs.existsSync(path.join(dftHome, "backups"))).toBe(false);

          const wrong = yield* postAction(
            server,
            JSON.stringify({ action: "delete", confirm: "App", path: repo }),
            own(server)
          );

          expect(wrong.status).toBe(400);
          expect(decodeError(wrong.body).error).not.toBe("");
          expect(fs.existsSync(path.join(dftHome, "backups"))).toBe(false);

          const reviewedDelete = JSON.stringify({
            action: "delete",
            confirm: plan.confirmText,
            path: repo,
            review: plan.review,
          });

          const done = yield* postAction(server, reviewedDelete, own(server));

          expect(done.status).toBe(200);
          expect(decodeMessage(done.body).message).toMatch(
            /Backup \S+ can restore/u
          );

          const replayed = yield* postAction(
            server,
            reviewedDelete,
            own(server)
          );

          expect(replayed.status).toBe(200);
          expect(decodeReceipt(replayed.body).receipt.id).toBe(
            decodeReceipt(done.body).receipt.id
          );

          const setup = decodeSetup((yield* call(server, "/api/setup")).body);

          expect(setup.backups).toHaveLength(1);
          expect(setup.backups[0]?.text).toContain("before delete of app");

          for (const backup of setup.backups) {
            const restoreReview = yield* call(
              server,
              `/api/plan?kind=restore&backup=${encodeURIComponent(backup.id)}`,
              { headers: { "x-dft-token": server.token } }
            );

            expect(restoreReview.status).toBe(200);

            const restorePlan = decodeReviewedPlan(restoreReview.body);

            const mismatchedRestore = yield* postAction(
              server,
              JSON.stringify({
                action: "restore",
                confirm: restorePlan.confirmText,
                id: `${backup.id}-different`,
                review: restorePlan.review,
              }),
              own(server)
            );

            expect(mismatchedRestore.status).toBe(409);
            expect(decodeError(mismatchedRestore.body).error).toContain(
              "selected target does not match"
            );
          }

          const unchanged = decodeSetup(
            (yield* call(server, "/api/setup")).body
          );

          expect(unchanged.backups).toHaveLength(1);

          const after = decodePlan(
            (yield* call(
              server,
              `/api/plan?kind=delete&repo=${encodeURIComponent(repo)}`,
              { headers: { "x-dft-token": server.token } }
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
      requests: Schema.Int,
      tools: Schema.Array(Schema.Struct({ tool: Schema.String })),
    }),
    tools: Schema.Array(
      Schema.Struct({
        capture: Schema.Array(Schema.String),
        installed: Schema.Boolean,
        tool: Schema.String,
      })
    ),
    usage: Schema.Struct({
      enabled: Schema.Boolean,
      locked: Schema.Boolean,
      note: Schema.String,
    }),
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
        expect(reply.sources.requests).toBe(0);
        expect(reply.usage.enabled).toBe(false);
        expect(reply.usage.locked).toBe(true);
        expect(reply.usage.note).toContain("DFT_CURSOR_USAGE=off");
      })
    )
  );

  it("asks for a branch's tiles and models with only its repo, branch and window", () => {
    const params = branchUsageQuery(
      new URL(
        "http://127.0.0.1/api/branch?repo=%2Fw%2Fapp%2F.git&branch=main&since=all&tz=UTC&tool=claude-code&model=claude-sonnet-5&provider=anthropic"
      ),
      "model",
      "7d"
    );

    expect(Object.fromEntries(params)).toEqual({
      branch: "main",
      groupBy: "model",
      limit: "12",
      metrics: "tokens,requests,estimate,toolFigure,billed",
      repo: "/w/app/.git",
      since: "7d",
      sortBy: "tokens",
      tz: "UTC",
    });
  });

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

const storedSnapshots = (): number => {
  const db = new DatabaseSync(storePath, { readOnly: true });

  try {
    return db.prepare("SELECT snapshot_id FROM snapshots").all().length;
  } finally {
    db.close();
  }
};

describe("dft dashboard branch view", () => {
  it.live("stores no report when a branch page is viewed", () =>
    withDashboard((server) =>
      Effect.gen(function* readOnlyBranch() {
        const before = storedSnapshots();
        const target = `/api/branch?repo=${encodeURIComponent(path.join(repo, ".git"))}&branch=main&since=30d`;

        for (const _ of [1, 2, 3]) {
          const branch = yield* call(server, target);

          expect(branch.status).toBe(200);
        }

        expect(storedSnapshots()).toBe(before);
      })
    )
  );
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

  it.live(
    "refuses a small gzip body that inflates past the size limit and keeps serving",
    () =>
      withDashboard((server) =>
        Effect.gen(function* inflated() {
          const bomb = gzip(new Uint8Array(MAX_OTLP_BODY * 2));

          expect(bomb.byteLength).toBeLessThan(MAX_OTLP_BODY / 100);

          const refused = yield* call(server, "/v1/logs", {
            body: bomb,
            headers: {
              "content-encoding": "gzip",
              "content-type": "application/x-protobuf",
            },
            method: "POST",
          });

          expect(refused.status).toBe(413);

          const after = yield* call(server, "/v1/logs", {
            body: claudeLogsJson("req_dashboard_after_bomb"),
            headers: { "content-type": "application/json" },
            method: "POST",
          });

          expect(after.status).toBe(200);
          expect(storedRequests("req_dashboard_after_bomb")).toBe(1);
        })
      )
  );
});
