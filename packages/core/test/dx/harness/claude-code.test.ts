// @effect-diagnostics nodeBuiltinImport:off -- The Claude Code fixture tier builds owned temp homes (symlinked and XDG project folders) with node:fs.
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { afterAll, describe, expect, it } from "@effect/vitest";
import { Clock, Effect, Layer } from "effect";

import {
  ClaudeCodeHarness,
  ClaudeCodeStore,
  claudeCodeHookDecoder,
} from "../../../src/dx/harness/claude-code/index.js";
import { everywhere } from "../../../src/dx/harness/contract.js";
import type {
  HarnessScope,
  ReadInput,
} from "../../../src/dx/harness/contract.js";
import { HarnessHome } from "../../../src/dx/harness/home.js";
import type { HarnessHomeOverrides } from "../../../src/dx/harness/home.js";
import { registryWith } from "../../../src/dx/harness/registry.js";
import type { AiTokens } from "../../../src/dx/model/attribution.js";
import { emptyFlightContext } from "../../../src/dx/model/event.js";
import type {
  DxEventEnvelope,
  FlightContext,
} from "../../../src/dx/model/event.js";
import { harnessConformance } from "./conformance.js";

const fixtureHome = path.join(
  import.meta.dirname,
  "..",
  "fixtures",
  "harness",
  "claude-code",
  "claude-home"
);

const work = "/home/user/work/claude-code";

const repo = `${work}/repo`;

const wtTwo = `${work}/wt-two`;

const LATER_MS = Date.parse("2030-01-01T00:00:00.000Z");

const settledClock: Clock.Clock = {
  currentTimeMillis: Effect.succeed(LATER_MS),
  currentTimeMillisUnsafe: () => LATER_MS,
  currentTimeNanos: Effect.succeed(BigInt(LATER_MS) * 1_000_000n),
  currentTimeNanosUnsafe: () => BigInt(LATER_MS) * 1_000_000n,
  monotonicTimeNanos: Effect.succeed(BigInt(LATER_MS) * 1_000_000n),
  monotonicTimeNanosUnsafe: () => BigInt(LATER_MS) * 1_000_000n,
  sleep: () => Effect.void,
};

const claudeAt = (home: string, overrides: HarnessHomeOverrides) =>
  Layer.fresh(ClaudeCodeHarness.layer).pipe(
    Layer.provide(ClaudeCodeStore.layer),
    Layer.provide(HarnessHome.at(home, overrides)),
    Layer.provide(Layer.succeed(Clock.Clock, settledClock)),
    Layer.provide(NodeServices.layer)
  );

const fixtureHarness = claudeAt("/home/user", {
  CLAUDE_CONFIG_DIR: fixtureHome,
});

const repoContext: FlightContext = {
  ...emptyFlightContext,
  branch: "main",
  repoCommonDir: `${repo}/.git`,
  worktreePath: repo,
};

const scopeOf = (worktree: string): HarnessScope => ({
  ...everywhere,
  worktrees: [worktree],
});

harnessConformance("claude-code", registryWith(fixtureHarness), {
  context: repoContext,
  expectEvents: true,
  scope: scopeOf(repo),
  tier: "fixture",
});

harnessConformance("claude-code", registryWith(fixtureHarness), {
  expectEvents: true,
  tier: "fixture",
});

const readSessions = (scope: HarnessScope, context: FlightContext) =>
  Effect.gen(function* readFixture() {
    const harness = yield* ClaudeCodeHarness;
    const refs = yield* harness.locate(scope);
    const input: ReadInput = { context, cursor: null, origin: "fixture" };
    const events: DxEventEnvelope[] = [];
    const gaps: string[] = [];

    for (const ref of refs) {
      const batch = yield* harness.read(ref, input);

      events.push(...batch.events);
      gaps.push(...batch.coverage.gaps.map((gap) => gap.code));
    }

    return { events, gaps, refs };
  }).pipe(Effect.provide(fixtureHarness));

type Totals = Pick<
  AiTokens,
  "cacheRead" | "cacheWrite" | "inputFresh" | "output"
>;

const totalsByChat = (events: readonly DxEventEnvelope[]) => {
  const totals = new Map<string, Totals & { requests: number }>();

  for (const event of events) {
    const chat = event.ai?.sessionId ?? "-";
    const tokens = event.usage?.tokens;

    if (event.kind === "ai.usage" && tokens !== undefined) {
      const seen = totals.get(chat) ?? {
        cacheRead: 0,
        cacheWrite: 0,
        inputFresh: 0,
        output: 0,
        requests: 0,
      };

      totals.set(chat, {
        cacheRead: (seen.cacheRead ?? 0) + (tokens.cacheRead ?? 0),
        cacheWrite: (seen.cacheWrite ?? 0) + (tokens.cacheWrite ?? 0),
        inputFresh: (seen.inputFresh ?? 0) + (tokens.inputFresh ?? 0),
        output: (seen.output ?? 0) + (tokens.output ?? 0),
        requests: seen.requests + 1,
      });
    }
  }

  return Object.fromEntries(totals);
};

const MANIFEST_TOTALS = {
  "1100de81-3953-4d9f-9243-9d4e657a37fe": {
    cacheRead: 527_726,
    cacheWrite: 28_766,
    inputFresh: 20,
    output: 1300,
    requests: 10,
  },
  "24ae293e-278a-483e-a09d-62c57aa4728e": {
    cacheRead: 109_801,
    cacheWrite: 55_694,
    inputFresh: 6,
    output: 492,
    requests: 3,
  },
  "24ae293e-278a-483e-a09d-62c57aa4728e:agent-a45e3ccf79a884360": {
    cacheRead: 210_064,
    cacheWrite: 44_172,
    inputFresh: 12,
    output: 1104,
    requests: 6,
  },
  "2aaac43f-a7ae-4a43-a8dd-134d29e456cb": {
    cacheRead: 304_536,
    cacheWrite: 28_712,
    inputFresh: 12,
    output: 996,
    requests: 6,
  },
  "464d3ae5-0952-4217-9f80-fabd271a363d": {
    cacheRead: 304_227,
    cacheWrite: 28_234,
    inputFresh: 12,
    output: 670,
    requests: 6,
  },
  "649817f1-146b-4bab-a7c9-a05757db4f34": {
    cacheRead: 82_406,
    cacheWrite: 27_341,
    inputFresh: 4,
    output: 252,
    requests: 2,
  },
  "649817f1-146b-4bab-a7c9-a05757db4f34:agent-a468bc16361b4ba95": {
    cacheRead: 36_125,
    cacheWrite: 43_238,
    inputFresh: 4,
    output: 176,
    requests: 2,
  },
  "eb8c4f30-f77f-4a64-b631-eabf0af2359e": {
    cacheRead: 0,
    cacheWrite: 95_812,
    inputFresh: 12,
    output: 46,
    requests: 2,
  },
};

const usageOf = (events: readonly DxEventEnvelope[], session: string) =>
  events.filter(
    (event) => event.kind === "ai.usage" && event.identity.sessionId === session
  );

describe("Claude Code fixture sessions", () => {
  it.effect(
    "match the independently counted totals of every recorded run",
    () =>
      Effect.gen(function* manifestTotals() {
        const { events } = yield* readSessions(everywhere, emptyFlightContext);

        expect(totalsByChat(events)).toStrictEqual(MANIFEST_TOTALS);
      })
  );

  it.effect(
    "keeps each turn's branch across a resume and a branch switch",
    () =>
      Effect.gen(function* branchSwitch() {
        const { events } = yield* readSessions(scopeOf(repo), repoContext);
        const usage = usageOf(events, "1100de81-3953-4d9f-9243-9d4e657a37fe");

        expect(
          usage.map((event) => [event.context.branch, event.ai?.branchSource])
        ).toStrictEqual([
          ...Array.from({ length: 7 }, () => [
            "feat/claude-code-one",
            "harness-recorded",
          ]),
          ...Array.from({ length: 3 }, () => [
            "feat/claude-code-switch",
            "harness-recorded",
          ]),
        ]);
        expect(new Set(usage.map((event) => event.identity.turnId)).size).toBe(
          3
        );
      })
  );

  it.effect("puts a subagent in its own chat under its parent", () =>
    Effect.gen(function* subagent() {
      const { events } = yield* readSessions(scopeOf(repo), repoContext);
      const parent = "649817f1-146b-4bab-a7c9-a05757db4f34";
      const child = usageOf(events, `${parent}:agent-a468bc16361b4ba95`);

      expect(
        child.map((event) => [
          event.ai?.agentId,
          event.ai?.agentType,
          event.ai?.parentSessionId,
        ])
      ).toStrictEqual(
        child.map(() => ["a468bc16361b4ba95", "general-purpose", parent])
      );
      expect(child[0]?.payload.isSubagent).toBe(true);

      const session = events.find(
        (event) =>
          event.kind === "ai.session" &&
          event.identity.sessionId === `${parent}:agent-a468bc16361b4ba95`
      );

      expect(session?.payload.parentSessionId).toBe(parent);
    })
  );

  it.effect(
    "finds a worktree's own sessions and nothing from its sibling",
    () =>
      Effect.gen(function* worktree() {
        const inTwo = yield* readSessions(scopeOf(wtTwo), {
          ...emptyFlightContext,
          branch: "feat/claude-code-two",
          worktreePath: wtTwo,
        });

        expect(inTwo.refs.map((ref) => ref.sessionId)).toStrictEqual([
          "464d3ae5-0952-4217-9f80-fabd271a363d",
          "24ae293e-278a-483e-a09d-62c57aa4728e",
        ]);
        expect([
          ...new Set(
            inTwo.events
              .filter((event) => event.kind === "ai.usage")
              .map(
                (event) => `${event.context.branch}|${event.ai?.branchSource}`
              )
          ),
        ]).toStrictEqual(["feat/claude-code-two|harness-recorded"]);
      })
  );

  it.effect(
    "places a non-repo orchestrator's own turns in the one repo its work touched",
    () =>
      Effect.gen(function* orchestrator() {
        const session = "24ae293e-278a-483e-a09d-62c57aa4728e";
        const { events } = yield* readSessions(scopeOf(repo), repoContext);

        const placed = events
          .filter(
            (event) =>
              event.kind === "ai.usage" &&
              event.identity.sessionId?.startsWith(session) === true
          )
          .map((event) => ({
            branch: event.context.branch,
            launchDir: event.ai?.cwd === work,
            source: event.ai?.branchSource,
          }));

        expect(placed.length).toBe(9);
        expect(new Set(placed.map((row) => row.branch))).toStrictEqual(
          new Set(["main"])
        );
        expect(
          placed.every(({ launchDir, source }) =>
            launchDir ? source === "tool-calls" : source === "cwd-inferred"
          )
        ).toBe(true);

        const nowhere = yield* readSessions(everywhere, emptyFlightContext);

        expect(
          new Set(
            usageOf(nowhere.events, session).map(
              (event) => event.ai?.branchSource
            )
          )
        ).toStrictEqual(new Set(["unassigned"]));
      })
  );

  it.effect("records per-turn model and effort when the model changes", () =>
    Effect.gen(function* modelChange() {
      const { events } = yield* readSessions(scopeOf(repo), repoContext);
      const session = "eb8c4f30-f77f-4a64-b631-eabf0af2359e";

      const turns = events.filter(
        (event) =>
          event.kind === "ai.turn" && event.identity.sessionId === session
      );

      expect(
        turns.map((event) => [
          event.ai?.model,
          event.ai?.effort,
          event.ai?.provider,
        ])
      ).toStrictEqual([
        ["claude-sonnet-5", "medium", "anthropic"],
        ["claude-haiku-4-5", null, "anthropic"],
      ]);

      const cost = events.find(
        (event) =>
          event.kind === "ai.session" &&
          event.identity.sessionId === session &&
          event.usage !== null
      );

      expect(cost?.usage?.toolFigure?.amount).toBeCloseTo(0.3017, 4);
      expect(cost?.usage?.toolFigure?.kind).toBe("api-equivalent");
    })
  );

  it.effect("reports a failed request without inventing usage", () =>
    Effect.gen(function* failedRequest() {
      const { events, gaps } = yield* readSessions(scopeOf(repo), repoContext);

      expect(
        usageOf(events, "2a4050f2-e15a-46aa-a297-6aabb2b920ef")
      ).toStrictEqual([]);
      expect(gaps).toContain("api-error-rows");
    })
  );
});

const tempHome = mkdtempSync(path.join(os.tmpdir(), "dft-claude-home-"));

afterAll(() => {
  rmSync(tempHome, { force: true, recursive: true });
});

const sessionLine = JSON.stringify({
  cwd: "/w",
  gitBranch: "main",
  message: {
    id: "m1",
    model: "claude-sonnet-5",
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 2 },
  },
  requestId: "r1",
  sessionId: "s1",
  type: "assistant",
});

const writeSession = (dir: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "s1.jsonl"), `${sessionLine}\n`);
};

writeSession(path.join(tempHome, ".claude", "projects", "-w"));

symlinkSync(
  path.join(tempHome, ".claude", "projects", "-w"),
  path.join(tempHome, ".claude", "projects", "-w-link")
);

writeSession(path.join(tempHome, ".config", "claude", "projects", "-x"));

writeSession(path.join(tempHome, "other", "projects", "-y"));

describe("Claude Code session discovery", () => {
  it.effect(
    "reads the default and XDG folders once, skipping symlinked project copies",
    () =>
      Effect.gen(function* defaultHome() {
        const harness = yield* ClaudeCodeHarness;
        const refs = yield* harness.locate(everywhere);
        const discovered = yield* harness.discover;

        expect(
          refs.map((ref) => path.relative(tempHome, ref.path))
        ).toStrictEqual([
          ".claude/projects/-w/s1.jsonl",
          ".config/claude/projects/-x/s1.jsonl",
        ]);
        expect(discovered).toMatchObject({ present: true, sessions: 2 });
      }).pipe(Effect.provide(claudeAt(tempHome, {})))
  );

  it.effect("follows every folder in CLAUDE_CONFIG_DIR", () =>
    Effect.gen(function* overridden() {
      const harness = yield* ClaudeCodeHarness;
      const refs = yield* harness.locate(everywhere);

      expect(
        refs.map((ref) => path.relative(tempHome, ref.path))
      ).toStrictEqual([
        ".config/claude/projects/-x/s1.jsonl",
        "other/projects/-y/s1.jsonl",
      ]);
    }).pipe(
      Effect.provide(
        claudeAt(tempHome, {
          CLAUDE_CONFIG_DIR: `${path.join(tempHome, "other")},${path.join(tempHome, ".config", "claude")}`,
        })
      )
    )
  );
});

describe("Claude Code hooks", () => {
  it("decodes session, subagent, effort and model fields", () => {
    expect(
      claudeCodeHookDecoder.decode(
        JSON.stringify({
          agent_id: "a1",
          agent_type: "Explore",
          cwd: "/w",
          effort: { level: "high" },
          hook_event_name: "SubagentStop",
          model: "claude-opus-5",
          prompt: "never kept",
          session_id: "s1",
          transcript_path: "/t/s1.jsonl",
        }),
        "SubagentStop"
      )
    ).toStrictEqual({
      agentId: "a1",
      agentType: "Explore",
      cwd: "/w",
      effort: "high",
      model: "claude-opus-5",
      parentSessionId: "s1",
      sessionId: "s1:agent-a1",
      transcriptPath: "/t/s1.jsonl",
      turnId: null,
    });
    expect(
      claudeCodeHookDecoder.decode('{"session_id":"s1","effort":"low"}', "Stop")
        ?.effort
    ).toBe("low");
    expect(claudeCodeHookDecoder.decode("not json", "Stop")).toBeNull();
  });

  it("maps hook event names to event kinds", () => {
    expect(
      [
        "SessionStart",
        "UserPromptSubmit",
        "PostToolUse",
        "Stop",
        "SubagentStop",
        "SessionEnd",
        "Notification",
      ].map(claudeCodeHookDecoder.kind)
    ).toStrictEqual([
      "ai.session",
      "ai.request",
      "other",
      "ai.turn",
      "ai.turn",
      "ai.session",
      "other",
    ]);
    expect(claudeCodeHookDecoder.respond("Stop")).toBe("");
  });
});
