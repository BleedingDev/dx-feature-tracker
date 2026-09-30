import { Effect } from "effect";

import type { SnapshotNotFound } from "../../contracts/error-snapshot-not-found.js";
import type {
  EventStoreService,
  StoreFailure,
  StoreSnapshot,
} from "../../contracts/services.js";
import type { DxEventEnvelope } from "../../model/event.js";
import { EvidenceIdSchema, SnapshotIdSchema } from "../../model/ids.js";
import type { SnapshotId } from "../../model/ids.js";
import type { EvidenceItem } from "../../model/report.js";
import type { SnapshotSelector } from "../../model/snapshot.js";
import { selectAnalyzeSnapshot } from "../analyze/select.js";
import { boundRef, excerptPayload } from "./redact.js";

export const MAX_EVIDENCE_IDS = 100;

export type EvidenceMode = "metadata" | "hidden";

export interface EvidenceMiss {
  readonly evidenceId: string;
  readonly reason: "unknown-in-snapshot" | "invalid-id" | "over-limit";
}

export interface EvidenceResolution {
  readonly snapshotId: SnapshotId;
  readonly items: readonly EvidenceItem[];
  readonly missing: readonly EvidenceMiss[];
  readonly disclosures: readonly string[];
}

const indexEvents = (
  events: readonly DxEventEnvelope[]
): ReadonlyMap<string, DxEventEnvelope> => {
  const index = new Map<string, DxEventEnvelope>();

  for (const event of events) {
    if (event.evidence.hash !== null && !index.has(event.evidence.hash)) {
      index.set(event.evidence.hash, event);
    }
  }

  for (const event of events) {
    index.set(event.eventId, event);
  }

  return index;
};

export const toEvidenceItem = (
  evidenceId: string,
  event: DxEventEnvelope,
  mode: EvidenceMode
): EvidenceItem => {
  const ref = boundRef(event.evidence.ref);

  const excerpt =
    mode === "hidden"
      ? {
          excerpt: null,
          redacted: Object.keys(event.payload).length > 0,
        }
      : excerptPayload(event.payload);

  return {
    adapterId: event.adapterId,
    evidenceId: EvidenceIdSchema.make(evidenceId),
    excerpt: excerpt.excerpt,
    origin: event.origin,
    redacted: ref.redacted || excerpt.redacted,
    ref: ref.text,
  };
};

export const resolveEvidence = (
  snapshot: StoreSnapshot,
  evidenceIds: readonly string[],
  mode: EvidenceMode = "metadata"
): EvidenceResolution => {
  const index = indexEvents(snapshot.events);
  const unique = [...new Set(evidenceIds)];
  const items: EvidenceItem[] = [];
  const missing: EvidenceMiss[] = [];

  for (const [position, evidenceId] of unique.entries()) {
    const trimmed = evidenceId.trim();

    if (position >= MAX_EVIDENCE_IDS) {
      missing.push({ evidenceId, reason: "over-limit" });
    } else if (trimmed === "" || trimmed.length > 256) {
      missing.push({ evidenceId: trimmed.slice(0, 64), reason: "invalid-id" });
    } else {
      const event = index.get(trimmed);

      if (event === undefined) {
        missing.push({ evidenceId: trimmed, reason: "unknown-in-snapshot" });
      } else {
        items.push(toEvidenceItem(trimmed, event, mode));
      }
    }
  }

  const disclosures: string[] = [];

  if (missing.length > 0) {
    disclosures.push(
      `${missing.length} requested evidence ID(s) not returned from snapshot ${snapshot.manifest.snapshotId}.`
    );
  }

  if (unique.length > MAX_EVIDENCE_IDS) {
    disclosures.push(
      `Request limited to ${MAX_EVIDENCE_IDS} evidence IDs; ${unique.length - MAX_EVIDENCE_IDS} skipped.`
    );
  }

  if (items.some((item) => item.redacted)) {
    disclosures.push(
      "Some evidence was redacted or bounded; raw content is never returned by dx_evidence."
    );
  }

  return {
    disclosures,
    items,
    missing,
    snapshotId: snapshot.manifest.snapshotId,
  };
};

export interface EvidenceLookupRequest {
  readonly evidenceIds: readonly string[];
  readonly snapshotId: string | null;
  readonly asOf: string | null;
  readonly selector: SnapshotSelector;
  readonly mode?: EvidenceMode;
}

export const lookupEvidence = (
  store: EventStoreService,
  request: EvidenceLookupRequest
): Effect.Effect<EvidenceResolution, StoreFailure | SnapshotNotFound> =>
  Effect.map(
    selectAnalyzeSnapshot(store, {
      asOf: request.asOf,
      selector: request.selector,
      snapshotId:
        request.snapshotId === null
          ? null
          : SnapshotIdSchema.make(request.snapshotId),
    }),
    (selected) => {
      const resolution = resolveEvidence(
        selected.snapshot,
        request.evidenceIds,
        request.mode ?? "metadata"
      );

      return {
        ...resolution,
        disclosures: [...selected.disclosures, ...resolution.disclosures],
      };
    }
  );
