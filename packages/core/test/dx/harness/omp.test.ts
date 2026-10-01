// @effect-diagnostics nodeBuiltinImport:off -- The OMP fixture tier copies committed redacted sessions into an owned temp home with synchronous node:fs.
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { afterAll, describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { everywhere } from "../../../src/dx/harness/contract.js";
import type {
  HarnessScope,
  SessionRef,
} from "../../../src/dx/harness/contract.js";
import { HarnessHome } from "../../../src/dx/harness/home.js";
import { LocalSqlite } from "../../../src/dx/harness/local-sqlite.js";
import { OmpHarness, OmpStore } from "../../../src/dx/harness/omp/index.js";
import {
  HarnessRegistry,
  registryWith,
} from "../../../src/dx/harness/registry.js";
import { emptyFlightContext } from "../../../src/dx/model/event.js";
import type {
  DxEventEnvelope,
  FlightContext,
} from "../../../src/dx/model/event.js";
import { harnessConformance } from "./conformance.js";

const FIXTURE_HOME = "/home/user";

const fixtures = path.join(
  import.meta.dirname,
  "..",
  "fixtures",
  "harness",
  "omp"
);

const home = mkdtempSync(path.join(os.tmpdir(), "dft-omp-harness-"));

const dftHome = path.join(home, "dft");

const sessionsDir = path.join(home, ".omp", "agent", "sessions");

const repo = path.join(home, "work", "repo");

const wtTwo = path.join(home, "work", "wt-two");

const filesUnder = (dir: string): readonly string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));

const copyFixtures = (from: string, to: string) => {
  for (const file of filesUnder(from)) {
    const target = path.join(to, path.relative(from, file));

    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(
      target,
      readFileSync(file, "utf-8").replaceAll(FIXTURE_HOME, home)
    );
  }
};

copyFixtures(path.join(fixtures, "sessions"), sessionsDir);

copyFixtures(path.join(fixtures, "dft"), dftHome);

writeFileSync(
  path.join(home, ".omp", "agent", "last-changelog-version"),
  "18.0.0\n"
);

const growingHome = mkdtempSync(path.join(os.tmpdir(), "dft-omp-growing-"));

const growingFile = path.join(
  growingHome,
  ".omp",
  "agent",
  "sessions",
  "-work-repo",
  "2026-10-01T10-56-42-614Z_01a0f71c-0076-7337-b774-b0109b4f7ecb.jsonl"
);

mkdirSync(path.dirname(growingFile), { recursive: true });

writeFileSync(
  growingFile,
  readFileSync(
    path.join(
      fixtures,
      "sessions",
      "-work-repo",
      "2026-10-01T10-56-42-614Z_01a0f71c-0076-7337-b774-b0109b4f7ecb.jsonl"
    ),
    "utf-8"
  ).replaceAll(FIXTURE_HOME, growingHome)
);

afterAll(() => {
  rmSync(home, { force: true, recursive: true });
  rmSync(growingHome, { force: true, recursive: true });
});

const ompAtHome = (at: string) =>
  OmpHarness.layer.pipe(
    Layer.provide(OmpStore.layer),
    Layer.provide(Layer.mergeAll(HarnessHome.at(at), LocalSqlite.layer)),
    Layer.provide(NodeServices.layer)
  );

const ompAt = ompAtHome(home);

const repoScope: HarnessScope = {
  dftHome,
  repoCommonDir: null,
  since: null,
  worktrees: [repo, wtTwo],
};

const mainContext: FlightContext = {
  ...emptyFlightContext,
  branch: "main",
  worktreePath: repo,
};

harnessConformance("omp", registryWith(ompAt), {
  context: mainContext,
  expectEvents: true,
  scope: repoScope,
  tier: "fixture",
});

const SESSIONS = {
  branched: "01a0f780-81f9-73ec-a818-bed80570944a",
  failed: "01a0f718-2039-7129-87be-130c086e4afa",
  modelChange: "01a0f780-692d-73cc-b01f-1f3ab464e3cd",
  nonRepo: "01a0f71e-ceaf-707b-b198-f30cbb2262e6",
  orchestrator: "01a0f780-c3dc-7302-b5ae-5e7f60b4e0fd",
  resumed: "01a0f71c-a86a-701c-acfd-34b9dee677f7",
  subagent: "01a0f77f-dd48-77f6-9f6e-286c5415486f",
  subagentParent: "01a0f77f-cc09-73bb-b346-9376f668018b",
  tinyEdit: "01a0f71c-0076-7337-b774-b0109b4f7ecb",
  worktree: "01a0f71d-fae9-72cd-93d8-a0219028d1c1",
} as const;

const contextFor = (ref: SessionRef): FlightContext => {
  if (ref.worktree === repo) {
    return mainContext;
  }

  return ref.worktree === wtTwo
    ? { ...emptyFlightContext, branch: "feat/omp-two", worktreePath: wtTwo }
    : emptyFlightContext;
};

const readAll = (scope: HarnessScope) =>
  Effect.gen(function* readEverything() {
    const registry = yield* HarnessRegistry;
    const harness = registry.get("omp");

    if (harness === null) {
      return yield* Effect.die("omp is not registered");
    }

    const located = yield* registry.locate(scope);
    const events = new Map<string, DxEventEnvelope>();

    for (const ref of located.refs.filter((each) => each.harness === "omp")) {
      const batch = yield* harness.read(ref, {
        context: contextFor(ref),
        cursor: null,
        origin: "fixture",
      });

      for (const event of batch.events) {
        if (!events.has(event.eventId)) {
          events.set(event.eventId, event);
        }
      }
    }

    return [...events.values()];
  });

const tokensBySession = (events: readonly DxEventEnvelope[]) => {
  const totals = new Map<string, number>();

  for (const event of events) {
    const total = event.usage?.tokens.total ?? null;
    const session = event.ai?.sessionId ?? null;

    if (total !== null && session !== null) {
      totals.set(session, (totals.get(session) ?? 0) + total);
    }
  }

  return Object.fromEntries(totals);
};

const ofSession = (events: readonly DxEventEnvelope[], sessionId: string) =>
  events.filter(
    (event) =>
      event.ai?.sessionId === sessionId && event.acquisition === "file-import"
  );

describe("OMP harness on redacted real sessions", () => {
  it.effect(
    "locates sessions by the header cwd and finds the orchestrator through its tool calls",
    () =>
      Effect.gen(function* locateByHeader() {
        const registry = yield* HarnessRegistry;
        const located = yield* registry.locate(repoScope);

        const refs = located.refs
          .filter((ref) => ref.harness === "omp")
          .map((ref) => [
            path.relative(home, ref.path),
            ref.channel,
            ref.worktree === null ? null : path.relative(home, ref.worktree),
          ]);

        expect(refs).toStrictEqual([
          [
            ".omp/agent/sessions/--work-wt-two/2026-10-01T10-58-52-265Z_01a0f71d-fae9-72cd-93d8-a0219028d1c1.jsonl",
            "session-file",
            "work/wt-two",
          ],
          [
            ".omp/agent/sessions/--work-wt-two/2026-10-01T12-46-23-021Z_01a0f780-692d-73cc-b01f-1f3ab464e3cd.jsonl",
            "session-file",
            "work/wt-two",
          ],
          [
            ".omp/agent/sessions/--work-wt-two/2026-10-01T12-46-29-369Z_01a0f780-81f9-73ec-a818-bed80570944a.jsonl",
            "session-file",
            "work/wt-two",
          ],
          [
            ".omp/agent/sessions/--work/2026-10-01T12-46-46-236Z_01a0f780-c3dc-7302-b5ae-5e7f60b4e0fd.jsonl",
            "session-file",
            "work/repo",
          ],
          [
            ".omp/agent/sessions/-work-repo/2026-10-01T10-52-28-601Z_01a0f718-2039-7129-87be-130c086e4afa.jsonl",
            "session-file",
            "work/repo",
          ],
          [
            ".omp/agent/sessions/-work-repo/2026-10-01T10-56-42-614Z_01a0f71c-0076-7337-b774-b0109b4f7ecb.jsonl",
            "session-file",
            "work/repo",
          ],
          [
            ".omp/agent/sessions/-work-repo/2026-10-01T10-57-25-610Z_01a0f71c-a86a-701c-acfd-34b9dee677f7.jsonl",
            "session-file",
            "work/repo",
          ],
          [
            ".omp/agent/sessions/-work-repo/2026-10-01T12-45-42-793Z_01a0f77f-cc09-73bb-b346-9376f668018b.jsonl",
            "session-file",
            "work/repo",
          ],
          [
            ".omp/agent/sessions/-work-repo/2026-10-01T12-45-42-793Z_01a0f77f-cc09-73bb-b346-9376f668018b/ReadmeLineCount.jsonl",
            "session-file",
            "work/repo",
          ],
          ["dft/hooks/omp/2026-10-01.jsonl", "extension", "work/repo"],
          ["dft/hooks/omp/2026-10-01.jsonl", "extension", "work/wt-two"],
        ]);
      }).pipe(Effect.provide(registryWith(ompAt)))
  );

  it.effect(
    "counts each real request once with the totals OMP itself recorded",
    () =>
      Effect.gen(function* matchManifest() {
        const events = yield* readAll(everywhere);

        expect(tokensBySession(events)).toStrictEqual({
          [SESSIONS.branched]: 26_344,
          [SESSIONS.modelChange]: 54_055,
          [SESSIONS.nonRepo]: 26_326,
          [SESSIONS.orchestrator]: 52_762,
          [SESSIONS.resumed]: 399_803,
          [SESSIONS.subagent]: 57_842,
          [SESSIONS.subagentParent]: 79_959,
          [SESSIONS.tinyEdit]: 79_725,
          [SESSIONS.worktree]: 52_830,
        });

        const figures = events
          .filter((event) => event.ai?.sessionId === SESSIONS.tinyEdit)
          .reduce(
            (sum, event) => sum + (event.usage?.toolFigure?.amount ?? 0),
            0
          );

        expect(figures).toBeCloseTo(675_768e-8, 10);
      }).pipe(Effect.provide(registryWith(ompAt)))
  );

  it.effect("keeps one session id across resumed turns", () =>
    Effect.gen(function* resumed() {
      const events = ofSession(yield* readAll(repoScope), SESSIONS.resumed);
      const turns = events.filter((event) => event.kind === "ai.turn");
      const usage = events.filter((event) => event.kind === "ai.usage");

      expect(turns.map((event) => event.payload.turnIndex)).toStrictEqual([
        1, 2, 3,
      ]);
      expect(new Set(usage.map((event) => event.identity.turnId)).size).toBe(3);
      expect(
        new Set(
          usage.map(
            (event) => `${event.ai?.branchSource}:${event.context.branch}`
          )
        )
      ).toStrictEqual(new Set(["cwd-inferred:main"]));
      expect(usage.every((event) => event.context.worktreePath === repo)).toBe(
        true
      );
    }).pipe(Effect.provide(registryWith(ompAt)))
  );

  it.effect(
    "gives a subagent its own session under its parent and never counts the task result",
    () =>
      Effect.gen(function* subagent() {
        const events = yield* readAll(repoScope);
        const child = ofSession(events, SESSIONS.subagent);

        expect(
          new Set(
            child.map((event) =>
              [
                event.ai?.agentId,
                event.ai?.agentType,
                event.ai?.parentSessionId,
              ].join("|")
            )
          )
        ).toStrictEqual(
          new Set([`ReadmeLineCount|scout|${SESSIONS.subagentParent}`])
        );
        expect(events.some((event) => event.payload.aggregate === true)).toBe(
          false
        );
      }).pipe(Effect.provide(registryWith(ompAt)))
  );

  it.effect("records a model and effort change per request and per turn", () =>
    Effect.gen(function* modelChange() {
      const events = ofSession(yield* readAll(repoScope), SESSIONS.modelChange);

      const pick = (kind: string) =>
        events
          .filter((event) => event.kind === kind)
          .map((event) => [
            event.ai?.provider,
            event.ai?.via,
            event.ai?.model,
            event.ai?.modelRaw,
            event.ai?.effort,
          ]);

      const expected = [
        ["openai", "cliproxy", "gpt-5.6-luna", "cliproxy/gpt-5.6-luna", "low"],
        [
          "zhipu",
          "cliproxy",
          "glm-5.3-flash",
          "cliproxy/factory/glm-5.3-flash",
          "medium",
        ],
      ];

      expect(pick("ai.usage")).toStrictEqual(expected);
      expect(pick("ai.turn")).toStrictEqual(expected);

      const session = events.find((event) => event.kind === "ai.session");

      expect(session?.payload.title).toBe("Fixture session");
      expect(session?.ai?.branchSource).toBe("cwd-inferred");
      expect(session?.context.branch).toBe("feat/omp-two");
    }).pipe(Effect.provide(registryWith(ompAt)))
  );

  it.effect(
    "skips history a branched session copied from a parent that is still on disk",
    () =>
      Effect.gen(function* branched() {
        const events = ofSession(yield* readAll(repoScope), SESSIONS.branched);

        expect(
          events
            .filter((event) => event.kind === "ai.usage")
            .map((event) => event.identity.generationId)
        ).toStrictEqual(["d0d0f849"]);
        expect(
          events.find((event) => event.kind === "ai.session")?.payload
            .forkedFrom
        ).toContain(SESSIONS.modelChange);
      }).pipe(Effect.provide(registryWith(ompAt)))
  );

  it.effect("keeps failed attempts as requests without usage", () =>
    Effect.gen(function* failed() {
      const events = ofSession(yield* readAll(repoScope), SESSIONS.failed);
      const requests = events.filter((event) => event.kind === "ai.request");

      expect(events.filter((event) => event.kind === "ai.usage")).toStrictEqual(
        []
      );
      expect(requests).toHaveLength(11);
      expect(
        new Set(
          requests.map((event) =>
            [
              event.usage,
              event.payload.failed,
              event.payload.stopReason,
              event.payload.errorStatus,
              event.ai?.via,
            ].join("|")
          )
        )
      ).toStrictEqual(new Set(["|true|error|400|github-copilot"]));
      expect(requests.map((event) => event.payload.premiumRequests)).toContain(
        0.33
      );
    }).pipe(Effect.provide(registryWith(ompAt)))
  );

  it.effect(
    "places a non-repo orchestrator turn by the repo its tool calls touched",
    () =>
      Effect.gen(function* orchestrator() {
        const events = ofSession(
          yield* readAll(repoScope),
          SESSIONS.orchestrator
        );

        expect(events.length).toBeGreaterThan(0);
        expect(
          new Set(
            events.map(
              (event) =>
                `${event.ai?.branchSource}:${event.context.branch}:${event.context.worktreePath === repo}`
            )
          )
        ).toStrictEqual(new Set(["tool-calls:main:true"]));

        const free = ofSession(yield* readAll(everywhere), SESSIONS.nonRepo);

        expect(
          new Set(
            free.map(
              (event) => `${event.ai?.branchSource}:${event.context.branch}`
            )
          )
        ).toStrictEqual(new Set(["unassigned:null"]));
      }).pipe(Effect.provide(registryWith(ompAt)))
  );

  it.effect(
    "turns extension observations into hook events with the branch seen live",
    () =>
      Effect.gen(function* hooks() {
        const events = (yield* readAll(repoScope)).filter(
          (event) => event.acquisition === "hook"
        );

        expect(events.length).toBe(25);
        expect(new Set(events.map((event) => event.ai?.channel))).toStrictEqual(
          new Set(["extension"])
        );
        expect(
          new Set(
            events.map(
              (event) => `${event.ai?.branchSource}:${event.context.branch}`
            )
          )
        ).toStrictEqual(new Set(["hook:main", "hook:feat/omp-two"]));
        expect(
          events.filter((event) => event.ai?.agentId === "ReadmeLineCount")
            .length
        ).toBeGreaterThan(0);
      }).pipe(Effect.provide(registryWith(ompAt)))
  );

  it.effect("reads only what changed once a cursor is stored", () =>
    Effect.gen(function* incremental() {
      const registry = yield* HarnessRegistry;
      const harness = registry.get("omp");
      const growingRepo = path.join(growingHome, "work", "repo");

      const located = yield* registry.locate({
        ...everywhere,
        worktrees: [growingRepo],
      });

      const ref = located.refs.find(
        (each) => each.sessionId === SESSIONS.tinyEdit
      );

      if (harness === null || ref === undefined) {
        return yield* Effect.die("fixture session missing");
      }

      const input = {
        context: mainContext,
        cursor: null,
        origin: "fixture" as const,
      };

      const first = yield* harness.read(ref, input);

      const again = yield* harness.read(ref, {
        ...input,
        cursor: first.cursor,
      });

      expect(again.events).toStrictEqual([]);

      appendFileSync(
        ref.path,
        `${JSON.stringify({ id: "fe000001", message: { attribution: "user", content: [], role: "user", timestamp: 1 }, parentId: null, timestamp: "2026-10-01T11:00:00.000Z", type: "message" })}\n${JSON.stringify({ id: "fe000002", message: { api: "openai-responses", content: [], model: "gpt-5.6-luna", provider: "cliproxy", role: "assistant", stopReason: "stop", usage: { cacheRead: 0, cacheWrite: 0, input: 10, output: 2, totalTokens: 12 } }, parentId: "fe000001", timestamp: "2026-10-01T11:00:01.000Z", type: "message" })}\n`
      );

      const grown = statSync(ref.path);

      const next = yield* harness.read(
        { ...ref, mtimeMs: grown.mtimeMs, size: grown.size },
        { ...input, cursor: first.cursor }
      );

      const firstIds = new Set(first.events.map((event) => event.eventId));

      expect(
        next.events
          .filter((event) => !firstIds.has(event.eventId))
          .map((event) => [
            event.kind,
            event.identity.generationId ?? event.identity.turnId,
          ])
      ).toStrictEqual([
        ["ai.turn", "fe000001"],
        ["ai.usage", "fe000002"],
      ]);
      expect(next.events.map((event) => event.kind)).not.toContain(
        "ai.request"
      );

      return next;
    }).pipe(Effect.provide(registryWith(ompAtHome(growingHome))))
  );
});
