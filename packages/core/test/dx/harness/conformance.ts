import { describe, expect, layer } from "@effect/vitest";
import { Context, Effect, Exit, Layer, Schema } from "effect";

import { everywhere } from "../../../src/dx/harness/contract.js";
import type {
  Discovery,
  Harness,
  HarnessScope,
  SessionRef,
} from "../../../src/dx/harness/contract.js";
import type { HarnessId } from "../../../src/dx/harness/ids.js";
import { HarnessRegistry } from "../../../src/dx/harness/registry.js";
import { normalizeAiUsage } from "../../../src/dx/metrics/ai-usage/normalize.js";
import { AI_TOKEN_FIELDS } from "../../../src/dx/model/attribution.js";
import {
  DxEventEnvelopeSchema,
  emptyFlightContext,
} from "../../../src/dx/model/event.js";
import type {
  DxEventEnvelope,
  FlightContext,
} from "../../../src/dx/model/event.js";

export type ConformanceTier = "mock" | "fixture" | "live";

export interface ConformanceOptions {
  readonly context?: FlightContext;
  readonly expectEvents?: boolean;
  readonly expectLocated?: boolean;
  readonly maxSessions?: number;
  readonly scope?: HarnessScope;
  readonly tier: ConformanceTier;
}

export const LIVE_HARNESSES_ENV = "DFT_LIVE_HARNESSES" as const;

export const liveHarnesses = (): readonly string[] =>
  (process.env[LIVE_HARNESSES_ENV] ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");

export const FORBIDDEN_PAYLOAD_KEYS: ReadonlySet<string> = new Set([
  "prompt",
  "prompts",
  "content",
  "text",
  "completion",
  "response",
  "thinking",
  "reasoningText",
  "transcript",
  "userMessage",
  "assistantMessage",
]);

interface ReadSession {
  readonly events: readonly DxEventEnvelope[];
  readonly ref: SessionRef;
  readonly secondIds: readonly string[];
}

interface ConformanceReading {
  readonly discovery: Discovery;
  readonly failures: readonly string[];
  readonly harness: Harness;
  readonly sessions: readonly ReadSession[];
}

class Reading extends Context.Service<Reading, ConformanceReading>()(
  "test/dx/harness/conformance/Reading"
) {}

const readingLayer = (name: HarnessId, options: ConformanceOptions) =>
  Layer.effect(
    Reading,
    Effect.gen(function* readHarness() {
      const registry = yield* HarnessRegistry;
      const harness = registry.get(name);

      if (harness === null) {
        return yield* Effect.die(`${name} is not in the harness registry`);
      }

      const discovery = yield* harness.discover;
      const located = yield* registry.locate(options.scope ?? everywhere);

      const refs = located.refs
        .filter((ref) => ref.harness === name)
        .slice(0, options.maxSessions ?? Number.POSITIVE_INFINITY);

      const input = {
        context: options.context ?? emptyFlightContext,
        cursor: null,
        origin: "fixture" as const,
      };

      const failures: string[] = located.failures.map(
        (failure) => `${failure.harness}: ${failure.reason}`
      );

      const sessions: ReadSession[] = [];

      for (const ref of refs) {
        const first = yield* Effect.exit(harness.read(ref, input));
        const second = yield* Effect.exit(harness.read(ref, input));

        if (Exit.isSuccess(first) && Exit.isSuccess(second)) {
          sessions.push({
            events: first.value.events,
            ref,
            secondIds: second.value.events.map((event) => event.eventId),
          });
        } else {
          failures.push(`${ref.path}: read failed`);
        }
      }

      return { discovery, failures, harness, sessions };
    })
  );

const allEvents = (reading: ConformanceReading) =>
  reading.sessions.flatMap((session) => session.events);

const aiEvents = (reading: ConformanceReading) =>
  allEvents(reading).filter((event) => event.kind.startsWith("ai."));

const forbiddenKeysIn = (payload: DxEventEnvelope["payload"]) => {
  const json = JSON.stringify(payload);

  return [...FORBIDDEN_PAYLOAD_KEYS].filter((key) =>
    new RegExp(`(?<!\\\\)"${key}":`, "u").test(json)
  );
};

const decodeEnvelopeJson = Schema.decodeUnknownExit(
  Schema.fromJsonString(DxEventEnvelopeSchema)
);

export const harnessConformance = <E>(
  name: HarnessId,
  registryLayer: Layer.Layer<HarnessRegistry, E>,
  options: ConformanceOptions
): void => {
  const live = options.tier === "live";
  const title = `${name} harness conformance (${options.tier})`;

  if (live && !liveHarnesses().includes(name)) {
    describe.skip(`${title}: set ${LIVE_HARNESSES_ENV} to include ${name}`, () => {
      expect(liveHarnesses()).not.toContain(name);
    });

    return;
  }

  layer(readingLayer(name, options).pipe(Layer.provideMerge(registryLayer)), {
    excludeTestServices: live,
    timeout: live ? "120 seconds" : "30 seconds",
  })(title, (it) => {
    it.effect("discovery never fails and names the harness", () =>
      Effect.gen(function* discovery() {
        const reading = yield* Reading;

        expect(reading.discovery.harness).toBe(name);
        expect(reading.harness.id).toBe(name);
        expect(reading.discovery.sessions).toBeGreaterThanOrEqual(0);
        expect(reading.harness.channels.length).toBeGreaterThan(0);
        expect(reading.failures).toStrictEqual([]);

        if (options.expectEvents === true) {
          expect(allEvents(reading).length).toBeGreaterThan(0);
        }

        if (
          options.expectLocated === true &&
          reading.discovery.present &&
          reading.discovery.sessions > 0
        ) {
          expect(
            reading.sessions.length,
            `${name} reports ${reading.discovery.sessions} sessions but none were located`
          ).toBeGreaterThan(0);
        }
      })
    );

    it.effect("located sessions stay inside the scope", () =>
      Effect.gen(function* inScope() {
        const reading = yield* Reading;
        const { worktrees } = options.scope ?? everywhere;

        for (const session of reading.sessions) {
          expect(session.ref.harness, session.ref.path).toBe(name);

          if (worktrees.length > 0) {
            expect(worktrees, session.ref.path).toContain(session.ref.worktree);
          }
        }
      })
    );

    it.effect("every event round-trips as dx.event.v2", () =>
      Effect.gen(function* decodes() {
        const reading = yield* Reading;

        for (const event of allEvents(reading)) {
          const decoded = decodeEnvelopeJson(JSON.stringify(event));

          expect(Exit.isSuccess(decoded), event.eventId).toBe(true);
          expect(event.schemaVersion).toBe("dx.event.v2");
        }
      })
    );

    it.effect("every AI event carries attribution for this harness", () =>
      Effect.gen(function* attribution() {
        const reading = yield* Reading;

        for (const event of aiEvents(reading)) {
          expect(event.ai, event.eventId).not.toBeNull();
          expect(event.ai?.harness, event.eventId).toBe(name);
          expect(reading.harness.channels, event.eventId).toContain(
            event.ai?.channel
          );
        }
      })
    );

    it.effect("reading a session twice gives the same event ids", () =>
      Effect.gen(function* idempotent() {
        const reading = yield* Reading;

        for (const session of reading.sessions) {
          expect(session.secondIds, session.ref.path).toStrictEqual(
            session.events.map((event) => event.eventId)
          );
        }
      })
    );

    it.effect("unknown token counts stay null instead of 0", () =>
      Effect.gen(function* nullTokens() {
        const reading = yield* Reading;

        for (const event of allEvents(reading)) {
          if (event.usage === null) {
            continue;
          }

          const { tokens, toolFigure } = event.usage;

          const known = AI_TOKEN_FIELDS.filter(
            (field) => tokens[field] !== null
          );

          expect(
            known.length > 0 || toolFigure !== null,
            `${event.eventId} has an empty usage block`
          ).toBe(true);
          expect(
            known.length > 0 && known.every((field) => tokens[field] === 0),
            `${event.eventId} reports every token bucket as 0`
          ).toBe(false);
        }
      })
    );

    it.effect("only tools that store a charge emit one", () =>
      Effect.gen(function* charges() {
        const reading = yield* Reading;
        const stored = reading.harness.capabilities.storedFigure;

        for (const event of allEvents(reading)) {
          const figure = event.usage?.toolFigure ?? null;

          if (stored === null) {
            expect(figure, event.eventId).toBeNull();
          } else if (stored !== "charge") {
            expect(figure?.kind, event.eventId).not.toBe("charge");
          }
        }
      })
    );

    it.effect("payloads carry no prompt or message text", () =>
      Effect.gen(function* noContent() {
        const reading = yield* Reading;

        for (const event of allEvents(reading)) {
          expect(forbiddenKeysIn(event.payload), event.eventId).toStrictEqual(
            []
          );
        }
      })
    );

    it.effect("branch source matches the harness capabilities", () =>
      Effect.gen(function* branchSources() {
        const reading = yield* Reading;
        const allowed = reading.harness.capabilities.branchSources;

        for (const event of aiEvents(reading)) {
          expect(allowed, event.eventId).toContain(event.ai?.branchSource);

          if (event.context.branch === null) {
            expect(event.ai?.branchSource, event.eventId).toBe("unassigned");
          }
        }
      })
    );

    it.effect("the token ledger recognizes every usage event", () =>
      Effect.gen(function* ledger() {
        const reading = yield* Reading;
        const { uncovered } = normalizeAiUsage(allEvents(reading));

        expect(
          uncovered
            .filter((gap) => gap.reason.includes("unrecognized"))
            .map((gap) => gap.evidenceId)
        ).toStrictEqual([]);
      })
    );

    it.effect("request keys are unique per request within a channel", () =>
      Effect.gen(function* requestKeys() {
        const reading = yield* Reading;
        const seen = new Map<string, string>();

        for (const event of allEvents(reading)) {
          const key = event.usage?.requestKey ?? null;

          if (key === null) {
            continue;
          }

          const slot = `${event.ai?.channel ?? "-"}|${event.kind}|${key}`;
          const owner = seen.get(slot);

          expect(owner ?? event.eventId, slot).toBe(event.eventId);
          seen.set(slot, event.eventId);
        }
      })
    );
  });
};
