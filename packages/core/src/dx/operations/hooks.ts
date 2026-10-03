import { Clock, Effect, Option, Schema } from "effect";

import type { AgentStoreFailure } from "../contracts/agent-store.js";
import { AgentError } from "../contracts/error-agent.js";
import { SourceUnavailable } from "../contracts/error-source-unavailable.js";
import { claudeCodeHookDecoder } from "../harness/claude-code/hook.js";
import { codexHookDecoder } from "../harness/codex/hook.js";
import type { Harness, ReadInput, SessionRef } from "../harness/contract.js";
import { deepseekHookDecoder } from "../harness/deepseek/hook.js";
import { HookObservationSchema } from "../harness/hook-observation.js";
import type {
  HookDecoder,
  HookObservation,
} from "../harness/hook-observation.js";
import { hookObservationEvent } from "../harness/hook-spool.js";
import type { HarnessId } from "../harness/ids.js";
import { ompHookDecoder } from "../harness/omp/hook.js";
import { opencodeHookDecoder } from "../harness/opencode/hook.js";
import { harnessAdapterId } from "../harness/pending.js";
import { piHookDecoder } from "../harness/pi/hook.js";
import type { AgentScope } from "../model/agent-common.js";
import type { OperationBounds } from "../model/agent-operation.js";
import type { Origin } from "../model/common.js";
import type { CoverageState, SourceGap } from "../model/coverage.js";
import { DxEventEnvelopeSchema } from "../model/event.js";
import type { DxEventEnvelope, EventBatch } from "../model/event.js";
import type { SelectedSourceSnapshot } from "./collector.js";
import type { OperationWorkContext } from "./ports.js";

export const BOUNDED_HOOK_PARSER_VERSION = "dx.bounded-hooks.v1" as const;

export interface HookSnapshotDiagnostics {
  readonly filtered: number;
  readonly gaps: readonly SourceGap[];
  readonly inputRecords: number;
  readonly recordsDecoded: number;
  readonly rejected: number;
}

export interface HookSnapshotResult {
  readonly batch: EventBatch;
  readonly diagnostics: HookSnapshotDiagnostics;
}

export interface BoundedHookSnapshotHarness extends Harness {
  readonly diagnostics: Effect.Effect<
    HookSnapshotDiagnostics | null,
    AgentStoreFailure
  >;
}

interface HookScanState {
  decoded: number;
  empty: number;
  filtered: number;
  invalid: number;
  invalidPayloads: number;
  records: number;
  unterminated: boolean;
}

interface HookHarnessState {
  diagnostics: HookSnapshotDiagnostics | null;
}

const decodeObservation = Schema.decodeUnknownOption(
  Schema.fromJsonString(HookObservationSchema)
);

const decodeEvent = Schema.decodeUnknownOption(DxEventEnvelopeSchema);

const hookDecoders = {
  "claude-code": claudeCodeHookDecoder,
  codex: codexHookDecoder,
  cursor: null,
  deepseek: deepseekHookDecoder,
  omp: ompHookDecoder,
  opencode: opencodeHookDecoder,
  pi: piHookDecoder,
} satisfies Record<HarnessId, HookDecoder | null>;

const decoderFor = (tool: HarnessId): HookDecoder | null => hookDecoders[tool];

const inside = (child: string | null, parent: string): boolean => {
  const root = parent.replace(/\/+$/u, "");

  return child !== null && (child === root || child.startsWith(`${root}/`));
};

const belongsTo = (
  observation: HookObservation,
  snapshot: SelectedSourceSnapshot,
  scope: AgentScope
): boolean => {
  const { context } = snapshot.selection.planned;
  const worktree = snapshot.ref.worktree ?? context.worktreePath;
  const recordedWorktree = observation.git.worktreePath;

  const worktreeMatches =
    worktree === null ||
    inside(recordedWorktree, worktree) ||
    (recordedWorktree === null && inside(observation.fields.cwd, worktree));

  return (
    observation.tool === snapshot.ref.harness &&
    worktreeMatches &&
    (scope.repoId === null ||
      (context.repoCommonDir !== null &&
        observation.git.repoCommonDir === context.repoCommonDir)) &&
    (scope.branchSelection.kind === "all" ||
      (observation.git.branch !== null &&
        scope.branchSelection.branches.includes(observation.git.branch)))
  );
};

const sourceError = (snapshot: SelectedSourceSnapshot, message: string) =>
  new SourceUnavailable({
    adapterId: snapshot.selection.planned.source,
    message,
  });

const scopeError = (message: string) =>
  new AgentError({
    code: "scope-denied",
    currentRevision: null,
    expectedRevision: null,
    message,
    recovery: { action: "select-scope", ref: null },
    ref: null,
    retryable: false,
  });

const sameRef = (left: SessionRef, right: SessionRef): boolean =>
  left.channel === right.channel &&
  left.harness === right.harness &&
  left.id === right.id &&
  left.mtimeMs === right.mtimeMs &&
  left.path === right.path &&
  left.sessionId === right.sessionId &&
  left.size === right.size &&
  left.source === right.source &&
  left.worktree === right.worktree &&
  JSON.stringify(left.splitAcross ?? []) ===
    JSON.stringify(right.splitAcross ?? []);

const canSelectHooks = (
  snapshot: SelectedSourceSnapshot,
  scope: AgentScope
): boolean =>
  scope.flightId === null &&
  scope.branchSelection.kind !== "unresolved" &&
  (scope.branchSelection.kind === "all" ||
    scope.branchSelection.branches.length > 0) &&
  (scope.repoId === null ||
    snapshot.selection.planned.context.repoCommonDir !== null) &&
  (scope.worktreeId === null ||
    (snapshot.selection.planned.context.worktreePath !== null &&
      (snapshot.ref.worktree === null ||
        snapshot.ref.worktree ===
          snapshot.selection.planned.context.worktreePath))) &&
  (scope.tools.length === 0 || scope.tools.includes(snapshot.ref.harness)) &&
  (scope.sources.length === 0 ||
    scope.sources.includes(snapshot.selection.planned.source));

const coverageStateOf = (
  records: number,
  gaps: readonly SourceGap[]
): CoverageState => {
  if (records === 0) {
    return "none";
  }

  if (gaps.length === 0) {
    return "complete";
  }

  return "partial";
};

const scanSnapshot = Effect.fnUntraced(function* scanHookSnapshot(
  snapshot: SelectedSourceSnapshot,
  bounds: OperationBounds,
  scope: AgentScope,
  decoder: HookDecoder,
  origin: Origin,
  context?: OperationWorkContext
): Effect.fn.Return<HookSnapshotResult, SourceUnavailable> {
  const { bytes, ref } = snapshot;
  const started = yield* Clock.currentTimeMillis;

  const checkWork = Effect.fnUntraced(function* checkHookWork() {
    const current = yield* Clock.currentTimeMillis;

    if (current - started >= bounds.maxElapsedMs) {
      return yield* sourceError(
        snapshot,
        "The hook decoder exceeded the reviewed elapsed-time limit."
      );
    }

    if (context !== undefined) {
      yield* context.budget.remaining.pipe(
        Effect.mapError((error) => sourceError(snapshot, error.message))
      );
    }

    return yield* Effect.void;
  });

  yield* checkWork();

  if (bytes.byteLength > bounds.maxBytes) {
    return yield* sourceError(
      snapshot,
      "The captured hook bytes exceed maxBytes."
    );
  }

  let frameCount = 0;

  for (const byte of bytes) {
    if (byte === 10) {
      frameCount += 1;
    }
  }

  if (bytes.byteLength > 0 && bytes.at(-1) !== 10) {
    frameCount += 1;
  }

  if (frameCount > bounds.maxRecords) {
    return yield* sourceError(
      snapshot,
      "The hook source records exceed maxRecords."
    );
  }

  const events: DxEventEnvelope[] = [];

  const state: HookScanState = {
    decoded: 0,
    empty: 0,
    filtered: 0,
    invalid: 0,
    invalidPayloads: 0,
    records: frameCount,
    unterminated: false,
  };

  const textDecoder = new TextDecoder("utf-8", { fatal: true });

  const readFrame = (start: number, end: number): void => {
    let text: string;

    try {
      text = textDecoder.decode(bytes.subarray(start, end));
    } catch {
      state.invalid += 1;

      return;
    }

    if (text.trim() === "") {
      state.empty += 1;

      return;
    }

    state.decoded += 1;
    const observation = decodeObservation(text);

    if (Option.isNone(observation)) {
      state.invalid += 1;

      return;
    }

    if (!belongsTo(observation.value, snapshot, scope)) {
      state.filtered += 1;

      return;
    }

    const event = decodeEvent(
      hookObservationEvent(observation.value, {
        channel: ref.channel,
        kind: decoder.kind(observation.value.event),
        origin,
      })
    );

    if (Option.isNone(event)) {
      state.invalid += 1;

      return;
    }

    if (!observation.value.payloadValid) {
      state.invalidPayloads += 1;
    }

    events.push(event.value);
  };

  let start = 0;
  let processed = 0;

  for (let end = 0; end < bytes.byteLength; end += 1) {
    if (bytes[end] === 10) {
      yield* checkWork();
      readFrame(start, end);
      start = end + 1;
      processed += 1;

      if (processed % 64 === 0) {
        yield* Effect.yieldNow;
      }
    }
  }

  if (start < bytes.byteLength) {
    yield* checkWork();
    state.unterminated = true;
    readFrame(start, bytes.byteLength);
  }

  yield* checkWork();

  const gaps: SourceGap[] = [];

  if (state.records === 0) {
    gaps.push({
      code: "hooks.empty-snapshot",
      message: "The selected hook snapshot contains no source records.",
    });
  }

  if (state.empty > 0) {
    gaps.push({
      code: "hooks.empty-records",
      message: `${state.empty} empty hook source records were rejected.`,
    });
  }

  if (state.invalid > 0) {
    gaps.push({
      code: "hooks.invalid-records",
      message: `${state.invalid} hook source records failed observation or event validation.`,
    });
  }

  if (state.invalidPayloads > 0) {
    gaps.push({
      code: "hooks.invalid-payloads",
      message: `${state.invalidPayloads} recorded hooks report an invalid original payload; their diagnostic observations were preserved.`,
    });
  }

  if (state.unterminated) {
    gaps.push({
      code: "hooks.unterminated-record",
      message:
        "The final hook source record has no LF terminator; the snapshot remains unsettled.",
    });
  }

  const coverageState = coverageStateOf(state.records, gaps);

  gaps.push({
    code: "hooks.flight-ownership-unrecorded",
    message:
      "Hook observations record no flight ownership; repository-scoped acquisition preserves flightId:null.",
  });

  return {
    batch: {
      coverage: {
        adapterId: harnessAdapterId(ref.harness),
        expectedItems: null,
        gaps,
        observedItems: events.length,
        state: coverageState,
        watermark: null,
        windowFrom: null,
        windowTo: null,
      },
      cursor: null,
      events,
      unsettled: state.unterminated,
    },
    diagnostics: {
      filtered: state.filtered,
      gaps,
      inputRecords: state.records,
      recordsDecoded: state.decoded,
      rejected: state.empty + state.invalid,
    },
  };
});

export const decodeBoundedHookSnapshot = Effect.fn("decodeBoundedHookSnapshot")(
  function* decodeHooks(
    snapshot: SelectedSourceSnapshot,
    bounds: OperationBounds,
    scope: AgentScope,
    origin: Origin,
    context?: OperationWorkContext
  ): Effect.fn.Return<HookSnapshotResult, SourceUnavailable> {
    const decoder = decoderFor(snapshot.ref.harness);

    if (!canSelectHooks(snapshot, scope)) {
      return yield* sourceError(
        snapshot,
        "Hook acquisition requires a resolved selected scope without inferred flight ownership."
      );
    }

    if (
      decoder === null ||
      (snapshot.ref.channel !== "hooks" &&
        !(
          ["pi", "omp", "deepseek", "opencode"].includes(
            snapshot.ref.harness
          ) && snapshot.ref.channel === "extension"
        ))
    ) {
      return yield* sourceError(
        snapshot,
        "The selected source is not a supported native hook spool."
      );
    }

    return yield* scanSnapshot(
      snapshot,
      bounds,
      scope,
      decoder,
      origin,
      context
    );
  }
);

export const boundedHookSnapshotHarness = Effect.fn(
  "boundedHookSnapshotHarness"
)(function* makeHooks(
  snapshot: SelectedSourceSnapshot,
  bounds: OperationBounds,
  scope: AgentScope,
  context?: OperationWorkContext
): Effect.fn.Return<BoundedHookSnapshotHarness, AgentStoreFailure> {
  if (!canSelectHooks(snapshot, scope)) {
    return yield* scopeError(
      "Hook acquisition requires a resolved selected scope; recorded hooks cannot infer flight ownership."
    );
  }

  const captured: SelectedSourceSnapshot = {
    ...snapshot,
    bytes: Uint8Array.from(snapshot.bytes),
    ref:
      snapshot.ref.splitAcross === undefined
        ? { ...snapshot.ref }
        : { ...snapshot.ref, splitAcross: [...snapshot.ref.splitAcross] },
    selection: {
      ...snapshot.selection,
      planned: {
        ...snapshot.selection.planned,
        context: { ...snapshot.selection.planned.context },
      },
    },
  };

  const retained: HookHarnessState = {
    diagnostics: null,
  };

  const reviewedScope: AgentScope = {
    ...scope,
    branchSelection: {
      ...scope.branchSelection,
      branches: [...scope.branchSelection.branches],
    },
    sources: [...scope.sources],
    tools: [...scope.tools],
  };

  const reviewedBounds = { ...bounds };

  const read = Effect.fn("boundedHooks.read")(function* readHookSnapshot(
    ref: SessionRef,
    input: ReadInput
  ) {
    if (!sameRef(ref, captured.ref)) {
      return yield* sourceError(
        captured,
        "The requested hook source does not match the captured reference."
      );
    }

    const result = yield* decodeBoundedHookSnapshot(
      captured,
      reviewedBounds,
      reviewedScope,
      input.origin,
      context
    );

    retained.diagnostics = result.diagnostics;

    return result.batch;
  });

  return {
    capabilities: {
      branchSources: ["hook", "unassigned"],
      liveHooks: true,
      storedFigure: null,
      subagents: true,
    },
    channels: [captured.ref.channel],
    diagnostics: Effect.sync(() => retained.diagnostics),
    discover: Effect.succeed({
      harness: captured.ref.harness,
      present: true,
      reason: null,
      roots: [captured.selection.root],
      sessions: 1,
      version: BOUNDED_HOOK_PARSER_VERSION,
    }),
    displayName: captured.ref.harness,
    id: captured.ref.harness,
    locate: () => Effect.succeed([captured.ref]),
    read,
  };
});
