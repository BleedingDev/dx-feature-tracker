import { Effect } from "effect";

import { InvalidInput } from "../../contracts/error-invalid-input.js";
import { SourceUnavailable } from "../../contracts/error-source-unavailable.js";
import type { CollectInput, DxCollector } from "../../contracts/services.js";
import { CONTRACT_VERSION } from "../../contracts/version.js";
import type { CoverageState, SourceGap } from "../../model/coverage.js";
import type { ModuleDescriptor } from "../../model/descriptor.js";
import type { DxEventEnvelope, EventBatch } from "../../model/event.js";
import { DescriptorIdSchema } from "../../model/ids.js";
import {
  CURSOR_HOOKS_ADAPTER_ID,
  CURSOR_HOOKS_ADAPTER_VERSION,
  decodeSpoolRecord,
} from "./decode.js";
import type { SpoolReadResult } from "./spool.js";
import { readSpool, spoolExists } from "./spool.js";

export const CURSOR_HOOKS_FIXTURE_IDS = [
  "b05.agent-turns",
  "b05.duplicate-stop",
  "b05.tab-edit",
  "b05.stop-usage-raw",
  "b05.malformed",
] as const;

const PERSISTENT_GAPS: readonly SourceGap[] = [
  {
    code: "hooks-begin-at-install",
    message:
      "hook events exist only after project .cursor/hooks.json is installed; earlier history needs a labelled import",
  },
  {
    code: "stop-usage-partially-verified",
    message:
      "stop-hook input_tokens, output_tokens, cache_read_tokens and cache_write_tokens are summed (fresh input = input_tokens minus cache reads and writes); any other stop-hook usage field is kept raw and never summed",
  },
  {
    code: "live-capture-not-demonstrated",
    message:
      "no authenticated cursor-agent session was available to this worker; payload shapes come from documented fixtures",
  },
];

export const cursorHooksDescriptor: ModuleDescriptor = {
  contractVersion: CONTRACT_VERSION,
  fixtureIds: [...CURSOR_HOOKS_FIXTURE_IDS],
  gaps: [...PERSISTENT_GAPS],
  id: DescriptorIdSchema.make("collector.cursor-hooks"),
  kind: "collector",
  owner: "B05",
  readiness: "degraded",
  requiredInputs: ["cursor-hooks-spool-dir"],
  supportedFields: [
    "ai.request.promptChars",
    "ai.turn.status",
    "ai.turn.loopCount",
    "ai.turn.model",
    "ai.session.durationMs",
    "ai.tool-edit.filePath",
    "ai.tool-edit.linesAdded",
    "ai.tool-edit.linesRemoved",
    "ai.tool-edit.surface",
    "other.toolCall",
    "other.toolName",
    "other.durationMs",
    "ai.usage.rawUsage",
    "ai.usage.normalizedCategories",
  ],
  version: CURSOR_HOOKS_ADAPTER_VERSION,
};

const dedupe = (events: readonly DxEventEnvelope[]) => {
  const seen = new Set<string>();
  const unique: DxEventEnvelope[] = [];

  for (const event of events) {
    if (!seen.has(event.eventId)) {
      seen.add(event.eventId);
      unique.push(event);
    }
  }

  return { duplicates: events.length - unique.length, unique };
};

const windowOf = (events: readonly DxEventEnvelope[]) => {
  const stamps = events
    .map((event) => event.observedAt)
    .toSorted((left, right) => left.localeCompare(right));

  return { from: stamps.at(0) ?? null, to: stamps.at(-1) ?? null };
};

export const batchFromSpool = (
  read: SpoolReadResult,
  input: CollectInput
): EventBatch => {
  const decoded = read.records.flatMap((record) =>
    decodeSpoolRecord(record, input.origin)
  );

  const { unique } = dedupe(decoded);
  const window = windowOf(unique);
  const gaps: SourceGap[] = [...PERSISTENT_GAPS];

  if (read.rejected.length > 0) {
    gaps.push({
      code: "spool-record-rejected",
      message: `${read.rejected.length} spool file(s) failed schema decode`,
    });
  }

  const unknownEvents = unique.filter(
    (event) => event.payload.supportedHookEvent === false
  ).length;

  if (unknownEvents > 0) {
    gaps.push({
      code: "unknown-hook-event",
      message: `${unknownEvents} event(s) used an unrecognised hook_event_name`,
    });
  }

  const partial = read.rejected.length > 0 || unknownEvents > 0;
  let state: CoverageState = partial ? "partial" : "complete";

  if (read.records.length === 0) {
    state = "none";
  }

  return {
    coverage: {
      adapterId: CURSOR_HOOKS_ADAPTER_ID,
      expectedItems: read.records.length + read.rejected.length,
      gaps,
      observedItems: read.records.length,
      state,
      watermark: read.lastFile,
      windowFrom: window.from,
      windowTo: window.to,
    },
    cursor:
      read.lastFile === null
        ? input.cursor
        : { adapterId: CURSOR_HOOKS_ADAPTER_ID, value: read.lastFile },
    events: unique,
  };
};

const collect = (input: CollectInput) =>
  Effect.gen(function* collectCursorHooks() {
    const spoolDir = input.selectedInput;

    if (spoolDir === null || spoolDir === "") {
      return yield* new InvalidInput({
        field: "selectedInput",
        message: "cursor-hooks collector needs the hook spool directory",
      });
    }

    if (!spoolExists(spoolDir)) {
      return yield* new SourceUnavailable({
        adapterId: CURSOR_HOOKS_ADAPTER_ID,
        message:
          "hook spool directory does not exist; install project hooks first",
      });
    }

    const afterFile =
      input.cursor !== null &&
      input.cursor.adapterId === CURSOR_HOOKS_ADAPTER_ID
        ? input.cursor.value
        : null;

    const read = yield* Effect.try({
      catch: () =>
        new SourceUnavailable({
          adapterId: CURSOR_HOOKS_ADAPTER_ID,
          message: "hook spool directory could not be read",
        }),
      try: () => readSpool(spoolDir, afterFile),
    });

    return batchFromSpool(read, input);
  });

export const cursorHooksCollector: DxCollector = {
  collect,
  descriptor: cursorHooksDescriptor,
};
