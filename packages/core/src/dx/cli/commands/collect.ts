import { DateTime, Effect } from "effect";

import { InvalidInput } from "../../contracts/error-invalid-input.js";
import type { StoreError } from "../../contracts/error-store-error.js";
import { UnsupportedSource } from "../../contracts/error-unsupported-source.js";
import type {
  CollectError,
  DxCollector,
  StoreFailure,
} from "../../contracts/services.js";
import type { Harness, ReadError, SessionRef } from "../../harness/contract.js";
import type { Origin } from "../../model/common.js";
import type { CollectCursor, SourceCoverage } from "../../model/coverage.js";
import type { EventBatch, FlightContext } from "../../model/event.js";
import { drainSpool, writeSpoolBatch } from "../../storage/spool.js";
import type { SpoolDrainResult } from "../../storage/spool.js";
import { spoolDirFor } from "../../storage/store-path.js";
import type { DxCommandEnv } from "./context.js";

export interface CollectRequest {
  readonly context: FlightContext;
  readonly source: string | null;
  readonly input: string | null;
  readonly scratchDir?: string | null;
}

export interface CollectResult {
  readonly adapterId: string;
  readonly coverage: SourceCoverage;
  readonly duplicates: number;
  readonly events: number;
  readonly inserted: number;
  readonly origin: Origin;
  readonly spooledTo: string | null;
  readonly storePath: string;
}

interface SpoolableAppend {
  readonly duplicates: number;
  readonly inserted: number;
  readonly spooledTo: string | null;
}

const adapterIdOf = (collector: DxCollector<unknown>): string => {
  const { id } = collector.descriptor;

  return id.startsWith("collector/") ? id.slice("collector/".length) : id;
};

export const findCollector = <R>(
  collectors: readonly DxCollector<R>[],
  source: string
): DxCollector<R> | undefined =>
  collectors.find(
    (c) => c.descriptor.id === source || adapterIdOf(c) === source
  );

const appendCollected = (
  env: DxCommandEnv,
  batch: EventBatch,
  origin: Origin
): Effect.Effect<CollectResult, StoreFailure | StoreError> =>
  Effect.map(
    env.store.append(batch).pipe(
      Effect.map((r): SpoolableAppend => ({ ...r, spooledTo: null })),
      Effect.catchTag("StoreBusy", () =>
        Effect.map(
          writeSpoolBatch(spoolDirFor(env.storePath), batch),
          (spooledTo): SpoolableAppend => ({
            duplicates: 0,
            inserted: 0,
            spooledTo,
          })
        )
      )
    ),
    (appended): CollectResult => ({
      adapterId: batch.coverage.adapterId,
      coverage: batch.coverage,
      duplicates: appended.duplicates,
      events: batch.events.length,
      inserted: appended.inserted,
      origin,
      spooledTo: appended.spooledTo,
      storePath: env.storePath,
    })
  );

export const runCollect = <R>(
  env: DxCommandEnv,
  collectors: readonly DxCollector<R>[],
  request: CollectRequest
): Effect.Effect<CollectResult, CollectError | StoreFailure | StoreError, R> =>
  Effect.gen(function* collect() {
    if (request.source === null || request.source.trim() === "") {
      return yield* new InvalidInput({
        field: "source",
        message: `no source selected; choose one of: ${collectors.map((c) => c.descriptor.id).join(", ")}`,
      });
    }

    const collector = findCollector(collectors, request.source.trim());

    if (collector === undefined) {
      return yield* new UnsupportedSource({
        adapterId: request.source,
        message: `unknown source ${request.source}; registered: ${collectors.map((c) => c.descriptor.id).join(", ")}`,
        sourceVersion: null,
      });
    }

    if (
      collector.descriptor.readiness === "disabled" ||
      collector.descriptor.readiness === "unsupported"
    ) {
      return yield* new UnsupportedSource({
        adapterId: collector.descriptor.id,
        message: `source ${collector.descriptor.id} is ${collector.descriptor.readiness}: ${collector.descriptor.gaps.map((g) => g.message).join(" ")}`,
        sourceVersion: null,
      });
    }

    const origin: Origin = request.input === null ? "live" : "imported";

    const batch = yield* collector.collect({
      adapterId: adapterIdOf(collector),
      context: request.context,
      cursor: null,
      origin,
      scratchDir: request.scratchDir ?? null,
      selectedInput: request.input,
    });

    return yield* appendCollected(env, batch, origin);
  });

export interface HarnessReadRequest {
  readonly context: FlightContext;
  readonly cursor?: CollectCursor | null;
  readonly harness: Harness;
  readonly ref: SessionRef;
}

export interface HarnessReadResult extends CollectResult {
  readonly cursor: CollectCursor | null;
  readonly lastEventId: string | null;
  readonly unsettled: boolean;
}

export const runHarnessRead = (
  env: DxCommandEnv,
  request: HarnessReadRequest
): Effect.Effect<HarnessReadResult, ReadError | StoreFailure | StoreError> =>
  Effect.flatMap(
    request.harness.read(request.ref, {
      context: request.context,
      cursor: request.cursor ?? null,
      origin: "imported",
    }),
    (batch) =>
      Effect.map(
        appendCollected(env, batch, "imported"),
        (result): HarnessReadResult => ({
          ...result,
          cursor: batch.cursor,
          lastEventId: batch.events.at(-1)?.eventId ?? null,
          unsettled: batch.unsettled === true,
        })
      )
  );

export interface ImportSpoolResult extends SpoolDrainResult {
  readonly drainedAt: string;
  readonly spoolDir: string;
}

export const runImportSpool = (
  env: DxCommandEnv
): Effect.Effect<ImportSpoolResult, StoreFailure> =>
  Effect.gen(function* importSpool() {
    const spoolDir = spoolDirFor(env.storePath);
    const result = yield* drainSpool(env.store, spoolDir);
    const drainedAt = DateTime.formatIso(yield* DateTime.now);

    return { ...result, drainedAt, spoolDir };
  });
