// @effect-diagnostics nodeBuiltinImport:off -- The fixture tier resolves folders inside the owned temp home.
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { afterAll, describe, expect, it, layer } from "@effect/vitest";
import { ConfigProvider, Effect, Layer } from "effect";

import { everywhere } from "../../../src/dx/harness/contract.js";
import type { SessionRef } from "../../../src/dx/harness/contract.js";
import { HarnessHome } from "../../../src/dx/harness/home.js";
import {
  PI_READINESS,
  PiHarness,
  PiStore,
} from "../../../src/dx/harness/pi/index.js";
import {
  HarnessRegistryLive,
  registryWith,
} from "../../../src/dx/harness/registry.js";
import { emptyFlightContext } from "../../../src/dx/model/event.js";
import type { DxEventEnvelope } from "../../../src/dx/model/event.js";
import { harnessConformance } from "./conformance.js";
import { installPiFixtureHome, piFixtureHarness } from "./pi-fixture.js";

const fixture = installPiFixtureHome();

afterAll(() => {
  fixture.remove();
});

const demo = path.join(fixture.home, "projects", "pi-demo");

const demoTwo = path.join(fixture.home, "projects", "pi-demo-two");

const harnessLayer = piFixtureHarness(fixture.home);

harnessConformance("pi", registryWith(PiHarness.mock), { tier: "mock" });

harnessConformance("pi", registryWith(harnessLayer), {
  expectEvents: true,
  tier: "fixture",
});

harnessConformance("pi", registryWith(harnessLayer), {
  expectEvents: true,
  scope: { ...everywhere, worktrees: [demo, demoTwo] },
  tier: "fixture",
});

harnessConformance(
  "pi",
  HarnessRegistryLive.pipe(Layer.provide(NodeServices.layer)),
  { maxSessions: 25, scope: everywhere, tier: "live" }
);

const input = {
  context: emptyFlightContext,
  cursor: null,
  origin: "fixture" as const,
};

const RUN_A = "2026-10-01T10-53-18-513Z_01a0f718-e330-7250-b94b-fc0576b8089d";

const RUN_B = "2026-10-01T10-53-44-463Z_pi-one-session";

const RUN_C = "2026-10-01T10-55-09-452Z_01a0f71a-948c-7438-8ffc-7b1bd65269e3";

const FAILED = "2026-10-01T10-54-35-236Z_01a0f71a-0ee3-7132-926c-3aa8698f2acb";

const ORCHESTRATOR =
  "2026-10-01T10-55-57-048Z_01a0f71b-4e77-71e5-9ebf-444d8b6e0503";

const MODEL_CHANGE =
  "2026-10-01T12-29-25-390Z_01a0f770-e20d-720d-aac8-adce5c737183";

const FORK = "2026-10-01T12-29-36-898Z_01a0f771-0f02-720d-aac8-add1db94da3b";

const COMPACTION =
  "2026-10-01T12-30-15-831Z_01a0f771-a717-72ec-93a0-7a7ee737282e";

const SUBAGENT =
  "2026-10-01T12-30-33-920Z_01a0f771-edc0-738d-b214-0210226da223";

const YPI_PARENT = "2026-02-25T19-06-46.380Z_845f80e8";

const YPI_CHILD = "a054d49a_d1_c1";

const readEverything = Effect.gen(function* readEverything() {
  const harness = yield* PiHarness;
  const refs = yield* harness.locate(everywhere);
  const byName = new Map<string, readonly DxEventEnvelope[]>();

  for (const ref of refs) {
    const batch = yield* harness.read(ref, input);

    byName.set(path.basename(ref.path, ".jsonl"), batch.events);
  }

  return { byName, refs };
});

const usageOf = (events: readonly DxEventEnvelope[]) =>
  events.filter((event) => event.kind === "ai.usage");

const totalsOf = (events: readonly DxEventEnvelope[]) => {
  const totals = {
    cacheRead: 0,
    cacheWrite: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    requests: 0,
    total: 0,
  };

  for (const event of usageOf(events)) {
    const tokens = event.usage?.tokens;

    totals.requests += 1;
    totals.input += tokens?.inputFresh ?? 0;
    totals.output += tokens?.output ?? 0;
    totals.cacheRead += tokens?.cacheRead ?? 0;
    totals.cacheWrite += tokens?.cacheWrite ?? 0;
    totals.reasoning += tokens?.reasoning ?? 0;
    totals.total += tokens?.total ?? 0;
  }

  return totals;
};

const eventsOf = (
  byName: ReadonlyMap<string, readonly DxEventEnvelope[]>,
  name: string
): readonly DxEventEnvelope[] => byName.get(name) ?? [];

layer(harnessLayer)("pi fixture sessions", (session) => {
  session.effect(
    "finds sessions in the default folder and the sessionDir setting",
    () =>
      Effect.gen(function* discovery() {
        const harness = yield* PiHarness;
        const found = yield* harness.discover;
        const { refs } = yield* readEverything;

        expect(PI_READINESS).toBe("ready");
        expect(found.present).toBe(true);
        expect(found.sessions).toBe(11);
        expect(found.roots).toStrictEqual([
          path.join(fixture.home, "pi-sessions"),
          path.join(fixture.home, ".pi", "agent", "sessions"),
        ]);
        expect(refs.every((ref: SessionRef) => ref.sessionId !== null)).toBe(
          true
        );
      })
  );

  session.effect(
    "matches the independently summed token totals of each run",
    () =>
      Effect.gen(function* totals() {
        const { byName } = yield* readEverything;

        expect(totalsOf(eventsOf(byName, RUN_A))).toStrictEqual({
          cacheRead: 17_408,
          cacheWrite: 0,
          input: 9941,
          output: 121,
          reasoning: 16,
          requests: 3,
          total: 27_470,
        });
        expect(totalsOf(eventsOf(byName, RUN_B))).toStrictEqual({
          cacheRead: 43_520,
          cacheWrite: 0,
          input: 21_621,
          output: 381,
          reasoning: 37,
          requests: 7,
          total: 65_522,
        });
        expect(totalsOf(eventsOf(byName, RUN_C))).toStrictEqual({
          cacheRead: 20_604,
          cacheWrite: 0,
          input: 825,
          output: 113,
          reasoning: 0,
          requests: 2,
          total: 21_542,
        });
        expect(totalsOf(eventsOf(byName, ORCHESTRATOR))).toStrictEqual({
          cacheRead: 27_136,
          cacheWrite: 0,
          input: 21_735,
          output: 402,
          reasoning: 165,
          requests: 5,
          total: 49_273,
        });
      })
  );

  session.effect(
    "keeps one session across resumed turns and a branch switch",
    () =>
      Effect.gen(function* resumed() {
        const { byName } = yield* readEverything;
        const events = eventsOf(byName, RUN_B);
        const turns = events.filter((event) => event.kind === "ai.turn");

        expect(turns).toHaveLength(3);
        expect(
          new Set(events.map((event) => event.identity.sessionId))
        ).toStrictEqual(new Set(["pi-one-session"]));

        for (const event of usageOf(events)) {
          expect(event.context.worktreePath).toBe(demo);
          expect(event.ai?.branchSource).toBe("cwd-inferred");
          expect(event.ai?.effort).toBe("low");
          expect(event.identity.turnId).not.toBeNull();
        }
      })
  );

  session.effect("places a linked worktree session on its own branch", () =>
    Effect.gen(function* worktree() {
      const { byName } = yield* readEverything;

      for (const event of usageOf(eventsOf(byName, RUN_C))) {
        expect(event.context.worktreePath).toBe(demoTwo);
        expect(event.context.branch).toBe("feat/pi-two");
        expect(event.ai).toMatchObject({
          model: "claude-sonnet-4-6",
          provider: "anthropic",
          via: "cliproxy",
        });
      }
    })
  );

  session.effect("keeps a failed request as a request without tokens", () =>
    Effect.gen(function* failed() {
      const { byName } = yield* readEverything;
      const events = eventsOf(byName, FAILED);
      const requests = events.filter((event) => event.kind === "ai.request");

      expect(usageOf(events)).toHaveLength(0);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.usage).toBeNull();
      expect(requests[0]?.payload).toMatchObject({
        failed: true,
        stopReason: "error",
        usageReported: false,
      });
    })
  );

  session.effect("leaves a non-repo orchestrator unassigned", () =>
    Effect.gen(function* orchestrator() {
      const { byName } = yield* readEverything;

      for (const event of eventsOf(byName, ORCHESTRATOR)) {
        expect(event.context.branch).toBeNull();
        expect(event.ai?.branchSource).toBe("unassigned");
      }
    })
  );

  session.effect(
    "counts the requests a subagent made inside its tool result",
    () =>
      Effect.gen(function* subagent() {
        const { byName } = yield* readEverything;
        const events = eventsOf(byName, SUBAGENT);

        const children = usageOf(events).filter(
          (event) => event.ai?.agentType === "scout"
        );

        const parent = "01a0f771-edc0-738d-b214-0210226da223";

        expect(totalsOf(events)).toMatchObject({ input: 28_695, requests: 4 });
        expect(children).toHaveLength(2);

        for (const child of children) {
          expect(child.ai?.parentSessionId).toBe(parent);
          expect(child.identity.sessionId?.startsWith(`${parent}/`)).toBe(true);
          expect(child.ai?.effort).toBe("high");
        }

        expect(
          events.filter(
            (event) =>
              event.kind === "ai.session" && event.payload.isSubagent === true
          )
        ).toHaveLength(1);
      })
  );

  session.effect("follows the model and effort change inside a session", () =>
    Effect.gen(function* modelChange() {
      const { byName } = yield* readEverything;
      const events = eventsOf(byName, MODEL_CHANGE);

      expect(
        usageOf(events).map((event) => [event.ai?.model, event.ai?.effort])
      ).toStrictEqual([
        ["gpt-5.6-luna", "low"],
        ["claude-sonnet-4-6", "medium"],
        ["claude-sonnet-4-6", "medium"],
      ]);
      expect(
        events
          .filter((event) => event.kind === "ai.turn")
          .map((event) => event.payload.model)
      ).toStrictEqual([
        "gpt-5.6-luna",
        "antigravity/claude-sonnet-4-6",
        "antigravity/claude-sonnet-4-6",
      ]);
    })
  );

  session.effect("leaves the copied history of a fork with its parent", () =>
    Effect.gen(function* fork() {
      const { byName } = yield* readEverything;
      const parent = eventsOf(byName, MODEL_CHANGE);
      const events = eventsOf(byName, FORK);
      const parentIds = new Set(parent.map((event) => event.eventId));

      expect(totalsOf(events)).toMatchObject({ input: 9066, requests: 1 });
      expect(events.filter((event) => event.kind === "ai.turn")).toHaveLength(
        1
      );
      expect(usageOf(events)[0]?.ai?.parentSessionId).toBe(
        "01a0f770-e20d-720d-aac8-adce5c737183"
      );
      expect(
        usageOf(events).some((event) => parentIds.has(event.eventId))
      ).toBe(false);
    })
  );

  session.effect("counts the compaction summary request", () =>
    Effect.gen(function* compaction() {
      const { byName } = yield* readEverything;
      const events = eventsOf(byName, COMPACTION);

      expect(totalsOf(events)).toMatchObject({
        input: 28_241,
        output: 173,
        requests: 5,
        total: 37_118,
      });
      expect(
        usageOf(events).filter(
          (event) => event.payload.requestKind === "compaction"
        )
      ).toHaveLength(1);
    })
  );

  session.effect(
    "shares event ids between a copied session file and its original",
    () =>
      Effect.gen(function* copiedFile() {
        const { byName } = yield* readEverything;
        const original = usageOf(eventsOf(byName, YPI_PARENT));
        const copy = usageOf(eventsOf(byName, YPI_CHILD));
        const originalIds = new Set(original.map((event) => event.eventId));

        expect(original).toHaveLength(1);
        expect(copy).toHaveLength(3);
        expect(
          copy.filter((event) => originalIds.has(event.eventId))
        ).toHaveLength(1);
        expect(copy[0]?.ai?.agentType).toBe("ypi");
      })
  );

  session.effect("locates only the sessions of the worktrees in scope", () =>
    Effect.gen(function* scoped() {
      const harness = yield* PiHarness;

      const refs = yield* harness.locate({
        ...everywhere,
        worktrees: [demoTwo],
      });

      expect(
        refs.map((ref) => path.basename(ref.path, ".jsonl")).toSorted()
      ).toStrictEqual([FAILED, RUN_C].toSorted());
      expect(refs.every((ref) => ref.worktree === demoTwo)).toBe(true);
    })
  );
});

const rootsWith = (home: string) =>
  Effect.gen(function* storeRoots() {
    const store = yield* PiStore;

    return yield* store.roots;
  }).pipe(
    Effect.provide(
      PiStore.layer.pipe(
        Layer.provide(HarnessHome.at(fixture.home)),
        Layer.provide(NodeServices.layer),
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              HOME: home,
              PI_CODING_AGENT_SESSION_DIR: "~/env-sessions",
            })
          )
        )
      )
    )
  );

describe("pi session folders", () => {
  it.effect(
    "adds PI_CODING_AGENT_SESSION_DIR only for the user's own home",
    () =>
      Effect.gen(function* folders() {
        const own = yield* rootsWith(fixture.home);
        const sandbox = yield* rootsWith("/somewhere/else");

        expect(own[0]).toBe(path.join(fixture.home, "env-sessions"));
        expect(sandbox).not.toContain(path.join(fixture.home, "env-sessions"));
        expect(sandbox).toHaveLength(2);
      })
  );
});
