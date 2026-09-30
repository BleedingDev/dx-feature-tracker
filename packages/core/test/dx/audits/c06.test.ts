// @effect-diagnostics nodeBuiltinImport:off -- This audit builds throwaway SQLite files and spool dirs in an owned temp directory and fingerprints selected inputs.
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { NodeServices } from "@effect/platform-node";
import { afterAll, describe, expect, it } from "@effect/vitest";
import { DateTime, Effect, Schema } from "effect";

import {
  cursorHooksCollector,
  cursorHooksDescriptor,
} from "../../../src/dx/collectors/cursor-hooks/collector.js";
import { buildSpoolRecord } from "../../../src/dx/collectors/cursor-hooks/handler.js";
import type { SanitizedHook } from "../../../src/dx/collectors/cursor-hooks/spool-record.js";
import { writeSpoolRecord } from "../../../src/dx/collectors/cursor-hooks/spool.js";
import { cursorLocalDbCollector } from "../../../src/dx/collectors/cursor-local-db/collector.js";
import { cursorLocalDbDescriptor } from "../../../src/dx/collectors/cursor-local-db/descriptor.js";
import {
  cursorTranscriptCollector,
  cursorTranscriptDescriptor,
  probeCursorTranscript,
} from "../../../src/dx/collectors/cursor-transcripts/collector.js";
import {
  cursorUsageExportCollector,
  probeCursorUsageExport,
} from "../../../src/dx/collectors/cursor-usage-export/collector.js";
import { cursorUsageExportDescriptor } from "../../../src/dx/collectors/cursor-usage-export/descriptor.js";
import type { CollectInput } from "../../../src/dx/contracts/services.js";
import { ModuleDescriptorSchema } from "../../../src/dx/model/descriptor.js";
import {
  EventBatchSchema,
  emptyFlightContext,
} from "../../../src/dx/model/event.js";
import {
  admitDescriptors,
  enabledDescriptorRefs,
  snapshotCompatible,
} from "../../../src/dx/registry/admission.js";

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/c06/${name}`, import.meta.url));

const root = mkdtempSync(path.join(tmpdir(), "dxfr-c06-"));

afterAll(() => {
  rmSync(root, { force: true, recursive: true });
});

const fingerprint = (file: string) => ({
  mtimeMs: statSync(file).mtimeMs,
  sha: createHash("sha256").update(readFileSync(file)).digest("hex"),
  size: statSync(file).size,
});

const input = (
  adapterId: string,
  selectedInput: string | null,
  scratchDir: string | null = null
): CollectInput => ({
  adapterId,
  context: { ...emptyFlightContext, branch: "feature/c06" },
  cursor: null,
  origin: "fixture",
  scratchDir,
  selectedInput,
});

const makeDb = (name: string, ddl: readonly string[]): string => {
  const dir = mkdtempSync(path.join(root, "db-"));
  const file = path.join(dir, name);
  const db = new DatabaseSync(file);

  try {
    for (const statement of ddl) {
      db.exec(statement);
    }
  } finally {
    db.close();
  }

  return file;
};

const hook = (overrides: Partial<SanitizedHook>): SanitizedHook => ({
  attachmentCount: null,
  commandBin: null,
  commandHash: null,
  composerMode: null,
  conversationId: "c06-conv",
  cursorVersion: "3.22.12",
  durationMs: null,
  editCount: null,
  filePath: null,
  finalStatus: null,
  generationId: null,
  hookEvent: "sessionStart",
  isBackgroundAgent: null,
  linesAdded: null,
  linesRemoved: null,
  loopCount: null,
  model: null,
  presentKeys: [],
  promptChars: null,
  rawUsage: [],
  reason: null,
  sessionId: "c06-conv",
  status: null,
  toolName: null,
  toolUseId: null,
  workspaceRoots: [],
  ...overrides,
});

const KNOWN_AT = DateTime.toDateUtc(
  DateTime.makeUnsafe("2026-09-30T10:00:00.000Z")
);

const FUTURE_AT = DateTime.toDateUtc(
  DateTime.makeUnsafe("2026-09-30T10:00:01.000Z")
);

const git = {
  branch: "feature/c06",
  headSha: null,
  repoCommonDir: null,
  worktreePath: null,
};

describe("C06 cursor-local-db version audit", () => {
  it.effect(
    "rejects an unknown SQLite layout and leaves the source untouched",
    () =>
      Effect.gen(function* unknownDbLayout() {
        const db = makeDb("state.vscdb", [
          "create table future_layout_v9 (k text primary key, v blob)",
          "insert into future_layout_v9 values ('composerData:x', 'secret')",
        ]);

        const before = fingerprint(db);
        const scratch = mkdtempSync(path.join(root, "scratch-"));

        const error = yield* cursorLocalDbCollector
          .collect(input(cursorLocalDbDescriptor.id, db, scratch))
          .pipe(Effect.flip);

        expect(error._tag).toBe("UnsupportedSource");
        expect(error.message).toContain("future_layout_v9");
        expect(error.message).not.toContain("secret");
        expect(fingerprint(db)).toEqual(before);
        expect(readdirSync(scratch)).toEqual([]);
      })
  );

  it.effect("reads a recognised layout through a removed backup copy", () =>
    Effect.gen(function* knownDbLayout() {
      const db = makeDb("state.vscdb", [
        "create table ItemTable (key text unique on conflict replace, value blob)",
        "create table cursorDiskKV (key text unique on conflict replace, value blob)",
      ]);

      const before = fingerprint(db);
      const scratch = mkdtempSync(path.join(root, "scratch-"));

      const batch = yield* cursorLocalDbCollector.collect(
        input(cursorLocalDbDescriptor.id, db, scratch)
      );

      yield* Schema.decodeEffect(EventBatchSchema)(batch);
      expect(batch.events).toEqual([]);
      expect(batch.coverage.state).not.toBe("unsupported");
      expect(batch.coverage.gaps.map((gap) => gap.code)).toContain(
        "no-billed-charge"
      );
      expect(fingerprint(db)).toEqual(before);
      expect(readdirSync(scratch)).toEqual([]);
    })
  );

  it.effect(
    "refuses without a selection and makes its own scratch dir when none is given",
    () =>
      Effect.gen(function* noSelection() {
        const unselected = yield* cursorLocalDbCollector
          .collect(input(cursorLocalDbDescriptor.id, null, root))
          .pipe(Effect.flip);

        expect(unselected._tag).toBe("InvalidInput");

        const noScratch = yield* cursorLocalDbCollector
          .collect(
            input(cursorLocalDbDescriptor.id, fixture("README.json"), null)
          )
          .pipe(Effect.flip);

        expect(noScratch._tag).toBe("SourceUnavailable");
      })
  );

  it.effect("reports a non-SQLite selection as unavailable, not as data", () =>
    Effect.gen(function* notSqlite() {
      const file = fixture("usage-export-unknown-header.csv");
      const before = fingerprint(file);
      const scratch = mkdtempSync(path.join(root, "scratch-"));

      const error = yield* cursorLocalDbCollector
        .collect(input(cursorLocalDbDescriptor.id, file, scratch))
        .pipe(Effect.flip);

      expect(["SourceUnavailable", "UnsupportedSource"]).toContain(error._tag);
      expect(fingerprint(file)).toEqual(before);
      expect(readdirSync(scratch)).toEqual([]);
    })
  );
});

describe("C06 cursor-usage-export version audit", () => {
  for (const name of [
    "usage-export-unknown-header.csv",
    "usage-export-no-token-or-cost.csv",
  ]) {
    it.effect(`rejects ${name} as UnsupportedSource`, () =>
      Effect.gen(function* unknownCsv() {
        const file = fixture(name);
        const before = fingerprint(file);

        const error = yield* cursorUsageExportCollector
          .collect(input(cursorUsageExportDescriptor.id, file))
          .pipe(Effect.flip);

        expect(error._tag).toBe("UnsupportedSource");
        expect(fingerprint(file)).toEqual(before);
      }).pipe(Effect.provide(NodeServices.layer))
    );
  }

  it.effect("probe of an unknown CSV never reports a supported layout", () =>
    Effect.gen(function* probeUnknownCsv() {
      const probe = yield* probeCursorUsageExport(
        fixture("usage-export-unknown-header.csv")
      );

      expect(probe.present).toBe(true);
      expect(probe.readable).toBe(true);
      expect(probe.layout).toBeNull();
      expect(probe.itemCount).toBeNull();
      expect(probe.notes).toEqual([
        "header not recognized as a Cursor usage export",
      ]);
    }).pipe(Effect.provide(NodeServices.layer))
  );
});

describe("C06 cursor-transcripts version audit", () => {
  for (const name of [
    "transcript-unknown-layout.jsonl",
    "transcript-unknown-layout.txt",
  ]) {
    it.effect(`marks ${name} unsupported with zero events`, () =>
      Effect.gen(function* unknownTranscript() {
        const file = fixture(name);
        const before = fingerprint(file);

        const batch = yield* cursorTranscriptCollector.collect(
          input(cursorTranscriptDescriptor.id, file)
        );

        yield* Schema.decodeEffect(EventBatchSchema)(batch);
        expect(batch.events).toEqual([]);
        expect(batch.coverage.state).toBe("unsupported");
        expect(batch.coverage.gaps.length).toBeGreaterThan(0);
        expect(fingerprint(file)).toEqual(before);

        const probe = yield* probeCursorTranscript(file);
        expect(probe.layout).toBe("unrecognized");
        expect(probe.itemCount).toBe(0);
      }).pipe(Effect.provide(NodeServices.layer))
    );
  }
});

describe("C06 cursor-hooks version audit", () => {
  it.effect(
    "rejects a future spool version and flags unknown hook events",
    () =>
      Effect.gen(function* futureSpool() {
        const spool = mkdtempSync(path.join(root, "spool-"));

        const known = buildSpoolRecord(hook({}), git, KNOWN_AT);

        const future = buildSpoolRecord(
          hook({ cursorVersion: "99.0.0", hookEvent: "futureHookEvent" }),
          git,
          FUTURE_AT
        );

        writeSpoolRecord(spool, known);
        writeSpoolRecord(spool, future);
        writeFileSync(
          path.join(spool, "000000000000002-c06future.json"),
          readFileSync(fixture("spool-future-version.json"))
        );

        const before = readdirSync(spool)
          .toSorted()
          .map((name) => fingerprint(path.join(spool, name)));

        const batch = yield* cursorHooksCollector.collect(
          input(cursorHooksDescriptor.id, spool)
        );

        yield* Schema.decodeEffect(EventBatchSchema)(batch);
        const codes = batch.coverage.gaps.map((gap) => gap.code);
        expect(codes).toContain("spool-record-rejected");
        expect(codes).toContain("unknown-hook-event");
        expect(batch.coverage.state).toBe("partial");
        expect(batch.coverage.observedItems).toBe(2);
        expect(batch.coverage.expectedItems).toBe(3);

        const unknown = batch.events.filter(
          (event) => event.payload.supportedHookEvent === false
        );

        expect(unknown.length).toBeGreaterThan(0);

        for (const event of unknown) {
          expect(event.kind).toBe("other");
        }

        expect(
          readdirSync(spool)
            .toSorted()
            .map((name) => fingerprint(path.join(spool, name)))
        ).toEqual(before);
      })
  );

  it.effect(
    "missing spool directory is unavailable, not an empty success",
    () =>
      Effect.gen(function* missingSpool() {
        const missing = path.join(root, "never-created-spool");

        const error = yield* cursorHooksCollector
          .collect(input(cursorHooksDescriptor.id, missing))
          .pipe(Effect.flip);

        expect(error._tag).toBe("SourceUnavailable");
      })
  );
});

describe("C06 descriptor/version admission audit", () => {
  const cursorDescriptors = [
    cursorHooksDescriptor,
    cursorLocalDbDescriptor,
    cursorTranscriptDescriptor,
    cursorUsageExportDescriptor,
  ];

  it("cursor descriptors decode and carry fixture ids", () => {
    for (const descriptor of cursorDescriptors) {
      expect(() =>
        Schema.decodeSync(ModuleDescriptorSchema)(descriptor)
      ).not.toThrow();
      expect(descriptor.fixtureIds.length).toBeGreaterThan(0);
    }
  });

  it("rejects a descriptor built against a different contract version", () => {
    const [first] = cursorDescriptors;

    if (first === undefined) {
      throw new Error("no cursor descriptors");
    }

    const future = { ...first, contractVersion: "dx.contracts.v9" };
    const result = admitDescriptors([future]);
    expect(result.admitted).toEqual([]);
    expect(result.rejected).toEqual([
      { id: first.id, readiness: first.readiness, reason: "contract-mismatch" },
    ]);
  });

  it("unsupported/disabled descriptors are listed but never admitted", () => {
    const [first, second] = cursorDescriptors;

    if (first === undefined || second === undefined) {
      throw new Error("no cursor descriptors");
    }

    const result = admitDescriptors([
      { ...first, readiness: "unsupported" },
      { ...second, readiness: "disabled" },
    ]);

    expect(result.admitted).toEqual([]);
    expect(result.listed.map((d) => d.id).toSorted()).toEqual(
      [first.id, second.id].toSorted()
    );
    expect(result.rejected.map((r) => r.reason)).toEqual([
      "not-ready",
      "not-ready",
    ]);
  });

  it("a snapshot taken under an older adapter version is incompatible", () => {
    const current = admitDescriptors(
      cursorDescriptors.map((d) => ({ ...d, readiness: "ready" as const }))
    );

    const refs = enabledDescriptorRefs(current);
    expect(snapshotCompatible(refs, current)).toBe(true);

    const stale = refs.map((ref, index) =>
      index === 0 ? { ...ref, version: "0.0.0-older" } : ref
    );

    expect(snapshotCompatible(stale, current)).toBe(false);
  });
});
