// @effect-diagnostics-next-line nodeBuiltinImport:off -- The source fingerprint is a synchronous stat of the explicitly selected local DB path.
import { statSync } from "node:fs";

import { DateTime, Effect } from "effect";

import type { CollectInput, DxCollector } from "../../contracts/services.js";
import type { SourceGap } from "../../model/coverage.js";
import type { EventBatch } from "../../model/event.js";
import {
  CURSOR_LOCAL_DB_ADAPTER_ID,
  cursorLocalDbDescriptor,
} from "./descriptor.js";
import { sha256 } from "./envelope.js";
import { mapAiTracking } from "./map-ai-tracking.js";
import { mapStateDb } from "./map-state.js";
import type { MapResult } from "./map-state.js";
import { readConsistentSnapshot } from "./snapshot.js";

const sourceFingerprint = (path: string) => {
  const stat = statSync(path);

  return `sha256:${sha256(`${path}\n${stat.size}\n${stat.mtimeMs}`)}`;
};

const countGap = (count: number, code: string, message: string) =>
  count > 0 ? [{ code, message: `${count} ${message}` }] : [];

const gapsFor = (result: MapResult, layout: string): SourceGap[] => [
  { code: "layout", message: `Recognized Cursor local DB layout ${layout}` },
  ...countGap(
    result.excluded,
    "scope-excluded",
    "rows not provably in the selected repo or branch were excluded"
  ),
  ...countGap(
    result.unreadable,
    "unreadable-rows",
    "key/value rows did not match a recognized JSON shape"
  ),
  {
    code: "no-billed-charge",
    message:
      "Local DB carries no billed charge; spend requires usage CSV or dashboard export",
  },
];

const batchFor = (result: MapResult, layout: string): EventBatch => ({
  coverage: {
    adapterId: CURSOR_LOCAL_DB_ADAPTER_ID,
    expectedItems: result.events.length + result.excluded + result.unreadable,
    gaps: gapsFor(result, layout),
    observedItems: result.events.length,
    state:
      result.unreadable > 0 || result.excluded > 0 ? "partial" : "complete",
    watermark: result.watermark,
    windowFrom: null,
    windowTo: result.watermark,
  },
  cursor:
    result.watermark === null
      ? null
      : { adapterId: CURSOR_LOCAL_DB_ADAPTER_ID, value: result.watermark },
  events: result.events,
});

const collect = (input: CollectInput) =>
  Effect.gen(function* collectCursorLocalDb() {
    const rows = yield* readConsistentSnapshot(
      input.selectedInput,
      input.scratchDir
    );

    const now = yield* DateTime.now;

    const ctx = {
      context: input.context,
      observedAt: DateTime.formatIso(now),
      origin: input.origin,
      sourceHash: sourceFingerprint(input.selectedInput ?? ""),
    };

    const result =
      rows.layout === "ai-tracking"
        ? mapAiTracking(rows, ctx)
        : mapStateDb(rows, ctx);

    return batchFor(result, rows.layout);
  });

export const cursorLocalDbCollector: DxCollector = {
  collect,
  descriptor: cursorLocalDbDescriptor,
};
