import type { Effect } from "effect";

import type { AttributionState, Origin } from "../model/common.js";
import type { CollectCursor, SourceCoverage } from "../model/coverage.js";
import type { ModuleDescriptor } from "../model/descriptor.js";
import type {
  DxEventEnvelope,
  EventBatch,
  FlightContext,
} from "../model/event.js";
import type { EvidenceId, SnapshotId } from "../model/ids.js";
import type {
  FindingCandidate,
  MetricDefinitionRef,
  MetricResult,
} from "../model/metric.js";
import type { AnalyzeReport } from "../model/report.js";
import type { SnapshotManifest, SnapshotSelector } from "../model/snapshot.js";
import type { Cancelled } from "./error-cancelled.js";
import type { GitHubApiError } from "./error-github-api.js";
import type { InvalidInput } from "./error-invalid-input.js";
import type { SnapshotNotFound } from "./error-snapshot-not-found.js";
import type { SourceUnavailable } from "./error-source-unavailable.js";
import type { StoreBusy } from "./error-store-busy.js";
import type { StoreError } from "./error-store-error.js";
import type { UnsupportedSource } from "./error-unsupported-source.js";

export interface CollectInput {
  readonly adapterId: string;
  readonly selectedInput: string | null;
  readonly context: FlightContext;
  readonly cursor: CollectCursor | null;
  readonly scratchDir: string | null;
  readonly origin: Origin;
}

export type CollectError =
  | UnsupportedSource
  | SourceUnavailable
  | InvalidInput
  | Cancelled
  | GitHubApiError;

export interface DxCollector<R = never> {
  readonly descriptor: ModuleDescriptor;
  readonly collect: (
    input: CollectInput
  ) => Effect.Effect<EventBatch, CollectError, R>;
}

export interface AppendResult {
  readonly duplicates: number;
  readonly inserted: number;
}

export interface StoreSnapshot {
  readonly coverage: readonly SourceCoverage[];
  readonly events: readonly DxEventEnvelope[];
  readonly manifest: SnapshotManifest;
}

export type StoreFailure = StoreBusy | StoreError;

export interface EventStoreService {
  readonly append: (
    batch: EventBatch
  ) => Effect.Effect<AppendResult, StoreFailure>;
  readonly snapshot: (
    selector: SnapshotSelector
  ) => Effect.Effect<StoreSnapshot, StoreFailure>;
  readonly putSnapshotManifest: (
    manifest: SnapshotManifest
  ) => Effect.Effect<void, StoreFailure>;
  readonly getSnapshot: (
    snapshotId: SnapshotId
  ) => Effect.Effect<StoreSnapshot, StoreFailure | SnapshotNotFound>;
  readonly latestSnapshotId: (
    selector: SnapshotSelector
  ) => Effect.Effect<SnapshotId | null, StoreFailure>;
  readonly coverage: (
    selector: SnapshotSelector
  ) => Effect.Effect<readonly SourceCoverage[], StoreFailure>;
  readonly snapshotCount: Effect.Effect<number, StoreFailure>;
  readonly storePath: string | null;
}

export interface Correlation {
  readonly attribution: AttributionState;
  readonly evidenceIds: readonly EvidenceId[];
  readonly eventId: string;
  readonly target: string | null;
  readonly targetKind: string;
  readonly reason: string;
}

export interface CorrelationMapping {
  readonly key: string;
  readonly value: string;
}

export interface DxCorrelator {
  readonly descriptor: ModuleDescriptor;
  readonly correlate: (
    events: readonly DxEventEnvelope[],
    mappings: readonly CorrelationMapping[]
  ) => readonly Correlation[];
}

export interface MetricOutput {
  readonly findings: readonly FindingCandidate[];
  readonly results: readonly MetricResult[];
}

export interface DxMetric {
  readonly definitions: readonly MetricDefinitionRef[];
  readonly descriptor: ModuleDescriptor;
  readonly compute: (snapshot: StoreSnapshot) => MetricOutput;
}

export interface ReportComposerService {
  readonly analyze: (
    snapshot: StoreSnapshot,
    outputs: readonly MetricOutput[]
  ) => AnalyzeReport;
}

export interface GitHubRequest {
  readonly route: string;
  readonly params: Readonly<Record<string, string | number>>;
  readonly etag: string | null;
  readonly maxPages: number;
}

export interface GitHubPage {
  readonly body: unknown;
  readonly etag: string | null;
  readonly fromCache: boolean;
  readonly partial: boolean;
  readonly rateLimitRemaining: number | null;
  readonly status: number;
}

export interface GitHubProbe {
  readonly authenticated: boolean;
  readonly rateLimitRemaining: number | null;
}

export interface GitHubApiBrokerService {
  readonly request: (
    request: GitHubRequest
  ) => Effect.Effect<readonly GitHubPage[], GitHubApiError | Cancelled>;
  readonly probe: Effect.Effect<GitHubProbe, GitHubApiError>;
}
