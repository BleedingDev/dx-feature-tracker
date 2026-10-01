import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { branchNameOrNull } from "../../src/dx/correlation/attribution/branch-name.js";
import {
  makeRepoLocator,
  repoLocator,
} from "../../src/dx/correlation/attribution/locator.js";
import type { PathKind } from "../../src/dx/correlation/attribution/locator.js";
import {
  NO_REPO_PROJECT,
  attributeRepos,
} from "../../src/dx/correlation/attribution/repos.js";
import { touchedPaths } from "../../src/dx/correlation/attribution/touched-paths.js";
import { attributeHistoricalBranches } from "../../src/dx/correlation/branch-at-time/attribute.js";
import type { WorktreeTimeline } from "../../src/dx/correlation/branch-at-time/timeline.js";
import { GitRunner, memoryGitAt } from "../../src/dx/harness/git.js";
import type { GitQueries, MemoryRepo } from "../../src/dx/harness/git.js";
import type { BranchSource } from "../../src/dx/harness/ids.js";
import { estimateRequest } from "../../src/dx/metrics/cost/price-book/estimate.js";
import type { PriceSheet } from "../../src/dx/metrics/cost/price-book/sheet.js";
import { unknownTokens } from "../../src/dx/model/attribution.js";
import type { AiAttribution } from "../../src/dx/model/attribution.js";
import type { DxEventEnvelope } from "../../src/dx/model/event.js";
import {
  emptyEventIdentity,
  emptyFlightContext,
} from "../../src/dx/model/event.js";
import { EventIdSchema } from "../../src/dx/model/ids.js";
import { deriveUsageFacts } from "../../src/dx/usage/derive.js";
import { pricedRequestOf } from "../../src/dx/usage/estimate.js";

const HOME = "/home/user";

const ORCHESTRATOR = `${HOME}/scratch`;

const APP = `${HOME}/scratch/app`;

const APP_GIT = `${APP}/.git`;

const APP_TWO = `${HOME}/scratch/app-two`;

const LIB = `${HOME}/scratch/lib`;

const LIB_GIT = `${LIB}/.git`;

const REPOS: readonly MemoryRepo[] = [
  {
    repoCommonDir: APP_GIT,
    worktrees: [
      { branch: "main", headSha: null, path: APP },
      { branch: "feature/two", headSha: null, path: APP_TWO },
    ],
  },
  {
    repoCommonDir: LIB_GIT,
    worktrees: [{ branch: "main", headSha: null, path: LIB }],
  },
];

const AT = "2026-10-01T10:00:00.000Z";

const FIXTURE_SHEET: PriceSheet = {
  id: "fixture",
  models: {
    "fixture-model": [{ effectiveFrom: null, rates: { input: 1, output: 5 } }],
  },
  source: "synthetic prices for tests",
  version: "2026-10-01",
};

interface Spec {
  readonly agentId?: string | null;
  readonly at?: string;
  readonly branch?: string | null;
  readonly branchSource?: BranchSource;
  readonly context?: Partial<DxEventEnvelope["context"]>;
  readonly cwd: string;
  readonly id: string;
  readonly parentSessionId?: string | null;
  readonly sessionId?: string;
  readonly tokens?: number;
  readonly touched?: readonly string[];
  readonly turnId?: string | null;
}

const baseAi = (spec: Spec): AiAttribution => ({
  agentId: spec.agentId ?? null,
  agentType: spec.agentId === undefined ? null : "general-purpose",
  branchSource: spec.branchSource ?? "cwd-inferred",
  channel: "session-file",
  cwd: spec.cwd,
  effort: null,
  effortSource: null,
  harness: "claude-code",
  harnessVersion: null,
  model: "fixture-model",
  modelRaw: "fixture-model",
  parentSessionId: spec.parentSessionId ?? null,
  provider: "anthropic",
  sessionId: spec.sessionId ?? "orchestrator",
  via: null,
});

const aiOf = (spec: Spec): AiAttribution => {
  const ai = baseAi(spec);

  return spec.touched === undefined
    ? ai
    : { ...ai, touchedPaths: spec.touched };
};

const event = (spec: Spec): DxEventEnvelope => ({
  acquisition: "file-import",
  adapterId: "harness.claude-code",
  adapterVersion: "0.2.0",
  ai: aiOf(spec),
  context: {
    ...emptyFlightContext,
    branch: spec.branch ?? null,
    ...spec.context,
  },
  eventId: EventIdSchema.make(spec.id),
  evidence: { bounded: true, hash: null, ref: `fixture:${spec.id}` },
  fieldSemantics: [],
  identity: {
    ...emptyEventIdentity,
    requestId: `req-${spec.id}`,
    sessionId: spec.sessionId ?? "orchestrator",
    turnId: spec.turnId ?? null,
  },
  kind: "ai.usage",
  observedAt: spec.at ?? AT,
  occurredAt: spec.at ?? AT,
  occurredAtPrecision: "exact",
  origin: "fixture",
  payload: {},
  schemaVersion: "dx.event.v2",
  sourceVersion: null,
  upstreamKey: spec.id,
  usage: {
    premiumRequests: null,
    requestKey: `request:${spec.id}`,
    serviceTier: null,
    speed: null,
    tokens: { ...unknownTokens, total: spec.tokens ?? 100 },
    toolFigure: null,
  },
});

const attribute = (events: readonly DxEventEnvelope[]) =>
  repoLocator.pipe(
    Effect.flatMap((locator) => attributeRepos(locator, events))
  );

const memory = GitRunner.memory(REPOS);

const byId = (events: readonly DxEventEnvelope[]) =>
  new Map(events.map((e) => [String(e.eventId), e] as const));

const placeOf = (e: DxEventEnvelope | undefined) => ({
  branchSource: e?.ai?.branchSource ?? null,
  repo: e?.context.repoCommonDir ?? null,
  worktree: e?.context.worktreePath ?? null,
});

const timeline = (worktree: string, branch: string): WorktreeTimeline => ({
  currentBranch: branch,
  currentSinceMs: Date.parse("2026-09-30T00:00:00.000Z"),
  moves: [
    { atMs: Date.parse("2026-09-30T00:00:00.000Z"), branch, detached: false },
  ],
  points: [],
  reflogFromMs: Date.parse("2026-09-30T00:00:00.000Z"),
  worktree,
});

describe("touched paths", () => {
  it("resolves cd targets, workdirs, git -C and relative file paths to absolute paths", () => {
    expect(
      touchedPaths({
        calls: [
          { command: "cd ./app && git log -1" },
          { paths: ["./app/main.py", "/etc/hosts"] },
          { command: "git -C lib status", workdir: ORCHESTRATOR },
          { command: "cd ~/scratch/app-two; ls" },
          { command: "cd" },
        ],
        cwd: ORCHESTRATOR,
        home: HOME,
      })
    ).toStrictEqual([
      APP,
      `${APP}/main.py`,
      "/etc/hosts",
      ORCHESTRATOR,
      LIB,
      APP_TWO,
    ]);
  });

  it("keeps resolving later segments from the folder a cd moved to", () => {
    expect(
      touchedPaths({
        calls: [{ command: 'cd app && cd "../lib" && git -C . status' }],
        cwd: ORCHESTRATOR,
      })
    ).toStrictEqual([APP, LIB]);
  });

  it("drops relative paths when there is no folder to resolve them from", () => {
    expect(
      touchedPaths({ calls: [{ paths: ["main.py"] }], cwd: null })
    ).toStrictEqual([]);
  });
});

describe("branch names", () => {
  it("treats HEAD and detached values as no branch", () => {
    expect(
      [
        "HEAD",
        "",
        "  ",
        null,
        "(HEAD detached at 1a2b3c4)",
        "HEAD detached at origin/main",
        "(no branch)",
        "0123456789abcdef0123456789abcdef01234567",
      ].map((raw) => branchNameOrNull(raw))
    ).toStrictEqual([null, null, null, null, null, null, null, null]);
  });

  it("keeps real branch names and strips refs/heads", () => {
    expect(
      ["main", "refs/heads/feat/x", "feature/HEAD-fix"].map((raw) =>
        branchNameOrNull(raw)
      )
    ).toStrictEqual(["main", "feat/x", "feature/HEAD-fix"]);
  });

  it("does not let a Claude Code row recorded as HEAD win over checkout history", () => {
    const result = attributeHistoricalBranches(
      [
        event({
          branch: "HEAD",
          branchSource: "harness-recorded",
          context: { repoCommonDir: APP_GIT, worktreePath: APP },
          cwd: APP,
          id: "head-row",
        }),
      ],
      { commitBranches: new Map(), timelines: [timeline(APP, "main")] }
    );

    expect(placeOf(result.events[0])).toStrictEqual({
      branchSource: "git-at-time",
      repo: APP_GIT,
      worktree: APP,
    });
    expect(result.events[0]?.context.branch).toBe("main");
  });

  it("leaves a detached HEAD unassigned when nothing else knows the branch", () => {
    const result = attributeHistoricalBranches(
      [
        event({
          branch: "HEAD",
          branchSource: "harness-recorded",
          cwd: ORCHESTRATOR,
          id: "detached",
        }),
      ],
      { commitBranches: new Map(), timelines: [] }
    );

    expect(result.events[0]?.context.branch).toBeNull();
    expect(result.events[0]?.ai?.branchSource).toBe("unassigned");
  });
});

describe("worktree resolution from cwd", () => {
  it.effect("moves a request to the worktree its cwd is in", () =>
    Effect.gen(function* scenario() {
      const result = yield* attribute([
        event({
          context: { repoCommonDir: APP_GIT, worktreePath: APP },
          cwd: `${APP_TWO}/src`,
          id: "in-two",
        }),
        event({
          context: { repoCommonDir: APP_GIT, worktreePath: APP },
          cwd: APP,
          id: "in-main",
        }),
      ]);

      const events = byId(result.events);

      expect(placeOf(events.get("in-two"))).toStrictEqual({
        branchSource: "cwd-inferred",
        repo: APP_GIT,
        worktree: APP_TWO,
      });
      expect(events.get("in-two")?.context.branch).toBe("feature/two");
      expect(events.get("in-main")).toStrictEqual(result.events[1]);
      expect(events.get("in-main")?.payload).toStrictEqual({});
    }).pipe(Effect.provide(memory))
  );

  it.effect("asks git once per path", () =>
    Effect.gen(function* scenario() {
      const asked: string[] = [];

      const git: GitQueries = {
        at: (path) => {
          asked.push(path);

          return Effect.succeed(memoryGitAt(REPOS, path));
        },
        worktrees: () => Effect.succeed([]),
      };

      yield* attributeRepos(
        makeRepoLocator(git),
        ["a", "b", "c"].map((id) => event({ cwd: APP, id }))
      );

      expect(asked).toStrictEqual([APP]);
    })
  );

  it.effect("keeps the stored worktree when the cwd no longer exists", () =>
    Effect.gen(function* scenario() {
      const gone = `${HOME}/scratch/deleted-worktree`;

      const kindOf = (path: string): Effect.Effect<PathKind> =>
        Effect.succeed(path.startsWith(gone) ? "missing" : "directory");

      const git: GitQueries = {
        at: (path) => Effect.succeed(memoryGitAt(REPOS, path)),
        worktrees: () => Effect.succeed([]),
      };

      const stored = event({
        context: { repoCommonDir: APP_GIT, worktreePath: APP },
        cwd: gone,
        id: "deleted",
      });

      const result = yield* attributeRepos(makeRepoLocator(git, kindOf), [
        stored,
      ]);

      expect(result.events).toStrictEqual([stored]);
    })
  );

  it.effect("files a session outside every repo under (no repo)", () =>
    Effect.gen(function* scenario() {
      const result = yield* attribute([
        event({
          context: { repoCommonDir: APP_GIT, worktreePath: APP },
          cwd: ORCHESTRATOR,
          id: "nowhere",
        }),
      ]);

      const [only] = result.events;

      expect(placeOf(only)).toStrictEqual({
        branchSource: "unassigned",
        repo: null,
        worktree: null,
      });
      expect(only?.context.branch).toBeNull();
      expect(only?.payload.repoAttribution).toMatchObject({
        method: "no-repo",
        project: NO_REPO_PROJECT,
      });
    }).pipe(Effect.provide(memory))
  );

  it.effect("is idempotent", () =>
    Effect.gen(function* scenario() {
      const events = [
        event({ cwd: ORCHESTRATOR, id: "parent" }),
        event({
          agentId: "agent-a",
          cwd: APP,
          id: "child-a",
          tokens: 100,
        }),
        event({
          agentId: "agent-b",
          cwd: LIB,
          id: "child-b",
          tokens: 100,
        }),
      ];

      const once = yield* attribute(events);
      const twice = yield* attribute(once.events);

      expect(twice.events).toStrictEqual(once.events);
    }).pipe(Effect.provide(memory))
  );
});

describe("orchestrator outside a repo (D36)", () => {
  it.effect(
    "uses the one repo its own tool calls touched, branch from checkout history",
    () =>
      Effect.gen(function* scenario() {
        const placed = yield* attribute([
          event({
            cwd: ORCHESTRATOR,
            id: "edit",
            touched: [`${APP}/main.py`, `${HOME}/notes.md`],
          }),
        ]);

        const [moved] = placed.events;

        expect(placeOf(moved)).toStrictEqual({
          branchSource: "tool-calls",
          repo: APP_GIT,
          worktree: APP,
        });

        const result = attributeHistoricalBranches(placed.events, {
          commitBranches: new Map(),
          timelines: [timeline(APP, "feature/at-time")],
        });

        expect(result.events[0]?.context.branch).toBe("feature/at-time");
        expect(result.events[0]?.ai?.branchSource).toBe("tool-calls");
      }).pipe(Effect.provide(memory))
  );

  it.effect(
    "applies what one request of a turn touched to the whole turn",
    () =>
      Effect.gen(function* scenario() {
        const result = yield* attribute([
          event({ cwd: ORCHESTRATOR, id: "plan", turnId: "turn-1" }),
          event({
            at: "2026-10-01T10:00:05.000Z",
            cwd: ORCHESTRATOR,
            id: "act",
            touched: [LIB],
            turnId: "turn-1",
          }),
          event({
            at: "2026-10-01T10:05:00.000Z",
            cwd: ORCHESTRATOR,
            id: "next-turn",
            turnId: "turn-2",
          }),
        ]);

        const events = byId(result.events);

        expect(placeOf(events.get("plan")).repo).toBe(LIB_GIT);
        expect(placeOf(events.get("act")).repo).toBe(LIB_GIT);
        expect(placeOf(events.get("next-turn")).repo).toBeNull();
      }).pipe(Effect.provide(memory))
  );

  it.effect(
    "splits across its subagents' repos by their tokens when it touched two repos",
    () =>
      Effect.gen(function* scenario() {
        const result = yield* attribute([
          event({
            cwd: ORCHESTRATOR,
            id: "orchestrate",
            tokens: 1000,
            touched: [APP, LIB],
            turnId: "turn-1",
          }),
          event({
            agentId: "agent-app",
            at: "2026-10-01T10:00:01.000Z",
            cwd: APP,
            id: "app-work",
            tokens: 300,
          }),
          event({
            agentId: "agent-lib",
            at: "2026-10-01T10:00:02.000Z",
            cwd: LIB,
            id: "lib-work",
            tokens: 100,
          }),
        ]);

        const parts = result.events.filter(
          (e) => e.ai?.sessionId === "orchestrator" && e.ai.agentId === null
        );

        expect(
          parts.map((part) => ({
            branchSource: part.ai?.branchSource,
            id: part.eventId,
            repo: part.context.repoCommonDir,
            requestKey: part.usage?.requestKey,
            total: part.usage?.tokens.total,
          }))
        ).toStrictEqual([
          {
            branchSource: "subagent-split",
            id: "orchestrate#split:1/2",
            repo: APP_GIT,
            requestKey: "request:orchestrate#split:1/2",
            total: 750,
          },
          {
            branchSource: "subagent-split",
            id: "orchestrate#split:2/2",
            repo: LIB_GIT,
            requestKey: "request:orchestrate#split:2/2",
            total: 250,
          },
        ]);
        expect(parts[0]?.payload.repoAttribution).toMatchObject({
          inferred: true,
          method: "subagent-split",
          splitOf: "orchestrate",
          weight: 0.75,
        });

        const history = attributeHistoricalBranches(result.events, {
          commitBranches: new Map(),
          timelines: [timeline(APP, "main"), timeline(LIB, "main")],
        });

        const split = history.events.find(
          (e) => e.eventId === "orchestrate#split:1/2"
        );

        expect(split?.ai?.branchSource).toBe("subagent-split");
        expect(split?.payload.historicalBranch).toMatchObject({
          attribution: "provisional",
        });
      }).pipe(Effect.provide(memory))
  );

  it.effect(
    "keeps every share of a split request as its own usage fact, once",
    () =>
      Effect.gen(function* scenario() {
        const orchestrate = event({
          cwd: ORCHESTRATOR,
          id: "orchestrate",
          tokens: 1000,
          touched: [APP, LIB],
          turnId: "turn-1",
        });

        const telemetry: DxEventEnvelope = {
          ...orchestrate,
          ai:
            orchestrate.ai === null
              ? null
              : { ...orchestrate.ai, channel: "otel", cwd: null },
          eventId: EventIdSchema.make("orchestrate-otel"),
          upstreamKey: "otel:orchestrate",
          usage:
            orchestrate.usage === null
              ? null
              : { ...orchestrate.usage, requestKey: "req-orchestrate" },
        };

        const placed = yield* attribute([
          orchestrate,
          telemetry,
          event({
            agentId: "agent-app",
            at: "2026-10-01T10:00:01.000Z",
            cwd: APP,
            id: "app-work",
            tokens: 300,
          }),
          event({
            agentId: "agent-lib",
            at: "2026-10-01T10:00:02.000Z",
            cwd: LIB,
            id: "lib-work",
            tokens: 100,
          }),
        ]);

        const history = attributeHistoricalBranches(placed.events, {
          commitBranches: new Map(),
          timelines: [timeline(APP, "main"), timeline(LIB, "main")],
        });

        const { facts } = deriveUsageFacts(history.events);

        expect(
          facts
            .filter((fact) => fact.agent === null)
            .map((fact) => ({
              attribution: fact.attribution,
              repo: fact.repo,
              total: fact.tokens.total,
            }))
            .toSorted((a, b) => a.repo.localeCompare(b.repo))
        ).toStrictEqual([
          { attribution: "subagent-split", repo: APP_GIT, total: 750 },
          { attribution: "subagent-split", repo: LIB_GIT, total: 250 },
        ]);
        expect(
          facts.reduce((sum, fact) => sum + (fact.tokens.total ?? 0), 0)
        ).toBe(1400);
      }).pipe(Effect.provide(memory))
  );

  it.effect(
    "splits web searches across the shares so they add up to the original once",
    () =>
      Effect.gen(function* scenario() {
        const orchestrate = event({
          cwd: ORCHESTRATOR,
          id: "orchestrate",
          tokens: 1000,
          touched: [APP, LIB],
          turnId: "turn-1",
        });

        const placed = yield* attribute([
          {
            ...orchestrate,
            usage:
              orchestrate.usage === null
                ? null
                : {
                    ...orchestrate.usage,
                    tokens: {
                      ...unknownTokens,
                      inputFresh: 600,
                      output: 400,
                      total: 1000,
                    },
                    webSearchRequests: 10,
                  },
          },
          event({
            agentId: "agent-app",
            at: "2026-10-01T10:00:01.000Z",
            cwd: APP,
            id: "app-work",
            tokens: 300,
          }),
          event({
            agentId: "agent-lib",
            at: "2026-10-01T10:00:02.000Z",
            cwd: LIB,
            id: "lib-work",
            tokens: 100,
          }),
        ]);

        const { facts } = deriveUsageFacts(placed.events);

        const shares = facts
          .filter((fact) => fact.attribution === "subagent-split")
          .toSorted((a, b) => a.repo.localeCompare(b.repo));

        const searchUsd = shares.map((fact) => {
          const estimate = estimateRequest(
            [FIXTURE_SHEET],
            pricedRequestOf(fact)
          );

          return estimate.kind === "priced"
            ? estimate.lines
                .filter((line) => line.part === "web-search")
                .reduce((sum, line) => sum + line.usd, 0)
            : Number.NaN;
        });

        expect(shares.map((fact) => fact.webSearchRequests)).toStrictEqual([
          7.5, 2.5,
        ]);
        expect(searchUsd.reduce((sum, usd) => sum + usd, 0)).toBeCloseTo(
          0.1,
          10
        );
      }).pipe(Effect.provide(memory))
  );

  it.effect("files it under (no repo) when nothing points anywhere", () =>
    Effect.gen(function* scenario() {
      const result = yield* attribute([
        event({
          cwd: ORCHESTRATOR,
          id: "chat",
          touched: [`${HOME}/notes.md`],
        }),
      ]);

      expect(result.attributions).toStrictEqual([
        {
          eventId: "chat",
          method: "no-repo",
          repoCommonDir: null,
          splitOf: null,
          weight: 1,
          worktreePath: null,
        },
      ]);
    }).pipe(Effect.provide(memory))
  );

  it.effect(
    "keeps a request its tool placed by its tool calls when it carries no paths",
    () =>
      Effect.gen(function* scenario() {
        const placed = event({
          branch: "main",
          branchSource: "tool-calls",
          context: { repoCommonDir: APP_GIT, worktreePath: APP },
          cwd: ORCHESTRATOR,
          id: "omp-turn",
        });

        const result = yield* attribute([placed]);

        expect(result.attributions).toStrictEqual([]);
        expect(placeOf(byId(result.events).get("omp-turn"))).toStrictEqual({
          branchSource: "tool-calls",
          repo: APP_GIT,
          worktree: APP,
        });

        const history = attributeHistoricalBranches(result.events, {
          commitBranches: new Map(),
          timelines: [timeline(APP, "feature/at-time")],
        });

        expect(history.events[0]?.context.branch).toBe("feature/at-time");
        expect(history.events[0]?.ai?.branchSource).toBe("tool-calls");
      }).pipe(Effect.provide(memory))
  );
});

describe("subagents (D29)", () => {
  it.effect(
    "puts a subagent's usage in its own cwd's worktree and keeps the parent link",
    () =>
      Effect.gen(function* scenario() {
        const result = yield* attribute([
          event({ cwd: APP, id: "parent" }),
          event({
            agentId: "agent-two",
            cwd: APP_TWO,
            id: "child",
            parentSessionId: "orchestrator",
            sessionId: "child-session",
          }),
        ]);

        const child = byId(result.events).get("child");

        expect(placeOf(child)).toStrictEqual({
          branchSource: "cwd-inferred",
          repo: APP_GIT,
          worktree: APP_TWO,
        });
        expect(child?.ai?.parentSessionId).toBe("orchestrator");
        expect(child?.ai?.agentId).toBe("agent-two");
      }).pipe(Effect.provide(memory))
  );

  it.effect(
    "falls back to the parent's repo when the subagent's own folder is in none",
    () =>
      Effect.gen(function* scenario() {
        const result = yield* attribute([
          event({ cwd: LIB, id: "parent" }),
          event({
            agentId: "agent-x",
            at: "2026-10-01T10:00:03.000Z",
            cwd: ORCHESTRATOR,
            id: "child",
          }),
        ]);

        const child = byId(result.events).get("child");

        expect(placeOf(child)).toStrictEqual({
          branchSource: "cwd-inferred",
          repo: LIB_GIT,
          worktree: LIB,
        });
        expect(child?.payload.repoAttribution).toMatchObject({
          method: "parent",
        });
        expect(child?.ai?.agentId).toBe("agent-x");
        expect(child?.ai?.sessionId).toBe("orchestrator");
      }).pipe(Effect.provide(memory))
  );

  it.effect(
    "prefers the repo a subagent's own tool calls touched over its parent's",
    () =>
      Effect.gen(function* scenario() {
        const result = yield* attribute([
          event({ cwd: LIB, id: "parent" }),
          event({
            agentId: "agent-x",
            cwd: ORCHESTRATOR,
            id: "child",
            touched: [`${APP}/main.py`],
          }),
        ]);

        expect(placeOf(byId(result.events).get("child"))).toStrictEqual({
          branchSource: "tool-calls",
          repo: APP_GIT,
          worktree: APP,
        });
      }).pipe(Effect.provide(memory))
  );

  it.effect(
    "does not pass a borrowed branch off as one the tool recorded",
    () =>
      Effect.gen(function* scenario() {
        const placed = yield* attribute([
          event({ cwd: LIB, id: "parent" }),
          event({
            agentId: "agent-x",
            branch: "HEAD",
            branchSource: "harness-recorded",
            cwd: ORCHESTRATOR,
            id: "child",
          }),
        ]);

        const result = attributeHistoricalBranches(placed.events, {
          commitBranches: new Map(),
          timelines: [timeline(LIB, "feature/at-time")],
        });

        const child = result.events.find((e) => e.eventId === "child");

        expect(child?.context.branch).toBe("feature/at-time");
        expect(child?.ai?.branchSource).toBe("git-at-time");
      }).pipe(Effect.provide(memory))
  );
});
