// @effect-diagnostics nodeBuiltinImport:off -- The DeepSeek fixture tier writes committed sessions into an owned temp DSH_HOME.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { afterAll, expect, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { everywhere } from "../../../src/dx/harness/contract.js";
import type {
  HarnessScope,
  SessionRef,
} from "../../../src/dx/harness/contract.js";
import {
  DeepseekHarness,
  DeepseekStore,
} from "../../../src/dx/harness/deepseek/index.js";
import { HarnessHome } from "../../../src/dx/harness/home.js";
import { registryWith } from "../../../src/dx/harness/registry.js";
import { emptyFlightContext } from "../../../src/dx/model/event.js";
import type {
  DxEventEnvelope,
  FlightContext,
} from "../../../src/dx/model/event.js";
import { harnessConformance } from "./conformance.js";
import {
  FIXTURES,
  FIXTURE_CWD,
  fixtureSession,
  writeFixtureHome,
} from "./deepseek-fixtures.js";
import type { FixtureName } from "./deepseek-fixtures.js";

const home = mkdtempSync(path.join(os.tmpdir(), "dft-deepseek-harness-"));

writeFixtureHome(path.join(home, ".dsh"), FIXTURES);

afterAll(() => {
  rmSync(home, { force: true, recursive: true });
});

const deepseekAt = Layer.fresh(DeepseekHarness.layer).pipe(
  Layer.provide(DeepseekStore.layer),
  Layer.provide(HarnessHome.at(home)),
  Layer.provide(NodeServices.layer)
);

const scopeOf = (...worktrees: readonly string[]): HarnessScope => ({
  dftHome: path.join(home, ".dft"),
  repoCommonDir: null,
  since: null,
  worktrees,
});

const repoContext: FlightContext = {
  ...emptyFlightContext,
  branch: "main",
  repoCommonDir: `${FIXTURE_CWD.repo}/.git`,
  worktreePath: FIXTURE_CWD.repo,
};

harnessConformance("deepseek", registryWith(DeepseekHarness.mock), {
  tier: "mock",
});

harnessConformance("deepseek", registryWith(deepseekAt), {
  context: repoContext,
  expectEvents: true,
  scope: scopeOf(FIXTURE_CWD.repo, FIXTURE_CWD.worktree, FIXTURE_CWD.norepo),
  tier: "fixture",
});

const readScope = (scope: HarnessScope, context = repoContext) =>
  Effect.gen(function* readFixtures() {
    const harness = yield* DeepseekHarness;
    const refs = yield* harness.locate(scope);

    const batches = yield* Effect.forEach((ref: SessionRef) =>
      harness.read(ref, { context, cursor: null, origin: "fixture" })
    )(refs);

    return { batches, refs };
  });

const eventsOf = (
  batches: readonly { readonly events: readonly DxEventEnvelope[] }[]
) => batches.flatMap((batch) => batch.events);

const sessionEvents = (
  events: readonly DxEventEnvelope[],
  name: (typeof FIXTURES)[number]
) => {
  const { id } = fixtureSession(name);

  return events.filter((event) => event.identity.sessionId === id);
};

const totalsOf = (events: readonly DxEventEnvelope[]) => {
  const usage = events.flatMap((event) =>
    event.usage === null ? [] : [event.usage.tokens]
  );

  const sum = (pick: (tokens: (typeof usage)[number]) => number | null) =>
    usage.reduce((total, tokens) => total + (pick(tokens) ?? 0), 0);

  const totals = {
    cacheRead: sum((tokens) => tokens.cacheRead),
    cacheWrite: sum((tokens) => tokens.cacheWrite),
    input: sum((tokens) => tokens.inputFresh),
    output: sum((tokens) => tokens.output),
    requests: usage.length,
  };

  return {
    ...totals,
    total: totals.input + totals.output + totals.cacheRead + totals.cacheWrite,
  };
};

const titlesOf = (events: readonly DxEventEnvelope[]) =>
  events.flatMap((event) =>
    event.kind === "ai.session" && event.payload.title !== undefined
      ? [{ title: event.payload.title, titleSource: event.payload.titleSource }]
      : []
  );

const REPO_FIXTURES: readonly FixtureName[] = [
  "main",
  "orchestrator",
  "resume-branch-switch",
  "subagent",
];

const everything = scopeOf(
  FIXTURE_CWD.repo,
  FIXTURE_CWD.worktree,
  FIXTURE_CWD.norepo
);

layer(deepseekAt)("DeepSeek harness on real-structure fixtures", (it) => {
  it.effect("matches the independently computed totals of every run", () =>
    Effect.gen(function* matchManifest() {
      const events = eventsOf((yield* readScope(everything)).batches);

      const totals = Object.fromEntries(
        FIXTURES.map((name) => [
          name,
          totalsOf(sessionEvents(events, name)).total,
        ])
      );

      expect(totals).toStrictEqual({
        "errors-model-change": 34_300,
        fork: 8692,
        main: 53_698,
        "non-repo": 8457,
        orchestrator: 101_591,
        "resume-branch-switch": 158_910,
        subagent: 65_695,
        worktree: 35_822,
      });

      expect(totalsOf(sessionEvents(events, "main"))).toStrictEqual({
        cacheRead: 24_064,
        cacheWrite: 0,
        input: 29_209,
        output: 425,
        requests: 6,
        total: 53_698,
      });
    })
  );

  it.effect(
    "finds every session location and keeps each worktree to its own sessions",
    () =>
      Effect.gen(function* scoped() {
        const repo = yield* readScope(scopeOf(FIXTURE_CWD.repo));
        const tree = yield* readScope(scopeOf(FIXTURE_CWD.worktree));
        const all = yield* readScope(everywhere);

        expect(
          repo.refs
            .map((ref) => ref.sessionId ?? "")
            .toSorted((a, b) => a.localeCompare(b))
        ).toStrictEqual(
          REPO_FIXTURES.map((name) => fixtureSession(name).id).toSorted(
            (a, b) => a.localeCompare(b)
          )
        );
        expect(
          repo.refs.every((ref) => ref.worktree === FIXTURE_CWD.repo)
        ).toBe(true);
        expect(tree.refs.map((ref) => ref.sessionId ?? "")).toStrictEqual([
          fixtureSession("worktree").id,
        ]);
        expect(all.refs).toHaveLength(FIXTURES.length);
        expect(all.refs.every((ref) => ref.worktree === null)).toBe(true);
      })
  );

  it.effect(
    "keeps one resumed session across a branch switch, turn by turn",
    () =>
      Effect.gen(function* resumed() {
        const events = sessionEvents(
          eventsOf((yield* readScope(scopeOf(FIXTURE_CWD.repo))).batches),
          "resume-branch-switch"
        );

        const turns = events.filter((event) => event.kind === "ai.turn");

        expect(turns.map((turn) => turn.payload.turn)).toStrictEqual([1, 2, 3]);
        expect(turns.map((turn) => turn.payload.outcome)).toStrictEqual([
          "completed",
          "completed",
          "completed",
        ]);
        expect(turns.map((turn) => turn.payload.requests)).toStrictEqual([
          6, 5, 5,
        ]);

        const times = turns.map((turn) => turn.occurredAt ?? "");

        expect(times).toStrictEqual(
          times.toSorted((a, b) => a.localeCompare(b))
        );
        expect(new Set(times).size).toBe(3);

        for (const event of events.filter((item) => item.kind === "ai.usage")) {
          expect(event.ai?.branchSource).toBe("cwd-inferred");
          expect(event.context.branch).toBe("main");
          expect(event.identity.turnId).toMatch(/:turn:[123]$/u);
        }
      })
  );

  it.effect(
    "attributes the routed model to its maker and the router as via",
    () =>
      Effect.gen(function* routed() {
        const events = eventsOf((yield* readScope(everything)).batches);
        const usage = events.filter((event) => event.kind === "ai.usage");

        expect(usage.length).toBeGreaterThan(0);

        for (const event of usage) {
          expect(event.ai?.provider).toBe("openai");
          expect(event.ai?.via).toBe("local-router");
          expect(event.ai?.harness).toBe("deepseek");
          expect(event.ai?.cwd).toMatch(/^\/home\/user\/work\//u);
          expect(event.payload.modelRequested).toMatch(
            /^claude-(?:luna|terra)$/u
          );
          expect(event.usage?.toolFigure).toBeNull();
          expect(event.usage?.tokens.reasoning).toBeNull();
        }
      })
  );

  it.effect(
    "links a spawned subagent to its parent without double counting",
    () =>
      Effect.gen(function* subagent() {
        const events = eventsOf(
          (yield* readScope(scopeOf(FIXTURE_CWD.repo))).batches
        );

        const parent = sessionEvents(events, "orchestrator");
        const child = sessionEvents(events, "subagent");
        const childUsage = child.filter((event) => event.kind === "ai.usage");

        expect(totalsOf(parent).total).toBe(101_591);
        expect(totalsOf(child).total).toBe(65_695);

        for (const event of childUsage) {
          expect(event.ai?.parentSessionId).toBe(
            fixtureSession("orchestrator").id
          );
          expect(event.ai?.agentId).toBe(fixtureSession("subagent").id);
          expect(event.ai?.agentType).toBe("spawn");
          expect(event.payload.isSubagent).toBe(true);
        }

        expect(
          parent
            .filter((event) => event.kind === "ai.usage")
            .every(
              (event) =>
                event.ai?.agentId === null && event.ai?.parentSessionId === null
            )
        ).toBe(true);
      })
  );

  it.effect(
    "leaves a session outside any repo unassigned and points tool edits at their files",
    () =>
      Effect.gen(function* nonRepo() {
        const events = eventsOf((yield* readScope(everything)).batches);
        const outside = sessionEvents(events, "non-repo");

        expect(outside.length).toBeGreaterThan(0);

        for (const event of outside) {
          expect(event.context.branch).toBeNull();
          expect(event.context.worktreePath).toBe(FIXTURE_CWD.norepo);
          expect(event.ai?.branchSource).toBe("unassigned");
        }

        const edits = sessionEvents(events, "main").filter(
          (event) => event.kind === "ai.tool-edit"
        );

        expect(edits.map((event) => event.payload.filePath)).toContain(
          `${FIXTURE_CWD.repo}/main.py`
        );
      })
  );

  it.effect("records failed requests and a model change turn by turn", () =>
    Effect.gen(function* failures() {
      const events = sessionEvents(
        eventsOf((yield* readScope(everything)).batches),
        "errors-model-change"
      );

      const failed = events.filter(
        (event) =>
          event.kind === "ai.request" && event.payload.outcome === "error"
      );

      expect(failed.map((event) => event.payload.modelRequested)).toStrictEqual(
        ["claude-deepseek-flash", "claude-deepseek-factory"]
      );

      for (const event of failed) {
        expect(event.usage).toBeNull();
        expect(event.payload.errorCode).toBe("INVALID_REQUEST");
        expect(event.payload.usageReported).toBe("zero");
      }

      const turns = events.filter((event) => event.kind === "ai.turn");

      expect(
        turns.map((turn) => [
          turn.payload.turn,
          turn.payload.outcome,
          turn.ai?.model,
        ])
      ).toStrictEqual([
        [1, "completed", "gpt-5.6-luna"],
        [2, "completed", "gpt-5.6-luna"],
        [3, "error", "claude-deepseek-flash"],
        [4, "error", "claude-deepseek-factory"],
        [5, "completed", "gpt-5.6-terra"],
      ]);

      expect(titlesOf(events)).toStrictEqual([]);
    })
  );

  it.effect(
    "keeps model-written titles and drops the prompt-prefix fallback",
    () =>
      Effect.gen(function* titles() {
        const events = sessionEvents(
          eventsOf((yield* readScope(everything)).batches),
          "main"
        );

        expect(titlesOf(events)).toStrictEqual([
          { title: "Fixture title 2", titleSource: "provider" },
        ]);
      })
  );

  it.effect(
    "skips the history a forked subagent inherited from its parent",
    () =>
      Effect.gen(function* forked() {
        const events = sessionEvents(
          eventsOf((yield* readScope(everything)).batches),
          "fork"
        );

        const usage = events.filter((event) => event.kind === "ai.usage");

        expect(usage).toHaveLength(1);
        expect(totalsOf(events)).toStrictEqual({
          cacheRead: 7680,
          cacheWrite: 0,
          input: 991,
          output: 21,
          requests: 1,
          total: 8692,
        });
        expect(usage[0]?.ai?.agentType).toBe("fork");
        expect(usage[0]?.ai?.parentSessionId).toBe(
          fixtureSession("errors-model-change").id
        );
        expect(
          events.some(
            (event) => event.kind === "ai.turn" && event.payload.turn === 1
          )
        ).toBe(false);
      })
  );
});
