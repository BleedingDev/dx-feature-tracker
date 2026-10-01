// @effect-diagnostics-next-line nodeBuiltinImport:off -- Event IDs are the contract's synchronous sha256 over adapter, upstream key and kind.
import { createHash } from "node:crypto";

import { DateTime, Effect, FileSystem } from "effect";

import { InvalidInput } from "../../contracts/error-invalid-input.js";
import { SourceUnavailable } from "../../contracts/error-source-unavailable.js";
import type { CollectInput, DxCollector } from "../../contracts/services.js";
import { CONTRACT_VERSION } from "../../contracts/version.js";
import type { SourceCoverage, SourceGap } from "../../model/coverage.js";
import type { ModuleDescriptor } from "../../model/descriptor.js";
import type { DxEventEnvelope, EventBatch } from "../../model/event.js";
import { emptyEventIdentity } from "../../model/event.js";
import { DescriptorIdSchema, EventIdSchema } from "../../model/ids.js";
import { npmLogAdapter } from "./npm-log.js";
import type { FeedbackAdapter, FeedbackRecord } from "./registry.js";
import { UNSUPPORTED_SUBROUTES, selectAdapter } from "./registry.js";
import { tscAdapter } from "./tsc.js";
import { viteLogAdapter } from "./vite-log.js";

export const LOCAL_FEEDBACK_ADAPTER_ID = "local-feedback";

export const LOCAL_FEEDBACK_ADAPTER_VERSION = "1.0.0";

export const LOCAL_FEEDBACK_ADAPTERS: readonly FeedbackAdapter[] = [
  npmLogAdapter,
  viteLogAdapter,
  tscAdapter,
];

export const B48_FIXTURE_IDS = [
  "b48-tsc-plain",
  "b48-tsc-pretty",
  "b48-npm-debug-log",
  "b48-npm-timing-log",
  "b48-vite-dev-log",
  "b48-unrecognized",
] as const;

const unsupportedGaps: readonly SourceGap[] = UNSUPPORTED_SUBROUTES.map(
  (item) => ({
    code: `subroute-unsupported:${item.subroute}`,
    message: item.reason,
  })
);

export const localFeedbackDescriptor: ModuleDescriptor = {
  contractVersion: CONTRACT_VERSION,
  fixtureIds: [...B48_FIXTURE_IDS],
  gaps: [
    ...unsupportedGaps,
    {
      code: "explicit-input-only",
      message:
        "Only explicitly selected captured log files are imported; nothing tails live tools, so runs without a saved log are not observed.",
    },
    {
      code: "no-hmr-latency",
      message:
        "Vite logs carry no per-update latency or dated timestamps; HMR latency stays unavailable.",
    },
    {
      code: "npm-duration-requires-timing",
      message:
        "npm total duration is available only when npm ran with --timing; otherwise null with a reason.",
    },
  ],
  id: DescriptorIdSchema.make("collector/local-feedback"),
  kind: "collector",
  owner: "B48",
  readiness: "degraded",
  requiredInputs: [
    "selectedInput: captured tsc output, npm debug log (~/.npm/_logs/*-debug-0.log), or Vite dev-server log (file or directory)",
  ],
  supportedFields: [
    "feedback.local.compiler.errorCount",
    "feedback.local.compiler.warningCount",
    "feedback.local.compiler.reportedErrorCount",
    "feedback.local.compiler.codeCounts",
    "feedback.local.npm-timing.command",
    "feedback.local.npm-timing.exitCode",
    "feedback.local.npm-timing.durationMs",
    "feedback.local.npm-timing.timers",
    "feedback.local.npm-timing.httpFetchCount",
    "feedback.local.vite-hmr.readyInMs",
    "feedback.local.vite-hmr.hmrUpdates",
    "feedback.local.vite-hmr.pageReloads",
    "feedback.local.vite-hmr.moduleCount",
  ],
  version: LOCAL_FEEDBACK_ADAPTER_VERSION,
};

export interface FeedbackFile {
  readonly content: string;
  readonly name: string;
}

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const toEvent = (
  record: FeedbackRecord,
  adapter: FeedbackAdapter,
  file: FeedbackFile,
  hash: string,
  index: number,
  input: CollectInput,
  observedAt: string
): DxEventEnvelope => {
  const upstreamKey = `${adapter.id}:${hash}:${index}`;

  return {
    acquisition: "file-import",
    adapterId: LOCAL_FEEDBACK_ADAPTER_ID,
    adapterVersion: `${LOCAL_FEEDBACK_ADAPTER_VERSION}+${adapter.id}@${adapter.version}`,
    ai: null,
    context: input.context,
    eventId: EventIdSchema.make(
      sha256(`${LOCAL_FEEDBACK_ADAPTER_ID}\n${upstreamKey}\nfeedback.local`)
    ),
    evidence: { bounded: true, hash, ref: file.name },
    fieldSemantics: [...record.fieldSemantics],
    identity: emptyEventIdentity,
    kind: "feedback.local",
    observedAt,
    occurredAt: record.occurredAt,
    occurredAtPrecision: record.occurredAtPrecision,
    origin: input.origin,
    payload: { ...record.payload, adapter: adapter.id },
    schemaVersion: "dx.event.v2",
    sourceVersion: record.sourceVersion,
    upstreamKey,
    usage: null,
  };
};

export const buildLocalFeedbackBatch = (
  files: readonly FeedbackFile[],
  input: CollectInput,
  observedAt: string,
  adapters: readonly FeedbackAdapter[] = LOCAL_FEEDBACK_ADAPTERS
): EventBatch => {
  const gaps: SourceGap[] = [...unsupportedGaps];
  const events: DxEventEnvelope[] = [];
  const seenSubroutes = new Set<string>();
  let observedItems = 0;

  for (const file of files) {
    const adapter = selectAdapter(adapters, file.name, file.content);

    if (adapter === null) {
      gaps.push({
        code: "input-unrecognized",
        message: `${file.name}: no registered local-feedback adapter recognized this file`,
      });
      continue;
    }

    observedItems += 1;
    seenSubroutes.add(adapter.subroute);
    const hash = sha256(file.content);

    for (const [index, record] of adapter
      .parse(file.name, file.content)
      .entries()) {
      events.push(
        toEvent(record, adapter, file, hash, index, input, observedAt)
      );
    }
  }

  for (const adapter of adapters) {
    if (!seenSubroutes.has(adapter.subroute)) {
      gaps.push({
        code: `subroute-absent:${adapter.subroute}`,
        message: `No ${adapter.subroute} input was supplied; nothing is inferred for it.`,
      });
    }
  }

  const times = events
    .flatMap((event) => (event.occurredAt === null ? [] : [event.occurredAt]))
    .toSorted();

  const coverage: SourceCoverage = {
    adapterId: input.adapterId,
    expectedItems: files.length,
    gaps,
    observedItems,
    state: observedItems === 0 ? "none" : "partial",
    watermark: null,
    windowFrom: times[0] ?? null,
    windowTo: times.at(-1) ?? null,
  };

  return { coverage, cursor: null, events };
};

const unavailable = (message: string) =>
  new SourceUnavailable({ adapterId: LOCAL_FEEDBACK_ADAPTER_ID, message });

const isCandidate = (name: string): boolean =>
  name.endsWith(".log") || name.endsWith(".txt");

const readFiles = Effect.fn("LocalFeedback.readFiles")(function* readFiles(
  path: string
) {
  const fileSystem = yield* FileSystem.FileSystem;

  const info = yield* fileSystem
    .stat(path)
    .pipe(Effect.mapError(() => unavailable("selected input is not readable")));

  if (info.type === "File") {
    const content = yield* fileSystem
      .readFileString(path)
      .pipe(
        Effect.mapError(() => unavailable("selected file is not readable"))
      );

    return [{ content, name: path.split(/[\\/]/u).at(-1) ?? path }];
  }

  if (info.type !== "Directory") {
    return yield* unavailable(
      "selected input is neither a file nor a directory"
    );
  }

  const names = yield* fileSystem
    .readDirectory(path)
    .pipe(
      Effect.mapError(() => unavailable("selected directory is not readable"))
    );

  const files: FeedbackFile[] = [];

  for (const name of names.filter(isCandidate).toSorted()) {
    const content = yield* fileSystem
      .readFileString(`${path}/${name}`)
      .pipe(Effect.mapError(() => unavailable(`${name} is not readable`)));

    files.push({ content, name });
  }

  return files;
});

export const collectLocalFeedback = Effect.fn("LocalFeedback.collect")(
  function* collectLocalFeedback(input: CollectInput) {
    if (input.selectedInput === null) {
      return yield* new InvalidInput({
        field: "selectedInput",
        message:
          "local-feedback requires an explicitly selected log file or directory",
      });
    }

    const files = yield* readFiles(input.selectedInput);

    const now = yield* DateTime.now;

    return buildLocalFeedbackBatch(files, input, DateTime.formatIso(now));
  }
);

export const localFeedbackCollector: DxCollector<FileSystem.FileSystem> = {
  collect: collectLocalFeedback,
  descriptor: localFeedbackDescriptor,
};
