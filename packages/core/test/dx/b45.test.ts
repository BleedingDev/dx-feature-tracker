import { fileURLToPath } from "node:url";

import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  GIT_AI_ADAPTER_ID,
  gitAiCollector,
  gitAiDescriptor,
} from "../../src/dx/collectors/git-ai/collector.js";
import {
  countRangeLines,
  parseAuthorshipNote,
} from "../../src/dx/collectors/git-ai/parse.js";
import type { CollectInput } from "../../src/dx/contracts/services.js";
import { ModuleDescriptorSchema } from "../../src/dx/model/descriptor.js";
import type { DxEventEnvelope } from "../../src/dx/model/event.js";
import {
  EventBatchSchema,
  emptyFlightContext,
} from "../../src/dx/model/event.js";

const exportDir = fileURLToPath(
  new URL("fixtures/b45/export", import.meta.url)
);

const SHA_A = "1".repeat(40);

const SHA_B = "2".repeat(40);

const SHA_C = "3".repeat(40);

const inputFor = (selectedInput: string | null): CollectInput => ({
  adapterId: GIT_AI_ADAPTER_ID,
  context: emptyFlightContext,
  cursor: null,
  origin: "fixture",
  scratchDir: null,
  selectedInput,
});

const collect = (input: CollectInput) =>
  gitAiCollector.collect(input).pipe(Effect.provide(NodeServices.layer));

const payloadOf = (
  events: readonly DxEventEnvelope[],
  key: string
): DxEventEnvelope["payload"] => {
  const found = events.find((event) => event.upstreamKey === key);

  expect(found).toBeDefined();

  return found?.payload ?? {};
};

describe("git-ai collector (B45)", () => {
  it("publishes a truthful disabled descriptor", () => {
    expect(Schema.is(ModuleDescriptorSchema)(gitAiDescriptor)).toBe(true);
    expect(gitAiDescriptor.readiness).toBe("disabled");
    expect(gitAiDescriptor.gaps.map((gap) => gap.code)).toContain(
      "stats-ratio-not-retention"
    );
    expect(gitAiDescriptor.supportedFields).not.toContain("payload.tokens");
  });

  it("counts attestation line ranges and rejects malformed ranges", () => {
    expect(countRangeLines("1-10,15-20")).toBe(16);
    expect(countRangeLines("30")).toBe(1);
    expect(countRangeLines("5-3")).toBeNull();
    expect(countRangeLines("x")).toBeNull();
    expect(parseAuthorshipNote("no divider").status).toBe("invalid");
  });

  it.effect("imports versioned notes and stats from the fixture export", () =>
    Effect.gen(function* importFixtureExport() {
      const batch = yield* collect(inputFor(exportDir));

      expect(Schema.is(EventBatchSchema)(batch)).toBe(true);
      expect(batch.events.map((event) => event.upstreamKey).toSorted()).toEqual(
        [
          `authorship-note:${SHA_A}`,
          `stats:${SHA_A}`,
          `stats:${SHA_B}`,
          `stats:${SHA_C}`,
        ]
      );
      expect(batch.coverage.expectedItems).toBe(7);
      expect(batch.coverage.observedItems).toBe(4);
      expect(batch.coverage.state).toBe("partial");
      const gapCodes = batch.coverage.gaps.map((gap) => gap.code);
      expect(gapCodes).toContain("unsupported-schema-version");
      expect(gapCodes).toContain("rejected-stats");
      expect(gapCodes).toContain("missing-commit-sha");

      for (const event of batch.events) {
        expect(event.kind).toBe("provenance.attestation");
        expect(event.origin).toBe("fixture");
        expect(event.occurredAt).toBeNull();
        expect(event.identity.commitSha).not.toBeNull();
      }
    })
  );

  it.effect("keeps note attestations bounded and drops prompt content", () =>
    Effect.gen(function* noteAttestation() {
      const batch = yield* collect(inputFor(exportDir));
      const note = payloadOf(batch.events, `authorship-note:${SHA_A}`);

      expect(note).toMatchObject({
        attestedAiLines: 19,
        schemaVersion: "authorship/3.0.0",
        unattestedAdditions: null,
      });
      expect(note).toHaveProperty("files", [
        {
          aiLines: 17,
          path: "src/app.ts",
          promptIds: ["a1b2c3d4e5f60718", "ffeeddccbbaa9988"],
        },
        {
          aiLines: 2,
          path: "src/with space.ts",
          promptIds: ["a1b2c3d4e5f60718"],
        },
      ]);
      const serialized = JSON.stringify(batch.events);
      expect(serialized).not.toContain("FIXTURE PROMPT CONTENT");
      expect(serialized).not.toContain("fixture@example.invalid");
    })
  );

  it.effect(
    "keeps unknown additions unknown and never calls share retention",
    () =>
      Effect.gen(function* statsHonesty() {
        const batch = yield* collect(inputFor(exportDir));
        const a = payloadOf(batch.events, `stats:${SHA_A}`);
        const b = payloadOf(batch.events, `stats:${SHA_B}`);
        const c = payloadOf(batch.events, `stats:${SHA_C}`);

        expect(a).toMatchObject({
          aiAdditionShareAtCommit: 19 / 40,
          retention: null,
          unattributedAdditions: 9,
        });
        expect(a).not.toHaveProperty("timeWaitingForAi");
        expect(b).toMatchObject({
          unattributedAdditions: null,
        });
        expect(JSON.stringify(b)).toContain(
          "overlap between categories is unknown"
        );
        expect(c).toMatchObject({
          aiAdditionShareAtCommit: null,
          aiAdditionShareReason: "git_diff_added_lines is 0",
        });
      })
  );

  it.effect("produces deterministic event ids across runs", () =>
    Effect.gen(function* determinism() {
      const first = yield* collect(inputFor(exportDir));
      const second = yield* collect(inputFor(exportDir));

      expect(first.events.map((event) => event.eventId)).toEqual(
        second.events.map((event) => event.eventId)
      );
    })
  );

  it.effect("requires an explicit input and reports unreadable input", () =>
    Effect.gen(function* inputErrors() {
      const missing = yield* Effect.flip(collect(inputFor(null)));

      const unreadable = yield* Effect.flip(
        collect(inputFor(`${exportDir}/does-not-exist`))
      );

      expect(missing._tag).toBe("InvalidInput");
      expect(unreadable._tag).toBe("SourceUnavailable");
    })
  );
});
