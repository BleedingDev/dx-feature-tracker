import { Effect } from "effect";

import { InvalidInput } from "../../contracts/error-invalid-input.js";
import type { SnapshotNotFound } from "../../contracts/error-snapshot-not-found.js";
import { EventStore } from "../../contracts/event-store.js";
import type { StoreFailure } from "../../contracts/services.js";
import type { EvidenceItem } from "../../model/report.js";
import {
  lookupEvidence,
  MAX_EVIDENCE_IDS,
} from "../../reports/evidence/resolve.js";
import type { DxHandlerDeps } from "./deps.js";
import { parseQuery } from "./selector.js";

export interface EvidenceInput {
  readonly evidenceIds: readonly string[];
  readonly snapshotId?: string | undefined;
  readonly asOf?: string | undefined;
}

export const handleEvidence = (
  deps: DxHandlerDeps,
  input: EvidenceInput
): Effect.Effect<
  { readonly items: readonly EvidenceItem[] },
  StoreFailure | SnapshotNotFound | InvalidInput,
  EventStore
> =>
  Effect.gen(function* evidenceHandler() {
    if (input.evidenceIds.length === 0) {
      return yield* new InvalidInput({
        field: "evidenceIds",
        message: "evidenceIds must contain at least one ID",
      });
    }

    if (input.evidenceIds.length > MAX_EVIDENCE_IDS) {
      return yield* new InvalidInput({
        field: "evidenceIds",
        message: `at most ${MAX_EVIDENCE_IDS} evidence IDs per request`,
      });
    }

    const store = yield* EventStore;

    const query = yield* parseQuery(
      { asOf: input.asOf, snapshotId: input.snapshotId },
      deps.resolveSelector
    );

    const resolution = yield* lookupEvidence(store, {
      asOf: query.asOf,
      evidenceIds: input.evidenceIds,
      selector: query.selector,
      snapshotId: query.snapshotId,
    });

    return { items: resolution.items };
  });
