// @effect-diagnostics nodeBuiltinImport:off -- This test reads the committed B37 fixture file from disk.
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  emptyCoverage,
  emptySelector,
  fakeManifest,
  makeFakeEventStore,
} from "../../src/dx/contracts/fakes.js";
import type { StoreSnapshot } from "../../src/dx/contracts/services.js";
import { ModuleDescriptorSchema } from "../../src/dx/model/descriptor.js";
import type { DxEventEnvelope } from "../../src/dx/model/event.js";
import {
  emptyEventIdentity,
  emptyFlightContext,
  EventKindSchema,
} from "../../src/dx/model/event.js";
import { EventIdSchema } from "../../src/dx/model/ids.js";
import { EvidenceItemSchema } from "../../src/dx/model/report.js";
import { evidenceReportDescriptor } from "../../src/dx/reports/evidence/descriptor.js";
import {
  boundRef,
  excerptPayload,
  MAX_EXCERPT_CHARS,
  MAX_REF_CHARS,
  redactText,
} from "../../src/dx/reports/evidence/redact.js";
import {
  lookupEvidence,
  MAX_EVIDENCE_IDS,
  resolveEvidence,
} from "../../src/dx/reports/evidence/resolve.js";

const FixtureSchema = Schema.Struct({
  events: Schema.Array(
    Schema.Struct({
      adapterId: Schema.String,
      hash: Schema.NullOr(Schema.String),
      id: Schema.String,
      kind: EventKindSchema,
      payload: Schema.Record(Schema.String, Schema.Unknown),
      ref: Schema.String,
    })
  ),
  note: Schema.String,
  origin: Schema.Literal("fixture"),
});

const fixture = Schema.decodeUnknownSync(FixtureSchema)(
  JSON.parse(
    readFileSync(
      path.join(import.meta.dirname, "fixtures/b37/b37-events.json"),
      "utf-8"
    )
  )
);

const toEnvelope = (
  entry: (typeof fixture.events)[number],
  overrides: Partial<DxEventEnvelope> = {}
): DxEventEnvelope => ({
  acquisition: "file-import",
  adapterId: entry.adapterId,
  adapterVersion: "fixture",
  context: emptyFlightContext,
  eventId: EventIdSchema.make(entry.id),
  evidence: { bounded: true, hash: entry.hash, ref: entry.ref },
  fieldSemantics: [],
  identity: emptyEventIdentity,
  kind: entry.kind,
  observedAt: "2026-09-30T12:00:00.000Z",
  occurredAt: "2026-09-30T12:00:00.000Z",
  occurredAtPrecision: "exact",
  origin: "fixture",
  payload: entry.payload,
  schemaVersion: "dx.event.v1",
  sourceVersion: null,
  upstreamKey: entry.id,
  ...overrides,
});

const must = <A>(value: A | undefined): A => {
  if (value === undefined) {
    throw new Error("b37 fixture entry missing");
  }

  return value;
};

const events = fixture.events.map((entry) => toEnvelope(entry));

const snapshotOf = (
  list: readonly DxEventEnvelope[],
  id = "b37-snap"
): StoreSnapshot => ({
  coverage: [],
  events: list,
  manifest: fakeManifest(id),
});

const fakeGithubToken = ["ghp", "_", "A".repeat(36)].join("");

const fakeOpenAiKey = ["sk", "-", "proj", "B".repeat(24)].join("");

const fakeJwt = [
  "eyJ",
  "hbGciOiJI",
  ".",
  "eyJ",
  "zdWIiOiIx",
  ".",
  "SflKxwRJSMeKKF2QT4",
].join("");

const assertNoSecrets = (text: string): void => {
  expect(text).not.toContain(fakeGithubToken);
  expect(text).not.toContain(fakeOpenAiKey);
  expect(text).not.toContain(fakeJwt);
  expect(text).not.toContain("hunter2");
  expect(text).not.toContain("fixture-user");
  expect(text).not.toContain("dev@example.com");
};

describe("b37 redaction", () => {
  it("scrubs token, key, jwt, credential, email and home path shapes", () => {
    const raw = `auth ${fakeGithubToken} key=${fakeOpenAiKey} jwt ${fakeJwt} password=hunter2 mail dev@example.com at /Users/fixture-user/repo`;
    const result = redactText(raw);
    expect(result.redacted).toBe(true);
    assertNoSecrets(result.text);
    expect(result.text).toContain("~/repo");
    expect(redactText("plain metadata").redacted).toBe(false);
  });

  it("bounds refs: strips url credentials/query, collapses home, truncates", () => {
    const url = boundRef(
      `https://user:hunter2@example.test/path?token=${fakeGithubToken}#frag`
    );

    expect(url.text).toBe("https://example.test/path");
    expect(url.redacted).toBe(true);
    const long = boundRef(`git:ref/${"x".repeat(1000)}`);
    expect(long.text.length).toBeLessThanOrEqual(MAX_REF_CHARS);
    expect(long.redacted).toBe(true);
    const control = boundRef("git:ref\n/evil\u0007");
    expect(control.text).toBe("git:ref/evil");
    expect(control.redacted).toBe(true);
    const plain = boundRef("git:commit/abc");
    expect(plain).toEqual({ redacted: false, text: "git:commit/abc" });
  });

  it("withholds content fields, redacts secret keys, keeps numeric metadata", () => {
    const result = excerptPayload({
      apiKey: "abc",
      durationMs: 12,
      nested: { authorization: "x", deep: { deeper: 1 }, model: "m" },
      prompt: "tell me everything",
      tags: ["a", "b"],
    });

    expect(result.excerpt).toContain("durationMs=12");
    expect(result.excerpt).toContain("nested.model=m");
    expect(result.excerpt).toContain("prompt=[withheld:18 chars]");
    expect(result.excerpt).toContain("apiKey=[redacted]");
    expect(result.excerpt).toContain("nested.authorization=[redacted]");
    expect(result.excerpt).toContain("tags=[array:2]");
    expect(result.excerpt).not.toContain("tell me everything");
    expect(result.redacted).toBe(true);
  });

  it("bounds oversized payloads and reports dropped fields", () => {
    const payload = Object.fromEntries(
      Array.from({ length: 60 }, (_, index) => [
        `field${String(index).padStart(2, "0")}`,
        "v".repeat(100),
      ])
    );

    const result = excerptPayload(payload);
    expect(result.excerpt?.length).toBeLessThanOrEqual(MAX_EXCERPT_CHARS);
    expect(result.droppedFields).toBeGreaterThan(0);
    expect(result.redacted).toBe(true);
  });
});

describe("b37 evidence resolution", () => {
  it("returns schema-valid redacted items and never raw content", () => {
    const secretEvent = toEnvelope(must(fixture.events[1]), {
      payload: {
        ...must(fixture.events[1]).payload,
        branchNote: `token ${fakeGithubToken} by dev@example.com`,
      },
    });

    const snapshot = snapshotOf([
      must(events[0]),
      secretEvent,
      must(events[2]),
    ]);

    const result = resolveEvidence(snapshot, [
      "b37-evt-usage",
      "b37-evt-command",
      "b37-evt-empty",
    ]);

    expect(result.snapshotId).toBe("b37-snap");
    expect(result.missing).toEqual([]);
    const decode = Schema.decodeUnknownSync(EvidenceItemSchema);

    for (const item of result.items) {
      decode(item);
      assertNoSecrets(JSON.stringify(item));
      expect(item.origin).toBe("fixture");
    }

    const usage = must(result.items[0]);
    const command = must(result.items[1]);
    const empty = must(result.items[2]);
    expect(usage.excerpt).toContain("usage.inputTokens=1200");
    expect(usage.excerpt).toContain("usage.cachedInputTokens=null");
    expect(usage.excerpt).not.toContain("billing module");
    expect(usage.redacted).toBe(true);
    expect(command.ref).toBe("file://~/work/repo/.dx/spool/cmd-0002.json");
    expect(command.excerpt).toContain("exitCode=1");
    expect(command.excerpt).toContain("cwd=~/work/repo");
    expect(command.excerpt).not.toContain("pnpm test");
    expect(command.excerpt).not.toContain("FAIL");
    expect(empty).toMatchObject({ excerpt: null, redacted: false });
  });

  it("hidden mode returns refs only", () => {
    const result = resolveEvidence(
      snapshotOf(events),
      ["b37-evt-usage"],
      "hidden"
    );

    expect(result.items[0]).toMatchObject({ excerpt: null, redacted: true });
  });

  it("resolves by evidence hash and reports unknown, invalid and over-limit IDs", () => {
    const hashId = must(fixture.events[0]).hash ?? "";

    const extra = Array.from(
      { length: MAX_EVIDENCE_IDS + 2 },
      (_, index) => `pad-${index}`
    );

    const result = resolveEvidence(snapshotOf(events), [
      hashId,
      "does-not-exist",
      "  ",
      ...extra,
    ]);

    expect(result.items.map((item) => item.evidenceId)).toEqual([hashId]);
    const reasons = result.missing.map((miss) => miss.reason);
    expect(reasons).toContain("unknown-in-snapshot");
    expect(reasons).toContain("invalid-id");
    expect(reasons.filter((reason) => reason === "over-limit")).toHaveLength(5);
    expect(result.disclosures.join(" ")).toContain(
      "not returned from snapshot b37-snap"
    );
    expect(result.disclosures.join(" ")).toContain("skipped");
  });

  it("descriptor decodes and is ready", () => {
    const descriptor = Schema.decodeSync(ModuleDescriptorSchema)(
      evidenceReportDescriptor
    );

    expect(descriptor.readiness).toBe("ready");
    expect(descriptor.kind).toBe("report");
  });
});

describe("b37 snapshot pinning", () => {
  it.effect("reuses a requested snapshot ID", () =>
    Effect.gen(function* b37Case() {
      const store = makeFakeEventStore();
      yield* store.append({
        coverage: emptyCoverage("fixture"),
        cursor: null,
        events,
      });
      yield* store.putSnapshotManifest(fakeManifest("b37-pinned"));

      const result = yield* lookupEvidence(store, {
        asOf: null,
        evidenceIds: ["b37-evt-usage"],
        selector: emptySelector,
        snapshotId: "b37-pinned",
      });

      expect(result.snapshotId).toBe("b37-pinned");
      expect(result.items).toHaveLength(1);
      expect(result.disclosures[0]).toContain(
        "Reused requested snapshot b37-pinned"
      );
    })
  );

  it.effect(
    "fails explicitly on unknown snapshot, never substitutes latest",
    () =>
      Effect.gen(function* b37Case() {
        const store = makeFakeEventStore();
        yield* store.putSnapshotManifest(fakeManifest("b37-other"));

        const error = yield* Effect.flip(
          lookupEvidence(store, {
            asOf: null,
            evidenceIds: ["b37-evt-usage"],
            selector: emptySelector,
            snapshotId: "b37-missing",
          })
        );

        expect(error._tag).toBe("SnapshotNotFound");
      })
  );

  it.effect("latest discloses the actual snapshot ID", () =>
    Effect.gen(function* b37Case() {
      const store = makeFakeEventStore();

      const result = yield* lookupEvidence(store, {
        asOf: null,
        evidenceIds: ["b37-evt-usage"],
        selector: emptySelector,
        snapshotId: null,
      });

      expect(result.snapshotId).toBe("fake-current");
      expect(result.disclosures[0]).toContain("latest snapshot fake-current");
      expect(result.missing[0]?.reason).toBe("unknown-in-snapshot");
    })
  );
});
