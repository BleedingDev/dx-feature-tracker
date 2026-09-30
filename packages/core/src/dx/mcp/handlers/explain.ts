import { Effect } from "effect";

import type { InvalidInput } from "../../contracts/error-invalid-input.js";
import type { SnapshotNotFound } from "../../contracts/error-snapshot-not-found.js";
import { EventStore } from "../../contracts/event-store.js";
import type { StoreFailure } from "../../contracts/services.js";
import type { ExplainTimeline } from "../../model/report.js";
import { explainTimeline } from "../../reports/explain/explain.js";
import type { DxHandlerDeps } from "./deps.js";
import { parseQuery } from "./selector.js";
import type { QueryInput } from "./selector.js";

export interface ExplainInput extends QueryInput {
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export const handleExplain = (
  deps: DxHandlerDeps,
  input: ExplainInput
): Effect.Effect<
  ExplainTimeline,
  StoreFailure | SnapshotNotFound | InvalidInput,
  EventStore
> =>
  Effect.gen(function* explainHandler() {
    const store = yield* EventStore;
    const query = yield* parseQuery(input, deps.resolveSelector);

    const result = yield* explainTimeline(store, {
      ...query,
      cursor: input.cursor ?? null,
      limit: input.limit ?? null,
    });

    return result.timeline;
  });
