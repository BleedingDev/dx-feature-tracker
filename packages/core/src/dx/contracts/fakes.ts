import { Effect, Layer } from "effect";

import type { SourceCoverage } from "../model/coverage.js";
import type { ModuleDescriptor } from "../model/descriptor.js";
import type { DxEventEnvelope } from "../model/event.js";
import {
  DescriptorIdSchema,
  EvidenceIdSchema,
  MetricIdSchema,
  SnapshotIdSchema,
} from "../model/ids.js";
import type { AnalyzeReport } from "../model/report.js";
import type { SnapshotManifest, SnapshotSelector } from "../model/snapshot.js";
import { SnapshotNotFound } from "./error-snapshot-not-found.js";
import { EventStore } from "./event-store.js";
import { GitHubApiBroker } from "./github-api-broker.js";
import { ReportComposer } from "./report-composer.js";
import type {
  DxCollector,
  DxMetric,
  EventStoreService,
  GitHubApiBrokerService,
  ReportComposerService,
  StoreSnapshot,
} from "./services.js";
import { CONTRACT_DIGEST, CONTRACT_VERSION } from "./version.js";

export const FAKE_TIMESTAMP = "2026-01-01T00:00:00.000Z";

export const fakeDescriptor = (
  id: string,
  kind: ModuleDescriptor["kind"],
  owner: string
): ModuleDescriptor => ({
  contractVersion: CONTRACT_VERSION,
  fixtureIds: [],
  gaps: [{ code: "fake", message: "compile-only fake implementation" }],
  id: DescriptorIdSchema.make(id),
  kind,
  owner,
  readiness: "disabled",
  requiredInputs: [],
  supportedFields: [],
  version: "0.0.0-fake",
});

export const emptyCoverage = (adapterId: string): SourceCoverage => ({
  adapterId,
  expectedItems: null,
  gaps: [],
  observedItems: 0,
  state: "none",
  watermark: null,
  windowFrom: null,
  windowTo: null,
});

export const emptySelector: SnapshotSelector = {
  branch: null,
  flightId: null,
  from: null,
  repoCommonDir: null,
  to: null,
};

export const fakeManifest = (
  snapshotId: string,
  selector: SnapshotSelector = emptySelector
): SnapshotManifest => ({
  contractDigest: CONTRACT_DIGEST,
  contractVersion: CONTRACT_VERSION,
  createdAt: FAKE_TIMESTAMP,
  enabledDescriptors: [],
  eventWatermark: "0",
  metricDefinitions: [],
  originMix: [],
  selector,
  snapshotId: SnapshotIdSchema.make(snapshotId),
});

export const makeFakeCollector = (
  events: readonly DxEventEnvelope[] = []
): DxCollector => ({
  collect: (input) =>
    Effect.succeed({
      coverage: {
        ...emptyCoverage(input.adapterId),
        observedItems: events.length,
      },
      cursor: null,
      events,
    }),
  descriptor: fakeDescriptor("collector/fake", "collector", "A03"),
});

export const makeFakeEventStore = (): EventStoreService => {
  const events = new Map<string, DxEventEnvelope>();
  const manifests = new Map<string, SnapshotManifest>();

  const snapshotOf = (manifest: SnapshotManifest): StoreSnapshot => ({
    coverage: [],
    events: [...events.values()],
    manifest,
  });

  return {
    append: (batch) =>
      Effect.sync(() => {
        let inserted = 0;

        for (const event of batch.events) {
          if (!events.has(event.eventId)) {
            events.set(event.eventId, event);
            inserted += 1;
          }
        }

        return { duplicates: batch.events.length - inserted, inserted };
      }),
    coverage: () => Effect.succeed([]),
    getSnapshot: (snapshotId) => {
      const manifest = manifests.get(snapshotId);

      return manifest === undefined
        ? Effect.fail(
            new SnapshotNotFound({
              message: "unknown snapshot",
              snapshotId,
            })
          )
        : Effect.succeed(snapshotOf(manifest));
    },
    latestSnapshotId: () => {
      const ids = [...manifests.keys()];
      const last = ids.at(-1);

      return Effect.succeed(
        last === undefined ? null : SnapshotIdSchema.make(last)
      );
    },
    putSnapshotManifest: (manifest) =>
      Effect.sync(() => {
        manifests.set(manifest.snapshotId, manifest);
      }),
    snapshot: (selector) =>
      Effect.succeed(snapshotOf(fakeManifest("fake-current", selector))),
    snapshotCount: Effect.sync(() => manifests.size),
    storePath: null,
  };
};

export const fakeGitHubApiBroker: GitHubApiBrokerService = {
  probe: Effect.succeed({ authenticated: false, rateLimitRemaining: null }),
  request: () => Effect.succeed([]),
};

export const fakeMetric: DxMetric = {
  compute: () => ({
    findings: [],
    results: [
      {
        asOf: FAKE_TIMESTAMP,
        attribution: "not-applicable",
        checkpoint: null,
        coverage: [],
        definition: {
          description: "fake metric",
          id: MetricIdSchema.make("fake"),
          unit: "count",
          version: "0",
        },
        denominator: null,
        evidenceIds: [EvidenceIdSchema.make("fake-evidence")],
        measurement: "unavailable",
        method: "derived",
        metricId: MetricIdSchema.make("fake"),
        numerator: null,
        reason: "compile-only fake",
        unit: "count",
        value: null,
      },
    ],
  }),
  definitions: [],
  descriptor: fakeDescriptor("metric/fake", "metric", "A03"),
};

export const fakeReportComposer: ReportComposerService = {
  analyze: (snapshot, outputs): AnalyzeReport => ({
    coverage: snapshot.coverage,
    findings: outputs.flatMap((o) => o.findings),
    flightId: snapshot.manifest.selector.flightId,
    metrics: outputs.flatMap((o) => o.results),
    notes: [],
    schemaVersion: "dx.report.v1",
    snapshot: snapshot.manifest,
  }),
};

export const FakeEventStoreLayer = Layer.sync(EventStore, makeFakeEventStore);

export const FakeGitHubApiBrokerLayer = Layer.succeed(
  GitHubApiBroker,
  fakeGitHubApiBroker
);

export const FakeReportComposerLayer = Layer.succeed(
  ReportComposer,
  fakeReportComposer
);
