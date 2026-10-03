// @effect-diagnostics-next-line nodeBuiltinImport:off -- Exact captured-source digests use synchronous SHA-256 at the snapshot boundary.
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  // @effect-diagnostics-next-line nodeBuiltinImport:off -- Native descriptors with O_NOFOLLOW capture only the approved file bytes before parser effects.
} from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Descriptor metadata types belong to the bounded native file acquisition boundary.
import type { Stats } from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Canonical exact source paths are checked before effectful acquisition.
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { Effect, Exit, Layer, Path, Predicate, Schema } from "effect";

import type { DxCommandEnv } from "../cli/commands/context.js";
import type { AgentStoreFailure } from "../contracts/agent-store.js";
import { AgentError } from "../contracts/error-agent.js";
import { SourceUnavailable } from "../contracts/error-source-unavailable.js";
import { StoreError } from "../contracts/error-store-error.js";
import {
  ClaudeCodeHarness,
  ClaudeCodeStore,
} from "../harness/claude-code/index.js";
import { CodexHarness, CodexStore } from "../harness/codex/index.js";
import type { Harness, SessionRef } from "../harness/contract.js";
import { CursorHarness, CursorStore } from "../harness/cursor/index.js";
import { DeepseekHarness, DeepseekStore } from "../harness/deepseek/index.js";
import type { MemoryStoreInput } from "../harness/file-store.js";
import { GitRunner } from "../harness/git.js";
import type { MemoryRepo } from "../harness/git.js";
import type { Channel, HarnessId } from "../harness/ids.js";
import { OmpHarness, OmpStore } from "../harness/omp/index.js";
import { PiHarness, PiStore } from "../harness/pi/index.js";
import { HarnessRegistry, harnessCatalog } from "../harness/registry.js";
import type { HarnessCatalog } from "../harness/registry.js";
import type { AgentRef, AgentScope } from "../model/agent-common.js";
import type {
  OperationArguments,
  OperationBounds,
  OperationPlan,
  OperationPrecondition,
  OperationReceipt,
  OperationStep,
} from "../model/agent-operation.js";
import type { EventBatch, FlightContext } from "../model/event.js";
import { runPlannedStep } from "../registry/sync.js";
import type { PlannedSource, SyncStep } from "../registry/sync.js";
import { HarnessCursors } from "../storage/harness-cursors.js";
import type { HarnessCursorsApi } from "../storage/harness-cursors.js";
import { spoolDirFor } from "../storage/store-path.js";
import type { OperationWorkBudget } from "./budget.js";
import { operationScopeDigest } from "./digest.js";
import { operationStep } from "./ports.js";
import type {
  OperationAdapter,
  OperationApplyInput,
  OperationEffectResult,
  OperationExecutionContext,
  OperationPlanInput,
  OperationPreparation,
  OperationWorkContext,
} from "./ports.js";

export interface PlannedSourceSelection {
  readonly inputRef: AgentRef;
  readonly planned: PlannedSource;
  readonly root: string;
}

export type PlannedOperationSource = PlannedSourceSelection;

export interface SelectedSourceRequest {
  readonly arguments: OperationArguments;
  readonly bounds: OperationBounds;
  readonly scope: AgentScope;
  readonly storeGeneration: number;
  readonly storeId: string;
}

export interface ExplicitSourceMapping {
  readonly channel: Channel;
  readonly harness: HarnessId;
  readonly source: string;
}

export interface ExplicitSelectedSourceCatalogOptions {
  readonly contextForScope: (
    request: SelectedSourceRequest
  ) => Effect.Effect<FlightContext, AgentStoreFailure>;
  readonly mappings: readonly ExplicitSourceMapping[];
}

export interface CollectionEnrollmentRequest {
  readonly bounds: OperationBounds;
  readonly inputRefs: readonly AgentRef[];
  readonly receiptIds: readonly string[];
  readonly scope: AgentScope;
  readonly selectedRoots: readonly string[];
  readonly source: string;
}

export interface SelectedSourceSnapshot {
  readonly bytes: Uint8Array;
  readonly contentDigest: string;
  readonly identity: string;
  readonly ref: SessionRef;
  readonly selection: PlannedSourceSelection;
}

export interface SnapshotParserDiagnostics {
  readonly recordsDecoded: number | null;
  readonly rejected: number | null;
}

export interface SnapshotHarness extends Harness {
  readonly diagnostics?: Effect.Effect<
    SnapshotParserDiagnostics | null,
    AgentStoreFailure
  >;
  readonly recordUnitsPrepaid?: boolean;
  readonly retainCursor?: boolean;
}

interface SnapshotDiagnosticCell {
  value: SnapshotParserDiagnostics | null;
}

interface CollectionWorkFailureCell {
  error: AgentStoreFailure | null;
}

export interface PlannedSourceOperationAdapterOptions {
  readonly cursors?: HarnessCursorsApi | null;
  readonly enrollment: (
    request: CollectionEnrollmentRequest,
    context: OperationWorkContext
  ) => Effect.Effect<
    Pick<OperationPlan["consent"], "state" | "reason" | "receiptIds">,
    AgentStoreFailure
  >;
  readonly env: DxCommandEnv;
  readonly home?: string;
  readonly parserVersion: string;
  readonly registry: HarnessCatalog;
  readonly selected:
    | readonly PlannedSourceSelection[]
    | ((
        request: SelectedSourceRequest
      ) => Effect.Effect<readonly PlannedSourceSelection[], AgentStoreFailure>);
  readonly snapshotHarness?: (
    snapshot: SelectedSourceSnapshot,
    bounds: OperationBounds,
    scope: AgentScope,
    context: OperationWorkContext
  ) => Effect.Effect<SnapshotHarness, AgentStoreFailure>;
}

type ResolvedCollectionOptions = Omit<
  PlannedSourceOperationAdapterOptions,
  "selected"
> & {
  readonly selected: readonly PlannedSourceSelection[];
};

interface CollectionWorkContext extends OperationWorkContext {
  readonly sourcePaths: Set<string>;
}

const visitSourceFiles = Effect.fn("collection.visitSourceFiles")(
  function* visitFiles(
    files: readonly string[],
    context: CollectionWorkContext
  ) {
    const fresh = [...new Set(files)].filter(
      (file) => !context.sourcePaths.has(file)
    );

    if (fresh.length === 0) {
      yield* context.budget.remaining;

      return;
    }

    const usage = {
      bytesRead: 0,
      filesRead: fresh.length,
      recordsDecoded: 0,
      requests: 0,
      retries: 0,
    };

    const reserved = yield* context.budget.reserve(usage);

    yield* reserved.complete(usage);

    for (const file of fresh) {
      context.sourcePaths.add(file);
    }
  }
);

const selectionRequest = (
  value: OperationPlan | OperationPlanInput
): SelectedSourceRequest => ({
  arguments: value.arguments,
  bounds: value.bounds,
  scope: value.scope,
  storeGeneration:
    "target" in value ? value.target.storeGeneration : value.storeGeneration,
  storeId: "target" in value ? value.target.storeId : value.storeId,
});

const resolveCollectionOptions = Effect.fn("resolveCollectionOptions")(
  function* resolveCollectionOptions(
    options: PlannedSourceOperationAdapterOptions,
    request: SelectedSourceRequest
  ): Effect.fn.Return<ResolvedCollectionOptions, AgentStoreFailure> {
    const selected = Predicate.isFunction(options.selected)
      ? yield* options.selected(request)
      : options.selected;

    return { ...options, selected };
  }
);

const SourceContentSchema = Schema.Struct({
  digest: Schema.String,
  mtimeMs: Schema.Finite,
  size: Schema.Int,
});

const decodeSourceContent = Schema.decodeUnknownSync(
  Schema.fromJsonString(SourceContentSchema)
);

const digest = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const fail = (code: AgentError["code"], message: string): AgentError =>
  new AgentError({
    code,
    currentRevision: null,
    expectedRevision: null,
    message: message.slice(0, 4096),
    recovery: { action: "replan", ref: null },
    ref: null,
    retryable: false,
  });

const refKey = (ref: AgentRef): string =>
  JSON.stringify([
    ref.id,
    ref.storeId,
    ref.storeGeneration,
    ref.kind,
    ref.version,
    ref.basisId,
  ]);

const equalSet = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length &&
  new Set(left).size === left.length &&
  left.every((value) => right.includes(value));

const sourceStepIdForRef = (ref: AgentRef): string =>
  `collect.${digest(refKey(ref)).slice(0, 32)}`;

const sourceStepId = (selection: PlannedSourceSelection): string =>
  sourceStepIdForRef(selection.inputRef);

const selectedFor = (
  options: ResolvedCollectionOptions,
  args: OperationArguments
): readonly PlannedSourceSelection[] => {
  if (args.kind !== "collect") {
    return [];
  }

  const requested = new Set(args.inputRefs.map(refKey));

  return options.selected.filter(
    (selection) =>
      selection.planned.source === args.source &&
      requested.has(refKey(selection.inputRef))
  );
};

const inside = (root: string, file: string): boolean => {
  const relative = path.relative(root, file);

  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
};

const supportsSnapshot = (selection: PlannedSourceSelection): boolean => {
  const { ref } = selection.planned;

  if (ref === null || ref.harness === "opencode") {
    return false;
  }

  if (
    (ref.splitAcross?.length ?? 0) > 1 ||
    /\.(?:gz|zst|zstd)$/u.test(ref.path)
  ) {
    return false;
  }

  return ref.harness === "cursor"
    ? ref.channel === "transcript"
    : ref.channel === "session-file";
};

const assertCatalogEntry = (
  options: ResolvedCollectionOptions,
  item: PlannedSourceSelection
): void => {
  const { planned, root } = item;
  const { ref } = planned;

  if (
    ref === null ||
    planned.harness !== ref.harness ||
    planned.input !== ref.path ||
    planned.unavailable !== null ||
    !path.isAbsolute(root) ||
    !path.isAbsolute(ref.path) ||
    root !== path.resolve(root) ||
    ref.path !== path.resolve(ref.path) ||
    !inside(root, ref.path) ||
    options.registry.get(ref.harness) === null
  ) {
    throw fail(
      "scope-denied",
      "The catalog input is not an enrolled exact local file."
    );
  }

  if (!supportsSnapshot(item) && options.snapshotHarness === undefined) {
    throw fail(
      "source-unavailable",
      "This source needs an explicitly bounded snapshot reader."
    );
  }

  if (
    ref.channel === "usage-api" ||
    ref.channel === "local-db" ||
    ref.channel === "stats-db" ||
    ref.channel === "cli-stream" ||
    ref.channel === "otel"
  ) {
    throw fail(
      "source-unavailable",
      "Network, database and stream acquisition require a separately bounded executor with declared effects."
    );
  }
};

const assertSelection = (
  options: ResolvedCollectionOptions,
  args: OperationArguments,
  scope: AgentScope
): readonly PlannedSourceSelection[] => {
  const selected = selectedFor(options, args);

  if (args.kind !== "collect" || selected.length === 0) {
    throw fail("invalid-selector", "Select an existing collection input.");
  }

  if (
    !equalSet(
      args.inputRefs.map(refKey),
      selected.map((item) => refKey(item.inputRef))
    ) ||
    !equalSet(args.selectedRoots, [
      ...new Set(selected.map((item) => item.root)),
    ]) ||
    !equalSet(scope.sources, [args.source])
  ) {
    throw fail(
      "scope-denied",
      "Collection inputs, roots and source must match the selected catalog exactly."
    );
  }

  if (
    args.parserVersion !== options.parserVersion ||
    selected.length * 3 + 1 > 256
  ) {
    throw fail(
      "invalid-selector",
      "The parser version or selected-input count is unsupported."
    );
  }

  const tools = [
    ...new Set(
      selected.flatMap((item) =>
        item.planned.harness === null ? [] : [item.planned.harness]
      )
    ),
  ];

  if (scope.tools.length > 0 && !equalSet(scope.tools, tools)) {
    throw fail(
      "scope-denied",
      "The requested tools must match the selected harnesses exactly."
    );
  }

  for (const item of selected) {
    assertCatalogEntry(options, item);
  }

  if (
    new Set(selected.map((item) => item.inputRef.id)).size !== selected.length
  ) {
    throw fail(
      "invalid-selector",
      "Selected input IDs must be unique within one operation."
    );
  }

  return selected;
};

const fileIdentity = (info: Stats): string =>
  `${String(info.dev)}:${String(info.ino)}`;

const selectedStat = (file: string): Stats => {
  const info = lstatSync(file);

  if (info.isSymbolicLink() || !info.isFile() || realpathSync(file) !== file) {
    throw fail(
      "plan-stale",
      "The selected input must remain a regular file without symlink components."
    );
  }

  return info;
};

const encodedSnapshot = (ref: SessionRef): boolean =>
  ref.channel === "session-file" &&
  (ref.harness === "omp" || ref.harness === "deepseek") &&
  /\.(?:gz|zst|zstd)$/u.test(ref.path);

const jsonlSnapshot = (ref: SessionRef): boolean =>
  ref.channel === "hooks" ||
  (ref.channel === "session-file" &&
    ["claude-code", "codex", "pi", "omp", "deepseek"].includes(ref.harness));

const sourceRecordUnits = (snapshot: SelectedSourceSnapshot): number => {
  if (!jsonlSnapshot(snapshot.ref)) {
    return snapshot.bytes.byteLength;
  }

  let frames = 0;

  for (const byte of snapshot.bytes) {
    if (byte === 10) {
      frames += 1;
    }
  }

  return (
    frames +
    (snapshot.bytes.byteLength > 0 && snapshot.bytes.at(-1) !== 10 ? 1 : 0)
  );
};

export const makeExplicitSelectedSourceCatalog = (
  options: ExplicitSelectedSourceCatalogOptions
): ((
  request: SelectedSourceRequest
) => Effect.Effect<readonly PlannedSourceSelection[], AgentStoreFailure>) =>
  Effect.fn("explicitSelectedSourceCatalog")(function* exactCatalog(request) {
    const args = request.arguments;

    if (args.kind !== "collect") {
      return yield* fail(
        "invalid-selector",
        "The explicit source catalog accepts collect operations only."
      );
    }

    const mapping = options.mappings.find(
      (item) => item.source === args.source
    );

    if (mapping === undefined) {
      return yield* fail(
        "source-unavailable",
        "No explicitly bounded source mapping is enabled for the selected source."
      );
    }

    const context = yield* options.contextForScope(request);

    return yield* Effect.try({
      catch: (error) =>
        Schema.is(AgentError)(error)
          ? error
          : fail(
              "source-unavailable",
              error instanceof Error ? error.message : String(error)
            ),
      try: () => {
        if (
          args.inputRefs.length === 0 ||
          args.inputRefs.length > request.bounds.maxFiles
        ) {
          throw fail(
            "budget-exhausted",
            "Select at least one exact input within maxFiles."
          );
        }

        const selections = args.inputRefs.map(
          (inputRef): PlannedSourceSelection => {
            if (
              inputRef.storeId !== request.storeId ||
              inputRef.storeGeneration !== request.storeGeneration ||
              !path.isAbsolute(inputRef.id) ||
              inputRef.id !== path.resolve(inputRef.id)
            ) {
              throw fail(
                "scope-denied",
                "Each selected reference must name an exact absolute file in the target store generation."
              );
            }

            const roots = args.selectedRoots.filter(
              (root) =>
                path.isAbsolute(root) &&
                root === path.resolve(root) &&
                inside(root, inputRef.id)
            );

            const [root] = roots;

            if (roots.length !== 1 || root === undefined) {
              throw fail(
                "scope-denied",
                "Each selected file must have exactly one explicitly selected containing root."
              );
            }

            const ref: SessionRef = {
              channel: mapping.channel,
              harness: mapping.harness,
              id: `explicit.${digest(
                JSON.stringify({
                  channel: mapping.channel,
                  harness: mapping.harness,
                  scope: request.scope,
                  source: mapping.source,
                  storeGeneration: request.storeGeneration,
                  storeId: request.storeId,
                })
              )}:${inputRef.id}`,
              mtimeMs: null,
              path: inputRef.id,
              sessionId: null,
              size: null,
              source: mapping.source,
              worktree: context.worktreePath,
            };

            return {
              inputRef,
              planned: {
                context,
                harness: mapping.harness,
                input: ref.path,
                ref,
                source: mapping.source,
                unavailable: null,
              },
              root,
            };
          }
        );

        if (
          !equalSet(args.selectedRoots, [
            ...new Set(selections.map((item) => item.root)),
          ])
        ) {
          throw fail(
            "scope-denied",
            "Every selected root must contain an explicitly selected input."
          );
        }

        return selections;
      },
    });
  });

const checkedContent = (
  snapshot: SelectedSourceSnapshot,
  preconditions: readonly OperationPrecondition[],
  allowGrowth: boolean
): void => {
  const { id } = snapshot.selection.inputRef;

  const identity = preconditions.find(
    (item) => item.kind === "source-identity" && item.target === id
  );

  const content = preconditions.find(
    (item) => item.kind === "source-content" && item.target === id
  );

  if (identity?.expected !== snapshot.identity || content === undefined) {
    throw fail(
      "plan-stale",
      "The selected source identity changed or its precondition is missing."
    );
  }

  const expected = decodeSourceContent(content.expected);
  const size = snapshot.bytes.byteLength;

  if (
    size < expected.size ||
    (!allowGrowth && size !== expected.size) ||
    (!allowGrowth && snapshot.ref.mtimeMs !== expected.mtimeMs) ||
    digest(snapshot.bytes.subarray(0, expected.size)) !== expected.digest
  ) {
    throw fail(
      "plan-stale",
      "The selected source changed, rotated or truncated beyond its approved append rule."
    );
  }
};

const captureFile = (
  selection: PlannedSourceSelection,
  info: Stats,
  allowGrowth: boolean,
  measuredRead: (bytes: number) => void
): SelectedSourceSnapshot => {
  const { ref } = selection.planned;

  if (ref === null) {
    throw fail(
      "source-unavailable",
      "The selected input has no session reference."
    );
  }

  const fd = openSync(ref.path, constants.O_RDONLY + constants.O_NOFOLLOW);

  try {
    const opened = fstatSync(fd);

    if (
      !opened.isFile() ||
      fileIdentity(opened) !== fileIdentity(info) ||
      opened.size !== info.size
    ) {
      throw fail(
        "plan-stale",
        "The selected file changed before its bounded descriptor was opened."
      );
    }

    const bytes = new Uint8Array(info.size);
    let read = 0;

    while (read < bytes.byteLength) {
      const count = readSync(fd, bytes, read, bytes.byteLength - read, read);

      measuredRead(count);

      if (count === 0) {
        throw fail("plan-stale", "The selected file truncated during capture.");
      }

      read += count;
    }

    const after = fstatSync(fd);
    const current = selectedStat(ref.path);

    if (
      fileIdentity(current) !== fileIdentity(opened) ||
      after.size < info.size ||
      (!allowGrowth &&
        (after.size !== info.size || after.mtimeMs !== info.mtimeMs)) ||
      (after.size === info.size && after.mtimeMs !== info.mtimeMs)
    ) {
      throw fail(
        "plan-stale",
        "The selected file rotated or changed during capture."
      );
    }

    if (!encodedSnapshot(ref)) {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    }

    return {
      bytes,
      contentDigest: digest(bytes),
      identity: fileIdentity(opened),
      ref: { ...ref, mtimeMs: info.mtimeMs, size: bytes.byteLength },
      selection,
    };
  } finally {
    closeSync(fd);
  }
};

const captureSelected = Effect.fn("captureSelected")(function* captureInputs(
  selected: readonly PlannedSourceSelection[],
  bounds: OperationBounds,
  allowGrowth: boolean,
  context: CollectionWorkContext,
  preconditions?: readonly OperationPrecondition[]
): Effect.fn.Return<readonly SelectedSourceSnapshot[], AgentStoreFailure> {
  if (selected.length > bounds.maxFiles) {
    return yield* fail(
      "budget-exhausted",
      "The selected input count exceeds maxFiles."
    );
  }

  yield* visitSourceFiles(
    selected.map((selection) => selection.planned.ref?.path ?? ""),
    context
  );

  const files = yield* Effect.try({
    catch: (error) =>
      Schema.is(AgentError)(error)
        ? error
        : fail("source-unavailable", String(error)),
    try: () =>
      selected.map((selection) => ({
        info: selectedStat(selection.planned.ref?.path ?? ""),
        selection,
      })),
  });

  const bytes = files.reduce((total, file) => total + file.info.size, 0);
  const remaining = yield* context.budget.remaining;

  if (bytes > remaining.maxBytes) {
    return yield* fail(
      "budget-exhausted",
      "Selected bytes exceed the remaining source-byte allowance."
    );
  }

  return yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* captureReservation() {
      const reserved = yield* context.budget.reserve({
        bytesRead: bytes,
        filesRead: 0,
        recordsDecoded: 0,
        requests: 0,
        retries: 0,
      });

      let bytesRead = 0;

      const result = yield* Effect.exit(
        restore(
          Effect.try({
            catch: (error) =>
              Schema.is(AgentError)(error)
                ? error
                : fail("source-unavailable", String(error)),
            try: () =>
              files.map(({ info, selection }) => {
                const snapshot = captureFile(
                  selection,
                  info,
                  allowGrowth,
                  (count) => {
                    bytesRead += count;
                  }
                );

                if (preconditions !== undefined) {
                  checkedContent(snapshot, preconditions, allowGrowth);
                }

                return snapshot;
              }),
          })
        )
      );

      yield* reserved.complete({
        bytesRead,
        filesRead: 0,
        recordsDecoded: 0,
        requests: 0,
        retries: 0,
      });

      if (Exit.isFailure(result)) {
        return yield* Effect.failCause(result.cause);
      }

      const records = result.value.reduce(
        (total, snapshot) =>
          total +
          (encodedSnapshot(snapshot.ref) ? 0 : sourceRecordUnits(snapshot)),
        0
      );

      if (records > remaining.maxRecords) {
        return yield* fail(
          "budget-exhausted",
          "Selected top-level source records exceed the remaining record allowance before parsing."
        );
      }

      return result.value;
    })
  );
});

const memoryRepos = (
  snapshot: SelectedSourceSnapshot
): readonly MemoryRepo[] => {
  const { context } = snapshot.selection.planned;

  return context.repoCommonDir === null || context.worktreePath === null
    ? []
    : [
        {
          repoCommonDir: context.repoCommonDir,
          worktrees: [
            {
              branch: context.branch,
              headSha: context.headSha,
              path: context.worktreePath,
            },
          ],
        },
      ];
};

export const nativeBoundedSnapshotHarness = (
  snapshot: SelectedSourceSnapshot,
  _bounds: OperationBounds,
  _scope?: AgentScope,
  home?: string
): Effect.Effect<SnapshotHarness, AgentStoreFailure> => {
  const input: MemoryStoreInput & { home?: string } = {
    files: [
      {
        bytes: snapshot.bytes,
        mtimeMs: snapshot.ref.mtimeMs ?? 0,
        path: snapshot.ref.path,
      },
    ],
    roots: [snapshot.selection.root],
  };

  if (home !== undefined) {
    input.home = home;
  }

  switch (snapshot.ref.harness) {
    case "claude-code": {
      const memory = {
        ...input,
        repoRoots:
          snapshot.ref.worktree === null ? [] : [snapshot.ref.worktree],
      };

      return ClaudeCodeHarness.make.pipe(
        Effect.provide(ClaudeCodeStore.memory(memory))
      );
    }

    case "codex": {
      return CodexHarness.make.pipe(Effect.provide(CodexStore.memory(input)));
    }

    case "pi": {
      return PiHarness.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            PiStore.memory(input),
            GitRunner.memory(memoryRepos(snapshot)),
            Path.layer
          )
        )
      );
    }

    case "omp": {
      return OmpHarness.make.pipe(Effect.provide(OmpStore.memory(input)));
    }

    case "deepseek": {
      return DeepseekHarness.make.pipe(
        Effect.provide(DeepseekStore.memory(input))
      );
    }

    case "cursor": {
      return CursorHarness.make.pipe(Effect.provide(CursorStore.memory(input)));
    }

    case "opencode": {
      return Effect.fail(
        fail(
          "source-unavailable",
          "No bounded file-snapshot parser is available for this source."
        )
      );
    }

    default: {
      return Effect.fail(
        fail("source-unavailable", "The selected harness is unsupported.")
      );
    }
  }
};

const snapshotHarness = (
  options: PlannedSourceOperationAdapterOptions,
  snapshot: SelectedSourceSnapshot,
  bounds: OperationBounds,
  scope: AgentScope,
  context: OperationWorkContext
): Effect.Effect<SnapshotHarness, AgentStoreFailure> =>
  options.snapshotHarness === undefined
    ? nativeBoundedSnapshotHarness(snapshot, bounds, scope, options.home)
    : options.snapshotHarness(snapshot, bounds, scope, context);

const enrollmentRequest = (
  plan: Pick<OperationPlan, "arguments" | "bounds" | "scope">,
  receiptIds: readonly string[]
): CollectionEnrollmentRequest => ({
  bounds: plan.bounds,
  inputRefs: plan.arguments.kind === "collect" ? plan.arguments.inputRefs : [],
  receiptIds,
  scope: plan.scope,
  selectedRoots:
    plan.arguments.kind === "collect" ? plan.arguments.selectedRoots : [],
  source: plan.arguments.kind === "collect" ? plan.arguments.source : "",
});

const consentDigest = (request: CollectionEnrollmentRequest): string =>
  digest(
    JSON.stringify([
      request.scope,
      request.source,
      request.selectedRoots,
      request.inputRefs.map(refKey),
      request.bounds,
    ])
  );

const cursorValue = (
  options: PlannedSourceOperationAdapterOptions,
  selection: PlannedSourceSelection
): Effect.Effect<string, AgentStoreFailure> =>
  options.cursors === null ||
  options.cursors === undefined ||
  selection.planned.ref === null
    ? Effect.succeed("null")
    : options.cursors
        .get(selection.planned.ref)
        .pipe(Effect.map((stored) => JSON.stringify(stored?.cursor ?? null)));

const checkedCheckpoint = Effect.fn("collection.checkedCheckpoint")(
  function* readReviewedCheckpoint(
    options: PlannedSourceOperationAdapterOptions,
    plan: OperationPlan,
    snapshot: SelectedSourceSnapshot,
    acceptedCursor: string | undefined
  ) {
    const checkpoint = options.cursors;

    const pinned =
      checkpoint === null || checkpoint === undefined
        ? null
        : yield* checkpoint.get(snapshot.ref);

    const current = JSON.stringify(pinned?.cursor ?? null);

    const expected = plan.preconditions.find(
      (entry) =>
        entry.kind === "source-cursor" &&
        entry.target === snapshot.selection.inputRef.id
    );

    if (
      expected === undefined ||
      (current !== expected.expected && current !== acceptedCursor)
    ) {
      return yield* fail(
        "cursor-mismatch",
        "The selected source cursor changed before effects began."
      );
    }

    return pinned;
  }
);

const prepareCollection = Effect.fn("prepareCollection")(
  function* prepareCollection(
    options: ResolvedCollectionOptions,
    input: OperationPlanInput,
    context: CollectionWorkContext
  ): Effect.fn.Return<OperationPreparation, AgentStoreFailure> {
    const selected = yield* Effect.try({
      catch: (error) =>
        Schema.is(AgentError)(error)
          ? error
          : fail("invalid-selector", String(error)),
      try: () => assertSelection(options, input.arguments, input.scope),
    });

    if (input.arguments.kind !== "collect") {
      return yield* fail("invalid-selector", "Expected collect arguments.");
    }

    if (
      selected.some(
        (item) =>
          item.inputRef.storeId !== input.target.storeId ||
          item.inputRef.storeGeneration !== input.target.storeGeneration
      )
    ) {
      return yield* fail(
        "stale-generation",
        "Selected inputs must belong to the target store generation."
      );
    }

    const args = input.arguments;

    const request = enrollmentRequest(input, []);
    const consent = yield* options.enrollment(request, context);

    if (consent.state !== "authorized") {
      return yield* fail(
        consent.state === "denied" ? "scope-denied" : "authorization-required",
        consent.reason ??
          "Existing source enrollment is required before reading selected content."
      );
    }

    const snapshots = yield* captureSelected(
      selected,
      input.bounds,
      args.allowSourceGrowth,
      context
    );

    const cursors = yield* Effect.forEach((item: PlannedSourceSelection) =>
      cursorValue(options, item)
    )(selected);

    if (
      args.cursor !== null &&
      (cursors.length !== 1 || args.cursor !== cursors[0])
    ) {
      return yield* fail(
        "cursor-mismatch",
        "The explicit cursor does not match the selected source checkpoint."
      );
    }

    const preconditions = snapshots.flatMap(
      (snapshot, index): readonly OperationPrecondition[] => [
        {
          allowAppend: args.allowSourceGrowth,
          expected: snapshot.identity,
          kind: "source-identity",
          target: snapshot.selection.inputRef.id,
        },
        {
          allowAppend: args.allowSourceGrowth,
          expected: JSON.stringify({
            digest: snapshot.contentDigest,
            mtimeMs: snapshot.ref.mtimeMs,
            size: snapshot.bytes.byteLength,
          }),
          kind: "source-content",
          target: snapshot.selection.inputRef.id,
        },
        {
          allowAppend: false,
          expected: cursors[index] ?? "null",
          kind: "source-cursor",
          target: snapshot.selection.inputRef.id,
        },
      ]
    );

    return {
      arguments: args,
      consent: { ...consent, scopeDigest: consentDigest(request) },
      effects: {
        destructive: false,
        networkDestinations: [],
        reads: snapshots.map((item) => item.ref.path),
        writes: [options.env.storePath, spoolDirFor(options.env.storePath)],
      },
      expectedEvidenceImprovement:
        "Import observations from the exact selected local source snapshots, preserving source gaps.",
      forecast: {
        bytes: snapshots.reduce(
          (total, item) => total + item.bytes.byteLength,
          0
        ),
        cost: null,
        elapsedMs: null,
        requests: 0,
      },
      preconditions: [
        ...preconditions,
        {
          allowAppend: false,
          expected: options.parserVersion,
          kind: "parser-version",
          target: args.source,
        },
      ],
      resumeBoundary: "complete-record",
      stopCondition:
        "Stop after the selected snapshots, at a source gap, or when approved source-byte, elapsed-time, or top-level-frame plus normalized-observation limits prevent further work; nested decoder attempts are unavailable.",
    };
  }
);

const emptyEffects = (generation: number): OperationReceipt["effects"] => ({
  backupArtifacts: [],
  backupIds: [],
  configDigest: null,
  evidenceIds: [],
  exportArtifacts: [],
  exports: [],
  filesChanged: [],
  remainingStoreGeneration: generation,
  removalReason: null,
  removedCount: null,
  removedRefs: [],
});

const normalizedMeteringError = (error: AgentStoreFailure): StoreError =>
  new StoreError({
    message: error.message,
    operation: "collection.normalized-record-budget",
  });

const recordNormalizedFailure = (
  failure: CollectionWorkFailureCell,
  error: AgentStoreFailure
): StoreError => {
  failure.error = error;

  return normalizedMeteringError(error);
};

const propagateWorkFailure = (
  failure: CollectionWorkFailureCell
): Effect.Effect<void, AgentStoreFailure> =>
  failure.error === null ? Effect.void : Effect.fail(failure.error);

const snapshotRejectedCount = (
  diagnostics: SnapshotParserDiagnostics | null,
  fallback: number | null | undefined
): number | null => diagnostics?.rejected ?? fallback ?? null;

const meteredCollectionEnv = (
  env: DxCommandEnv,
  context: OperationWorkContext,
  failure: CollectionWorkFailureCell
): DxCommandEnv => ({
  ...env,
  store: {
    ...env.store,
    append: Effect.fn("collection.appendSnapshot")(function* appendSnapshot(
      batch: EventBatch
    ) {
      const usage = {
        bytesRead: 0,
        filesRead: 0,
        recordUnits: batch.events.length,
        recordsDecoded: 0,
        requests: 0,
        retries: 0,
      };

      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* appendReservation() {
          const reserved = yield* context.budget
            .reserve(usage)
            .pipe(
              Effect.mapError((error) =>
                recordNormalizedFailure(failure, error)
              )
            );

          const appended = yield* Effect.exit(restore(env.store.append(batch)));

          yield* reserved
            .complete(usage)
            .pipe(
              Effect.mapError((error) =>
                recordNormalizedFailure(failure, error)
              )
            );

          return Exit.isSuccess(appended)
            ? appended.value
            : yield* Effect.failCause(appended.cause);
        })
      );
    }),
  },
});

const receiptGaps = (
  result: SyncStep,
  extra: readonly string[]
): readonly string[] => {
  const gaps = [
    ...(result.gaps?.map((gap) => `${gap.code}: ${gap.message}`) ?? []),
    ...extra,
    ...(result.rejected === null || result.rejected === undefined
      ? [
          "Rejected-row count is unavailable because this reader does not report it.",
        ]
      : []),
  ];

  const bounded = gaps.map((gap) => gap.slice(0, 4096));

  return bounded.length > 64
    ? [
        ...bounded.slice(0, 63),
        `${String(bounded.length - 63)} additional gaps omitted.`,
      ]
    : bounded;
};

const remainingWork = (
  state: OperationStep["state"],
  extra: readonly string[]
): string | null => {
  if (state === "spooled") {
    return "Import the selected staged batch and reread its source checkpoint.";
  }

  return state === "partial" || state === "unavailable" || extra.length > 0
    ? "Replan the selected source to resolve the reported gaps."
    : null;
};

const receiptStep = (
  step: OperationStep,
  result: SyncStep,
  extra: readonly string[]
): OperationStep => {
  const state =
    result.state === "duplicate"
      ? "already-applied"
      : (result.state ?? "unavailable");

  return {
    ...step,
    committedThrough:
      result.spooledRefs?.length === 0 ? (result.lastEventId ?? null) : null,
    duplicates: result.duplicates ?? 0,
    gaps: receiptGaps(result, extra),
    inserted: result.inserted ?? 0,
    rejected: result.rejected ?? null,
    remainingWork: remainingWork(state, extra),
    safeCursor:
      result.safeCursor === undefined || result.safeCursor === null
        ? null
        : JSON.stringify(result.safeCursor),
    spooledRefs: result.spooledRefs ?? [],
    state:
      extra.length > 0 &&
      (state === "committed" ||
        state === "already-applied" ||
        state === "unchanged")
        ? "partial"
        : state,
  };
};

const readStagedBatchState = (spoolRoot: string, refs: readonly string[]) => {
  const existing: string[] = [];
  const gaps: string[] = [];

  for (const ref of refs) {
    if (!path.isAbsolute(ref) || !inside(spoolRoot, ref)) {
      gaps.push(
        "A prior staged reference is outside the selected store spool folder and was not probed."
      );
      continue;
    }

    try {
      const info = lstatSync(ref);

      if (info.isFile() && !info.isSymbolicLink()) {
        existing.push(ref);
      }
    } catch (error) {
      gaps.push(
        `Prior staged-batch state is unavailable: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return { existing, gaps };
};

const stagedBatchState = Effect.fn("collection.stagedBatchState")(
  function* probeStagedBatches(
    spoolRoot: string,
    refs: readonly string[],
    context: CollectionWorkContext
  ) {
    const selected = refs.filter(
      (ref) => path.isAbsolute(ref) && inside(spoolRoot, ref)
    );

    const visited = yield* visitSourceFiles(selected, context).pipe(
      Effect.as(true),
      Effect.catch(() => Effect.succeed(false))
    );

    return visited
      ? readStagedBatchState(spoolRoot, refs)
      : {
          existing: [],
          gaps: [
            "Prior staged-batch metadata was not probed because the shared work allowance is unavailable.",
          ],
        };
  }
);

const currentSnapshot = Effect.fn("collection.currentSnapshot")(
  function* inspectSnapshot(
    snapshot: SelectedSourceSnapshot,
    allowGrowth: boolean,
    context: CollectionWorkContext
  ) {
    yield* visitSourceFiles([snapshot.ref.path], context);

    return yield* Effect.try({
      catch: (error) =>
        Schema.is(AgentError)(error)
          ? error
          : fail("plan-stale", String(error)),
      try: () => {
        const fresh = selectedStat(snapshot.ref.path);

        if (
          fileIdentity(fresh) !== snapshot.identity ||
          fresh.size < snapshot.bytes.byteLength ||
          (fresh.size === snapshot.bytes.byteLength &&
            fresh.mtimeMs !== snapshot.ref.mtimeMs) ||
          (!allowGrowth &&
            (fresh.size !== snapshot.bytes.byteLength ||
              fresh.mtimeMs !== snapshot.ref.mtimeMs))
        ) {
          throw fail(
            "plan-stale",
            "The selected source changed before effects began."
          );
        }

        return fresh;
      },
    });
  }
);

export const makePlannedSourceOperationAdapter = (
  options: PlannedSourceOperationAdapterOptions
): OperationAdapter => {
  const captured = new WeakMap<
    OperationWorkBudget,
    Map<string, readonly SelectedSourceSnapshot[]>
  >();

  const sourcePaths = new WeakMap<OperationWorkBudget, Set<string>>();
  const acceptedCursors = new Map<string, ReadonlyMap<string, string>>();

  const workContext = (
    context: OperationWorkContext
  ): CollectionWorkContext => {
    const paths = sourcePaths.get(context.budget) ?? new Set<string>();

    sourcePaths.set(context.budget, paths);

    return { ...context, sourcePaths: paths };
  };

  const snapshotsFor = (budget: OperationWorkBudget) => {
    const snapshots =
      captured.get(budget) ??
      new Map<string, readonly SelectedSourceSnapshot[]>();

    captured.set(budget, snapshots);

    return snapshots;
  };

  const available =
    Predicate.isFunction(options.selected) || options.selected.length > 0;

  const declaredReads = Predicate.isFunction(options.selected)
    ? []
    : options.selected.map((item) => item.planned.input ?? "");

  const validateInputs = Effect.fn("collection.validateInputs")(
    function* validate(plan: OperationPlan, context: OperationWorkContext) {
      const work = workContext(context);

      const resolved = yield* resolveCollectionOptions(
        options,
        selectionRequest(plan)
      );

      const selected = yield* Effect.try({
        catch: (error) =>
          Schema.is(AgentError)(error)
            ? error
            : fail("invalid-selector", String(error)),
        try: () => assertSelection(resolved, plan.arguments, plan.scope),
      });

      if (plan.arguments.kind !== "collect") {
        return ["Expected collect arguments."];
      }

      const args = plan.arguments;

      const enrollment = yield* options.enrollment(
        enrollmentRequest(plan, plan.consent.receiptIds),
        context
      );

      if (enrollment.state !== "authorized") {
        return [
          enrollment.reason ?? "Source enrollment is no longer authorized.",
        ];
      }

      const parser = plan.preconditions.find(
        (item) => item.kind === "parser-version" && item.target === args.source
      );

      if (parser?.expected !== options.parserVersion) {
        return ["The selected parser changed or its precondition is missing."];
      }

      for (const item of selected) {
        const expected = plan.preconditions.find(
          (entry) =>
            entry.kind === "source-cursor" && entry.target === item.inputRef.id
        );

        const current = yield* cursorValue(options, item);

        const accepted = acceptedCursors
          .get(plan.planDigest)
          ?.get(item.inputRef.id);

        if (
          expected === undefined ||
          (current !== expected.expected && current !== accepted)
        ) {
          return [
            "The selected source cursor changed without this operation's durable receipt.",
          ];
        }
      }

      const retained = snapshotsFor(context.budget).get(plan.planDigest);

      if (retained === undefined) {
        const snapshots = yield* captureSelected(
          selected,
          plan.bounds,
          args.allowSourceGrowth,
          work,
          plan.preconditions
        );

        snapshotsFor(context.budget).set(plan.planDigest, snapshots);
      } else {
        for (const snapshot of retained) {
          yield* currentSnapshot(snapshot, args.allowSourceGrowth, work);
        }
      }

      return [];
    }
  );

  const validate = Effect.fn("collection.validate")(function* checkedPlan(
    plan: OperationPlan,
    context: OperationWorkContext
  ) {
    return yield* validateInputs(plan, context).pipe(
      Effect.catch((error) => Effect.succeed([error.message]))
    );
  });

  const execute = Effect.fn("collection.execute")(function* execute(
    plan: OperationPlan,
    step: OperationStep,
    context: OperationExecutionContext
  ): Effect.fn.Return<OperationEffectResult, AgentStoreFailure> {
    const work = workContext(context);
    const retained = snapshotsFor(context.budget);

    if (
      retained
        .get(plan.planDigest)
        ?.some((item) => sourceStepId(item.selection) === step.id) !== true
    ) {
      const problems = yield* validate(plan, context);

      if (problems.length > 0) {
        return yield* fail("plan-stale", problems.join(" "));
      }
    }

    const snapshot = retained
      .get(plan.planDigest)
      ?.find((item) => sourceStepId(item.selection) === step.id);

    if (snapshot === undefined || plan.arguments.kind !== "collect") {
      return yield* fail(
        "scope-denied",
        "The operation step is outside the selected snapshot set."
      );
    }

    const fresh = yield* currentSnapshot(
      snapshot,
      plan.arguments.allowSourceGrowth,
      work
    );

    const staged = yield* stagedBatchState(
      spoolDirFor(options.env.storePath),
      step.spooledRefs,
      work
    );

    const parser = yield* snapshotHarness(
      options,
      snapshot,
      plan.bounds,
      plan.scope,
      context
    );

    if (parser.id !== snapshot.ref.harness) {
      return yield* fail(
        "source-unavailable",
        "The snapshot parser does not match the selected harness."
      );
    }

    const checkpoint = options.cursors;

    const pinnedCheckpoint = yield* checkedCheckpoint(
      options,
      plan,
      snapshot,
      acceptedCursors.get(plan.planDigest)?.get(snapshot.selection.inputRef.id)
    );

    const diagnostics: SnapshotDiagnosticCell = {
      value: null,
    };

    const failure: CollectionWorkFailureCell = {
      error: null,
    };

    const bounded: Harness = {
      ...parser,
      read: Effect.fn("collection.readSnapshot")(
        function* readSnapshot(ref, input) {
          const usage = {
            bytesRead: 0,
            filesRead: 0,
            recordUnits:
              parser.recordUnitsPrepaid === true
                ? 0
                : sourceRecordUnits(snapshot),
            recordsDecoded:
              parser.recordUnitsPrepaid === true ||
              snapshot.bytes.byteLength === 0
                ? 0
                : null,
            requests: 0,
            retries: 0,
          };

          const meteringError = (error: AgentStoreFailure) => {
            failure.error = error;

            return new SourceUnavailable({
              adapterId: snapshot.selection.planned.source,
              message: error.message,
            });
          };

          const batch = yield* Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* decodeReservation() {
              const reserved = yield* context.budget
                .reserve(usage)
                .pipe(Effect.mapError(meteringError));

              const decoded = yield* Effect.exit(
                restore(parser.read(ref, input))
              );

              if (Exit.isSuccess(decoded) && parser.diagnostics !== undefined) {
                diagnostics.value = yield* parser.diagnostics.pipe(
                  Effect.mapError(meteringError)
                );
              }

              yield* reserved
                .complete({
                  ...usage,
                  recordsDecoded:
                    diagnostics.value?.recordsDecoded ?? usage.recordsDecoded,
                })
                .pipe(Effect.mapError(meteringError));

              return Exit.isSuccess(decoded)
                ? decoded.value
                : yield* Effect.failCause(decoded.cause);
            })
          );

          if (batch.events.length > plan.bounds.maxRecords) {
            const oversized = fail(
              "budget-exhausted",
              "The parser emitted more observations than maxRecords permits."
            );

            failure.error = oversized;

            return yield* new SourceUnavailable({
              adapterId: snapshot.selection.planned.source,
              message: oversized.message,
            });
          }

          return batch;
        }
      ),
    };

    const planned = { ...snapshot.selection.planned, ref: snapshot.ref };

    const run = runPlannedStep(
      meteredCollectionEnv(options.env, context, failure),
      [],
      planned
    ).pipe(
      Effect.provideService(HarnessRegistry, harnessCatalog([bounded])),
      Effect.provide(NodeServices.layer)
    );

    const guardedCursors: HarnessCursorsApi | null =
      checkpoint === null || checkpoint === undefined
        ? null
        : {
            get: () => Effect.succeed(pinnedCheckpoint),
            put: Effect.fn("collection.checkpoint")(
              function* saveCheckpoint(ref, entry) {
                if (parser.retainCursor === true) {
                  return yield* new StoreError({
                    message:
                      "This bounded parser cannot map its decoded progress to the source encoding; the previous cursor was retained.",
                    operation: "collection.cursor-encoding-unavailable",
                  });
                }

                yield* currentSnapshot(snapshot, false, work).pipe(
                  Effect.mapError(
                    (error) =>
                      new StoreError({
                        message: error.message,
                        operation: "collection.cursor-source-check",
                      })
                  )
                );

                if (checkpoint.putIfCurrent === undefined) {
                  const currentCheckpoint = yield* checkpoint.get(ref);

                  if (
                    JSON.stringify(currentCheckpoint) !==
                    JSON.stringify(pinnedCheckpoint)
                  ) {
                    return yield* new StoreError({
                      message:
                        "The selected source checkpoint changed after acquisition; the previous cursor was retained.",
                      operation: "collection.cursor-concurrency-check",
                    });
                  }

                  return yield* checkpoint.put(ref, entry);
                }

                const advanced = yield* checkpoint.putIfCurrent(
                  ref,
                  pinnedCheckpoint,
                  entry
                );

                if (!advanced) {
                  return yield* new StoreError({
                    message:
                      "The selected source checkpoint changed after acquisition; the previous cursor was retained.",
                    operation: "collection.cursor-concurrency-check",
                  });
                }

                return yield* Effect.void;
              }
            ),
          };

    const collected =
      guardedCursors === null
        ? run
        : run.pipe(Effect.provideService(HarnessCursors, guardedCursors));

    const result = yield* collected;

    yield* propagateWorkFailure(failure);

    const growth =
      fresh.size > snapshot.bytes.byteLength
        ? ["The source appended after capture; later bytes remain unread."]
        : [];

    const current = receiptStep(
      step,
      {
        ...result,
        gaps: [
          ...(result.gaps ?? []),
          {
            code: "collection.record-metering-unavailable",
            message: jsonlSnapshot(snapshot.ref)
              ? "Nested decoder attempts are unavailable; the record allowance counts top-level LF frames plus normalized observations. Nested schema attempts are bounded by source-byte and elapsed-time limits. Physical control-store I/O is outside source-byte measurements."
              : "Actual decoder attempts are unavailable; this parser uses conservative source-byte record units plus normalized observations. Physical control-store I/O is outside source-byte measurements.",
          },
          ...staged.gaps.map((message) => ({
            code: "collection.staging-state-unavailable",
            message,
          })),
          ...staged.existing.map((ref) => ({
            code: "collection.staging-pending",
            message: `An earlier staged batch still exists at ${ref}; its drain has not been verified.`,
          })),
        ],
        rejected: snapshotRejectedCount(diagnostics.value, result.rejected),
      },
      growth
    );

    const mapped =
      staged.existing.length === 0
        ? current
        : {
            ...current,
            remainingWork:
              "Earlier selected staged batches still exist; verify their import separately before considering staging complete.",
          };

    const effects = {
      ...emptyEffects(plan.storeGeneration),
      evidenceIds:
        mapped.committedThrough === null ? [] : [mapped.committedThrough],
      filesChanged: mapped.spooledRefs,
    };

    if (mapped.safeCursor !== null) {
      acceptedCursors.set(
        plan.planDigest,
        new Map(acceptedCursors.get(plan.planDigest)).set(
          snapshot.selection.inputRef.id,
          mapped.safeCursor
        )
      );
    }

    return {
      effects,
      step: mapped,
      verificationRefs: [snapshot.selection.inputRef],
    };
  });

  return {
    authorize: (
      plan: OperationPlan,
      input: OperationApplyInput,
      context: OperationWorkContext
    ) => {
      const request = enrollmentRequest(plan, input.consentReceiptIds);

      return plan.consent.scopeDigest === operationScopeDigest(plan)
        ? options
            .enrollment(request, context)
            .pipe(Effect.map((consent) => consent.state === "authorized"))
        : Effect.succeed(false);
    },
    descriptor: {
      authorization: "existing-enrollment",
      cancellation: "between-steps",
      effects: {
        destructive: false,
        networkDestinations: [],
        reads: declaredReads,
        writes: [options.env.storePath, spoolDirFor(options.env.storePath)],
      },
      enabled: available,
      idempotency: "durable-key",
      kind: "collect",
      reason: available
        ? "Record limits count native JSONL frames plus normalized observations; other formats use conservative byte units. Actual nested decoder attempts are unavailable."
        : "No exact local source inputs were selected.",
      requiredInputs: ["source", "selectedRoots", "inputRefs", "parserVersion"],
      version: options.parserVersion,
    },
    execute,
    meteredWork: true,
    prepare: Effect.fn("collection.prepare")(
      function* selectedPlan(input, context) {
        const resolved = yield* resolveCollectionOptions(
          options,
          selectionRequest(input)
        );

        return yield* prepareCollection(resolved, input, workContext(context));
      }
    ),
    probe: Effect.fn("collection.probe")(function* probe(plan, step, receipt) {
      const resolved = yield* resolveCollectionOptions(
        options,
        selectionRequest(plan)
      );

      const selected = selectedFor(resolved, plan.arguments);

      const item = selected.find(
        (selection) => sourceStepId(selection) === step.id
      );

      if (item === undefined) {
        return {
          reason: "The step is outside the selected catalog.",
          state: "indeterminate" as const,
        };
      }

      for (const selection of selected) {
        const stored = receipt.steps.find(
          (entry) => entry.id === sourceStepId(selection)
        );

        if (stored === undefined) {
          continue;
        }

        const current = yield* cursorValue(options, selection);

        if ((stored.safeCursor ?? "null") === current) {
          acceptedCursors.set(
            plan.planDigest,
            new Map(acceptedCursors.get(plan.planDigest)).set(
              selection.inputRef.id,
              current
            )
          );
        }
      }

      const durable = receipt.steps.find((entry) => entry.id === step.id);

      if (
        durable !== undefined &&
        ["committed", "unchanged", "already-applied"].includes(durable.state)
      ) {
        return {
          result: {
            step: durable,
            verificationRefs: [item.inputRef],
          },
          state: "complete" as const,
        };
      }

      return { state: "absent" as const };
    }),
    replay: "safe",
    steps: (plan) => {
      const args = plan.arguments;

      return args.kind === "collect"
        ? args.inputRefs.map((ref) =>
            operationStep(sourceStepIdForRef(ref), args.source)
          )
        : [];
    },
    unmeasuredValidationResources: ["recordsDecoded"],
    validate,
  };
};
