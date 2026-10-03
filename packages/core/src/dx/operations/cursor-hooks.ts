// @effect-diagnostics-next-line nodeBuiltinImport:off -- Captured hook spool records and directory manifests use SHA-256 at the native source boundary.
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  // @effect-diagnostics-next-line nodeBuiltinImport:off -- Exact selected hook directories require native descriptors and O_NOFOLLOW before bounded content acquisition.
} from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Canonical source containment is checked before hook content acquisition.
import path from "node:path";

import { Effect, Exit, Option, Predicate, Schema } from "effect";

import { runHarnessRead } from "../cli/commands/collect.js";
import type { HarnessReadResult } from "../cli/commands/collect.js";
import { batchFromSpool } from "../collectors/cursor-hooks/collector.js";
import { CURSOR_HOOKS_ADAPTER_ID } from "../collectors/cursor-hooks/ids.js";
import { SpoolRecordSchema } from "../collectors/cursor-hooks/spool-record.js";
import type { SpoolRecord } from "../collectors/cursor-hooks/spool-record.js";
import type { AgentStoreFailure } from "../contracts/agent-store.js";
import { AgentError } from "../contracts/error-agent.js";
import { SourceUnavailable } from "../contracts/error-source-unavailable.js";
import type { Harness, SessionRef } from "../harness/contract.js";
import type { AgentScope } from "../model/agent-common.js";
import type {
  OperationPlan,
  OperationReceipt,
  OperationStep,
} from "../model/agent-operation.js";
import type { CollectCursor } from "../model/coverage.js";
import { DxEventEnvelopeSchema } from "../model/event.js";
import type { EventBatch } from "../model/event.js";
import type { StoredCursor } from "../storage/harness-cursors.js";
import { spoolDirFor } from "../storage/store-path.js";
import type { OperationWorkBudget } from "./budget.js";
import type {
  CollectionEnrollmentRequest,
  PlannedSourceOperationAdapterOptions,
  PlannedSourceSelection,
  SelectedSourceRequest,
} from "./collector.js";
import { operationScopeDigest, sameOperationAgentRefs } from "./digest.js";
import { operationStep } from "./ports.js";
import type {
  OperationAdapter,
  OperationEffectResult,
  OperationPlanInput,
  OperationPreparation,
  OperationProbe,
  OperationWorkContext,
} from "./ports.js";

export const BOUNDED_CURSOR_HOOK_OPERATION_VERSION =
  "dx.bounded-cursor-hooks.v1" as const;

export const CURSOR_HOOK_OPERATION_SOURCE = "collector.cursor-hooks" as const;

export type BoundedCursorHookOperationOptions = Pick<
  PlannedSourceOperationAdapterOptions,
  "cursors" | "enrollment" | "env" | "selected"
>;

export interface BoundedCursorHookIdentityOptions extends BoundedCursorHookOperationOptions {
  readonly grantIdentity?: (
    request: CollectionEnrollmentRequest,
    context: OperationWorkContext
  ) => Effect.Effect<string | null, AgentStoreFailure>;
}

interface CapturedHookFile {
  readonly bytes: Uint8Array;
  readonly digest: string;
  readonly identity: string;
  readonly mtimeMs: number;
  readonly name: string;
  readonly path: string;
}

interface HookDirectorySnapshot {
  readonly checkpoint: StoredCursor | null;
  readonly files: readonly CapturedHookFile[];
  readonly identity: string;
  readonly manifestDigest: string;
  readonly mtimeMs: number;
  readonly selection: PlannedSourceSelection;
}

interface HookDirectoryReview {
  readonly digest: string;
  readonly lastFile: string | null;
  readonly mtimeMs: number;
}

interface HookDecodeResult {
  readonly batch: EventBatch;
  readonly rejected: number;
  readonly retainCheckpoint: boolean;
  readonly complete: boolean;
}

interface HookDirectoryWork extends OperationWorkContext {
  readonly visited: Set<string>;
}

const decodeRecord = Schema.decodeUnknownOption(
  Schema.fromJsonString(SpoolRecordSchema)
);

const decodeEvent = Schema.decodeUnknownOption(DxEventEnvelopeSchema);

const decodeReview = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      digest: Schema.String,
      lastFile: Schema.NullOr(Schema.String),
      mtimeMs: Schema.Finite,
    })
  )
);

const digest = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const failure = (code: AgentError["code"], message: string): AgentError =>
  new AgentError({
    code,
    currentRevision: null,
    expectedRevision: null,
    message: message.slice(0, 4096),
    recovery: { action: "replan", ref: null },
    ref: null,
    retryable: false,
  });

const inside = (root: string, selected: string): boolean => {
  const relative = path.relative(root, selected);

  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
};

const sourceRequest = (
  input: OperationPlanInput | OperationPlan
): SelectedSourceRequest => ({
  arguments: input.arguments,
  bounds: input.bounds,
  scope: input.scope,
  storeGeneration:
    "target" in input ? input.target.storeGeneration : input.storeGeneration,
  storeId: "target" in input ? input.target.storeId : input.storeId,
});

const enrollmentRequest = (
  input: OperationPlanInput | OperationPlan,
  receiptIds: readonly string[]
): CollectionEnrollmentRequest => ({
  bounds: input.bounds,
  inputRefs:
    input.arguments.kind === "collect" ? input.arguments.inputRefs : [],
  receiptIds,
  scope: input.scope,
  selectedRoots:
    input.arguments.kind === "collect" ? input.arguments.selectedRoots : [],
  source: CURSOR_HOOK_OPERATION_SOURCE,
});

const stepId = (input: OperationPlanInput | OperationPlan): string =>
  `cursor-hooks.${digest(JSON.stringify(input.arguments)).slice(0, 32)}`;

const validSelectedDirectory = (
  entry: PlannedSourceSelection,
  request: SelectedSourceRequest
): boolean => {
  const { ref } = entry.planned;
  const args = request.arguments;

  return (
    args.kind === "collect" &&
    ref !== null &&
    ref.harness === "cursor" &&
    ref.channel === "hooks" &&
    entry.planned.harness === "cursor" &&
    entry.planned.input === ref.path &&
    entry.planned.unavailable === null &&
    entry.root === args.selectedRoots[0] &&
    ref.path === entry.inputRef.id &&
    path.isAbsolute(ref.path) &&
    path.isAbsolute(entry.root) &&
    ref.path === path.resolve(ref.path) &&
    entry.root === path.resolve(entry.root) &&
    inside(entry.root, ref.path) &&
    entry.inputRef.storeId === request.storeId &&
    entry.inputRef.storeGeneration === request.storeGeneration
  );
};

const validRecordedScope = (
  entry: PlannedSourceSelection,
  scope: AgentScope
): boolean => {
  const { context, ref } = entry.planned;

  return (
    scope.flightId === null &&
    context.flightId === null &&
    scope.branchSelection.kind !== "unresolved" &&
    (scope.branchSelection.kind === "all" ||
      scope.branchSelection.branches.length > 0) &&
    scope.sources.length === 1 &&
    scope.sources[0] === CURSOR_HOOK_OPERATION_SOURCE &&
    (scope.tools.length === 0 ||
      (scope.tools.length === 1 && scope.tools[0] === "cursor")) &&
    (scope.repoId === null || context.repoCommonDir !== null) &&
    (scope.worktreeId === null || context.worktreePath !== null) &&
    (ref === null ||
      ref.worktree === null ||
      ref.worktree === context.worktreePath)
  );
};

const selectDirectory = Effect.fn("cursorHooks.selectDirectory")(
  function* select(
    options: BoundedCursorHookOperationOptions,
    input: OperationPlanInput | OperationPlan
  ): Effect.fn.Return<PlannedSourceSelection, AgentStoreFailure> {
    const request = sourceRequest(input);
    const args = input.arguments;

    const selected = Predicate.isFunction(options.selected)
      ? yield* options.selected(request)
      : options.selected;

    if (
      args.kind !== "collect" ||
      args.source !== CURSOR_HOOK_OPERATION_SOURCE ||
      args.parserVersion !== BOUNDED_CURSOR_HOOK_OPERATION_VERSION ||
      args.inputRefs.length !== 1 ||
      args.selectedRoots.length !== 1
    ) {
      return yield* failure(
        "invalid-selector",
        "Select exactly one Cursor hook spool directory with its installed parser version."
      );
    }

    const [requested] = args.inputRefs;

    const matching = selected.filter(
      (entry) =>
        requested !== undefined &&
        sameOperationAgentRefs([entry.inputRef], [requested]) &&
        entry.planned.source === args.source
    );

    const entry = matching.length === 1 ? matching[0] : undefined;

    if (
      entry === undefined ||
      requested === undefined ||
      !validSelectedDirectory(entry, request)
    ) {
      return yield* failure(
        "scope-denied",
        "The selected input must exactly identify its enrolled native Cursor hook directory and store generation."
      );
    }

    if (!validRecordedScope(entry, input.scope)) {
      return yield* failure(
        "scope-denied",
        "Cursor hook acquisition requires a resolved recorded repository and worktree scope without inferred flight ownership."
      );
    }

    return entry;
  }
);

const visit = Effect.fn("cursorHooks.visit")(function* visitPath(
  key: string,
  context: HookDirectoryWork
) {
  if (context.visited.has(key)) {
    yield* context.budget.remaining;

    return;
  }

  const usage = {
    bytesRead: 0,
    filesRead: 1,
    recordsDecoded: 0,
    requests: 0,
    retries: 0,
  };

  const reservation = yield* context.budget.reserve(usage);

  yield* reservation.complete(usage);
  context.visited.add(key);
});

const checkedDirectory = (directory: string) => {
  const info = lstatSync(directory);

  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    realpathSync(directory) !== directory
  ) {
    throw failure(
      "plan-stale",
      "The selected hook directory must remain canonical and contain no symlink components."
    );
  }

  return info;
};

const directoryIdentity = (directory: string): string => {
  const info = checkedDirectory(directory);

  return `${String(info.dev)}:${String(info.ino)}`;
};

const captureFile = Effect.fn("cursorHooks.captureFile")(function* capture(
  directory: string,
  identity: string,
  name: string,
  context: HookDirectoryWork
): Effect.fn.Return<CapturedHookFile, AgentStoreFailure> {
  const file = path.join(directory, name);

  yield* visit(`capture:${file}`, context);

  const selected = yield* Effect.try({
    catch: (error) =>
      Schema.is(AgentError)(error)
        ? error
        : failure(
            "source-unavailable",
            error instanceof Error ? error.message : String(error)
          ),
    try: () => {
      if (directoryIdentity(directory) !== identity) {
        throw failure("plan-stale", "The selected hook directory changed.");
      }

      const info = lstatSync(file);

      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        realpathSync(file) !== file ||
        directoryIdentity(directory) !== identity
      ) {
        throw failure(
          "plan-stale",
          "A selected hook spool entry is not an exact regular file."
        );
      }

      return info;
    },
  });

  const reservation = yield* context.budget.reserve({
    bytesRead: selected.size,
    filesRead: 0,
    recordsDecoded: 0,
    requests: 0,
    retries: 0,
  });

  const measured = { bytesRead: 0 };

  const captured = yield* Effect.exit(
    Effect.try({
      catch: (error) =>
        Schema.is(AgentError)(error)
          ? error
          : failure(
              "source-unavailable",
              error instanceof Error ? error.message : String(error)
            ),
      try: () => {
        const fd = openSync(file, constants.O_NOFOLLOW);

        try {
          const opened = fstatSync(fd);
          const identityOfFile = `${String(opened.dev)}:${String(opened.ino)}`;

          if (
            !opened.isFile() ||
            opened.dev !== selected.dev ||
            opened.ino !== selected.ino ||
            opened.size !== selected.size ||
            opened.mtimeMs !== selected.mtimeMs ||
            directoryIdentity(directory) !== identity ||
            realpathSync(file) !== file
          ) {
            throw failure(
              "plan-stale",
              "The selected hook file changed before capture."
            );
          }

          const bytes = new Uint8Array(opened.size);

          while (measured.bytesRead < bytes.byteLength) {
            const count = readSync(
              fd,
              bytes,
              measured.bytesRead,
              bytes.byteLength - measured.bytesRead,
              measured.bytesRead
            );

            if (count === 0) {
              throw failure(
                "plan-stale",
                "A hook file was truncated during capture."
              );
            }

            measured.bytesRead += count;
          }

          const after = fstatSync(fd);
          const visible = lstatSync(file);

          if (
            after.size !== opened.size ||
            after.mtimeMs !== opened.mtimeMs ||
            visible.dev !== opened.dev ||
            visible.ino !== opened.ino ||
            visible.isSymbolicLink() ||
            directoryIdentity(directory) !== identity
          ) {
            throw failure("plan-stale", "A hook file changed during capture.");
          }

          return {
            bytes,
            digest: digest(bytes),
            identity: identityOfFile,
            mtimeMs: opened.mtimeMs,
            name,
            path: file,
          };
        } finally {
          closeSync(fd);
        }
      },
    })
  );

  yield* reservation.complete({
    bytesRead: measured.bytesRead,
    filesRead: 0,
    recordsDecoded: 0,
    requests: 0,
    retries: 0,
  });

  return Exit.isSuccess(captured)
    ? captured.value
    : yield* Effect.failCause(captured.cause);
});

const captureDirectory = Effect.fn("cursorHooks.captureDirectory")(
  function* capture(
    options: BoundedCursorHookOperationOptions,
    selection: PlannedSourceSelection,
    context: HookDirectoryWork,
    review?: HookDirectoryReview
  ): Effect.fn.Return<HookDirectorySnapshot, AgentStoreFailure> {
    const { ref } = selection.planned;

    if (ref === null) {
      return yield* failure(
        "invalid-selector",
        "The hook directory reference is missing."
      );
    }

    yield* visit(`directory:${ref.path}`, context);

    const checkpoint =
      options.cursors === undefined || options.cursors === null
        ? null
        : yield* options.cursors.get(ref);

    const afterFile =
      checkpoint?.cursor?.adapterId === CURSOR_HOOKS_ADAPTER_ID
        ? checkpoint.cursor.value
        : null;

    const directory = yield* Effect.try({
      catch: (error) =>
        Schema.is(AgentError)(error)
          ? error
          : failure(
              "source-unavailable",
              error instanceof Error ? error.message : String(error)
            ),
      try: () => checkedDirectory(ref.path),
    });

    const identity = `${String(directory.dev)}:${String(directory.ino)}`;
    const names: string[] = [];

    yield* Effect.scoped(
      Effect.gen(function* enumerate() {
        const opened = yield* Effect.acquireRelease(
          Effect.try({
            catch: (error) =>
              Schema.is(AgentError)(error)
                ? error
                : failure(
                    "source-unavailable",
                    error instanceof Error ? error.message : String(error)
                  ),
            try: () => {
              const fd = openSync(
                ref.path,
                constants.O_DIRECTORY + constants.O_NOFOLLOW
              );

              try {
                const pinned = fstatSync(fd);

                if (
                  `${String(pinned.dev)}:${String(pinned.ino)}` !== identity
                ) {
                  throw failure(
                    "plan-stale",
                    "The hook directory changed before enumeration."
                  );
                }

                return { fd, stream: opendirSync(ref.path, { bufferSize: 1 }) };
              } catch (error) {
                closeSync(fd);

                throw error;
              }
            },
          }),
          (resource) =>
            Effect.sync(() => {
              try {
                resource.stream.closeSync();
              } finally {
                closeSync(resource.fd);
              }
            })
        );

        let complete = false;

        while (!complete) {
          const entryUsage = {
            bytesRead: 0,
            filesRead: 1,
            recordsDecoded: 0,
            requests: 0,
            retries: 0,
          };

          const entryReservation = yield* context.budget.reserve(entryUsage);

          const entry = yield* Effect.try({
            catch: (error) =>
              Schema.is(AgentError)(error)
                ? error
                : failure(
                    "source-unavailable",
                    error instanceof Error ? error.message : String(error)
                  ),
            try: () => opened.stream.readSync(),
          });

          yield* entryReservation.complete({
            ...entryUsage,
            filesRead: entry === null ? 0 : 1,
          });

          if (entry === null) {
            complete = true;
          } else if (
            entry.name.endsWith(".json") &&
            !entry.name.startsWith(".") &&
            (afterFile === null || entry.name > afterFile) &&
            (review === undefined ||
              (review.lastFile !== null && entry.name <= review.lastFile))
          ) {
            names.push(entry.name);
          }
        }

        yield* Effect.try({
          catch: (error) =>
            Schema.is(AgentError)(error)
              ? error
              : failure(
                  "source-unavailable",
                  error instanceof Error ? error.message : String(error)
                ),
          try: () => {
            if (directoryIdentity(ref.path) !== identity) {
              throw failure(
                "plan-stale",
                "The selected hook directory changed during enumeration."
              );
            }
          },
        });
      })
    );

    const files = yield* Effect.forEach(names.toSorted(), (name) =>
      captureFile(ref.path, identity, name, context)
    );

    return {
      checkpoint,
      files,
      identity,
      manifestDigest: digest(
        JSON.stringify(
          files.map((file) => [
            file.name,
            file.identity,
            file.bytes.byteLength,
            file.mtimeMs,
            file.digest,
          ])
        )
      ),
      mtimeMs: directory.mtimeMs,
      selection,
    };
  }
);

const recordMatchesScope = (
  record: SpoolRecord,
  snapshot: HookDirectorySnapshot,
  scope: AgentScope
): boolean => {
  const { context } = snapshot.selection.planned;

  return (
    (scope.repoId === null ||
      record.git.repoCommonDir === context.repoCommonDir) &&
    (scope.worktreeId === null ||
      record.git.worktreePath === context.worktreePath) &&
    (scope.branchSelection.kind === "all" ||
      (record.git.branch !== null &&
        scope.branchSelection.branches.includes(record.git.branch)))
  );
};

const checkCapturedFiles = Effect.fn("cursorHooks.checkCapturedFiles")(
  function* checkSnapshot(
    snapshot: HookDirectorySnapshot,
    allowGrowth: boolean,
    context: HookDirectoryWork
  ) {
    const directory = snapshot.selection.planned.input;

    if (directory === null) {
      return yield* failure(
        "source-unavailable",
        "The selected hook directory is unavailable."
      );
    }

    yield* visit(`directory:${directory}`, context);

    return yield* Effect.try({
      catch: (error) =>
        Schema.is(AgentError)(error)
          ? error
          : failure(
              "source-unavailable",
              error instanceof Error ? error.message : String(error)
            ),
      try: () => {
        const current = checkedDirectory(directory);

        if (
          `${String(current.dev)}:${String(current.ino)}` !==
            snapshot.identity ||
          (!allowGrowth && current.mtimeMs !== snapshot.mtimeMs)
        ) {
          throw failure(
            "plan-stale",
            "The selected hook directory changed after capture."
          );
        }

        for (const file of snapshot.files) {
          const visible = lstatSync(file.path);

          if (
            !visible.isFile() ||
            visible.isSymbolicLink() ||
            `${String(visible.dev)}:${String(visible.ino)}` !== file.identity ||
            visible.size !== file.bytes.byteLength ||
            visible.mtimeMs !== file.mtimeMs ||
            realpathSync(file.path) !== file.path
          ) {
            throw failure(
              "plan-stale",
              "A reviewed hook file changed after capture."
            );
          }
        }
      },
    });
  }
);

const normalizeRecords = Effect.fn("cursorHooks.normalizeRecords")(
  function* normalize(
    snapshot: HookDirectorySnapshot,
    records: readonly SpoolRecord[],
    rejected: readonly string[],
    context: OperationWorkContext
  ) {
    const usage = {
      bytesRead: 0,
      filesRead: 0,
      recordUnits: records.reduce(
        (total, record) =>
          total +
          (record.hook.hookEvent === "stop" && record.hook.rawUsage.length > 0
            ? 2
            : 1),
        0
      ),
      recordsDecoded: 0,
      requests: 0,
      retries: 0,
    };

    const reservation = yield* context.budget.reserve(usage);

    const normalized = yield* Effect.exit(
      Effect.try({
        catch: (error) =>
          failure(
            "source-unavailable",
            error instanceof Error ? error.message : String(error)
          ),
        try: () => {
          const batch = batchFromSpool(
            {
              lastFile: snapshot.files.at(-1)?.name ?? null,
              records,
              rejected,
            },
            {
              adapterId: CURSOR_HOOKS_ADAPTER_ID,
              context: snapshot.selection.planned.context,
              cursor: snapshot.checkpoint?.cursor ?? null,
              origin: "imported",
              scratchDir: null,
              selectedInput: snapshot.selection.planned.input,
            }
          );

          const validated = batch.events.map((event) => decodeEvent(event));

          const events = validated.flatMap((event) =>
            Option.isSome(event) ? [event.value] : []
          );

          return {
            batch: { ...batch, events },
            invalidEvents: validated.length - events.length,
          };
        },
      })
    );

    yield* reservation.complete(usage);

    return Exit.isSuccess(normalized)
      ? normalized.value
      : yield* Effect.failCause(normalized.cause);
  }
);

const decodeDirectory = Effect.fn("cursorHooks.decodeDirectory")(
  function* decode(
    snapshot: HookDirectorySnapshot,
    scope: AgentScope,
    context: OperationWorkContext
  ): Effect.fn.Return<HookDecodeResult, AgentStoreFailure> {
    const records: SpoolRecord[] = [];
    const rejected: string[] = [];
    let filtered = 0;
    const textDecoder = new TextDecoder("utf-8", { fatal: true });

    for (const file of snapshot.files) {
      const reservation = yield* context.budget.reserve({
        bytesRead: 0,
        filesRead: 0,
        recordUnits: 1,
        recordsDecoded: null,
        requests: 0,
        retries: 0,
      });

      const text = yield* Effect.try({
        catch: () =>
          failure(
            "source-unavailable",
            "The selected hook record is not valid UTF-8."
          ),
        try: () => textDecoder.decode(file.bytes),
      }).pipe(
        Effect.match({ onFailure: () => null, onSuccess: (decoded) => decoded })
      );

      if (text === null) {
        rejected.push(file.name);
      }

      if (text !== null) {
        const decoded = decodeRecord(text);

        if (Option.isNone(decoded)) {
          rejected.push(file.name);
        } else if (recordMatchesScope(decoded.value, snapshot, scope)) {
          records.push(decoded.value);
        } else {
          filtered += 1;
        }
      }

      yield* reservation.complete({
        bytesRead: 0,
        filesRead: 0,
        recordUnits: 1,
        recordsDecoded: null,
        requests: 0,
        retries: 0,
      });
      yield* Effect.yieldNow;
    }

    const { batch: native, invalidEvents } = yield* normalizeRecords(
      snapshot,
      records,
      rejected,
      context
    );

    const gaps = [
      ...native.coverage.gaps,
      {
        code: "cursor-hooks.logical-metering",
        message:
          "The record allowance counts top-level JSON spool records plus normalized observations; nested decoder attempts and physical control-store I/O are unavailable.",
      },
      {
        code: "cursor-hooks.no-recorded-flight",
        message:
          "Cursor hook spool records contain no recorded flight identity; observations remain repository scoped with flightId unavailable.",
      },
      {
        code: "cursor-hooks.native-directory-boundary",
        message:
          "Final-file nofollow and before/after canonical-path, parent-inode, and file-descriptor checks reject observed changes. Node/macOS provides no directory-relative openat here; adversarial ancestor swaps between checks cannot be excluded.",
      },
      {
        code: "cursor-hooks.capture-timestamps",
        message:
          "All hook observation timestamps are handler capture times; source event timestamps are unavailable.",
      },
      ...(filtered > 0
        ? [
            {
              code: "cursor-hooks.scope-filtered",
              message: `${String(filtered)} recorded hooks were outside the selected recorded scope.`,
            },
          ]
        : []),
      ...(invalidEvents > 0
        ? [
            {
              code: "cursor-hooks.invalid-events",
              message: `${String(invalidEvents)} native observations failed event validation.`,
            },
          ]
        : []),
    ];

    return {
      batch: {
        ...native,
        coverage: {
          ...native.coverage,
          expectedItems: snapshot.files.length,
          gaps,
          state:
            filtered > 0 || invalidEvents > 0
              ? "partial"
              : native.coverage.state,
        },
        events: native.events,
      },
      complete:
        rejected.length === 0 &&
        invalidEvents === 0 &&
        (native.coverage.state === "complete" ||
          (native.coverage.state === "none" && records.length === 0)),
      rejected: rejected.length + invalidEvents,
      retainCheckpoint: filtered > 0 || invalidEvents > 0,
    };
  }
);

const snapshotHarness = (
  snapshot: HookDirectorySnapshot,
  batch: EventBatch
): Harness => ({
  capabilities: {
    branchSources: ["hook", "unassigned"],
    liveHooks: true,
    storedFigure: null,
    subagents: true,
  },
  channels: ["hooks"],
  discover: Effect.succeed({
    harness: "cursor",
    present: true,
    reason: null,
    roots: [snapshot.selection.root],
    sessions: snapshot.files.length,
    version: BOUNDED_CURSOR_HOOK_OPERATION_VERSION,
  }),
  displayName: "Cursor",
  id: "cursor",
  locate: () =>
    Effect.succeed(
      snapshot.selection.planned.ref === null
        ? []
        : [snapshot.selection.planned.ref]
    ),
  read: (ref: SessionRef) =>
    ref.id === snapshot.selection.planned.ref?.id &&
    ref.path === snapshot.selection.planned.input
      ? Effect.succeed(batch)
      : Effect.fail(
          new SourceUnavailable({
            adapterId: CURSOR_HOOKS_ADAPTER_ID,
            message:
              "The requested Cursor hook directory does not match its captured snapshot.",
          })
        ),
});

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

const directoryMetadata = Effect.fn("cursorHooks.directoryMetadata")(
  function* inspect(
    selection: PlannedSourceSelection,
    context: HookDirectoryWork
  ) {
    const { ref } = selection.planned;

    if (ref === null) {
      return yield* failure(
        "source-unavailable",
        "The selected Cursor hook directory is missing."
      );
    }

    yield* visit(`directory:${ref.path}`, context);

    const metadata = yield* Effect.try({
      catch: () =>
        failure(
          "source-unavailable",
          "The selected Cursor hook directory metadata is unavailable."
        ),
      try: () => {
        const info = checkedDirectory(ref.path);

        return {
          ctimeMs: info.ctimeMs,
          identity: `${String(info.dev)}:${String(info.ino)}`,
          mtimeMs: info.mtimeMs,
        };
      },
    });

    const files: {
      readonly name: string;
      readonly identity: string;
      readonly size: number;
      readonly mtimeMs: number;
      readonly ctimeMs: number;
    }[] = [];

    yield* Effect.scoped(
      Effect.gen(function* enumerateMetadata() {
        const opened = yield* Effect.acquireRelease(
          Effect.try({
            catch: () =>
              failure(
                "source-unavailable",
                "The selected hook metadata directory could not be opened."
              ),
            try: () => {
              const fd = openSync(
                ref.path,
                constants.O_DIRECTORY + constants.O_NOFOLLOW
              );

              try {
                const pinned = fstatSync(fd);

                if (
                  `${String(pinned.dev)}:${String(pinned.ino)}` !==
                  metadata.identity
                ) {
                  throw failure(
                    "plan-stale",
                    "The hook metadata directory changed before enumeration."
                  );
                }

                return { fd, stream: opendirSync(ref.path, { bufferSize: 1 }) };
              } catch (error) {
                closeSync(fd);

                throw error;
              }
            },
          }),
          (resource) =>
            Effect.sync(() => {
              try {
                resource.stream.closeSync();
              } finally {
                closeSync(resource.fd);
              }
            })
        );

        let complete = false;

        while (!complete) {
          const usage = {
            bytesRead: 0,
            filesRead: 1,
            recordsDecoded: 0,
            requests: 0,
            retries: 0,
          };

          const reservation = yield* context.budget.reserve(usage);

          const entry = yield* Effect.try({
            catch: () =>
              failure(
                "source-unavailable",
                "The selected hook directory entry metadata is unavailable."
              ),
            try: () => opened.stream.readSync(),
          });

          yield* reservation.complete({
            ...usage,
            filesRead: entry === null ? 0 : 1,
          });

          if (entry === null) {
            complete = true;
          } else if (
            entry.name.endsWith(".json") &&
            !entry.name.startsWith(".")
          ) {
            const file = path.join(ref.path, entry.name);

            yield* visit(`metadata:${file}`, context);
            files.push(
              yield* Effect.try({
                catch: () =>
                  failure(
                    "source-unavailable",
                    "A selected hook file's metadata is unavailable."
                  ),
                try: () => {
                  const info = lstatSync(file);

                  if (
                    !info.isFile() ||
                    info.isSymbolicLink() ||
                    realpathSync(file) !== file ||
                    directoryIdentity(ref.path) !== metadata.identity
                  ) {
                    throw failure(
                      "plan-stale",
                      "A selected hook metadata entry changed identity or contains a symlink."
                    );
                  }

                  return {
                    ctimeMs: info.ctimeMs,
                    identity: `${String(info.dev)}:${String(info.ino)}`,
                    mtimeMs: info.mtimeMs,
                    name: entry.name,
                    size: info.size,
                  };
                },
              })
            );
          }
        }
      })
    );

    const unchanged = yield* Effect.try({
      catch: () =>
        failure(
          "plan-stale",
          "The hook directory metadata became unavailable."
        ),
      try: () => {
        const after = checkedDirectory(ref.path);

        return (
          `${String(after.dev)}:${String(after.ino)}` === metadata.identity &&
          after.mtimeMs === metadata.mtimeMs &&
          after.ctimeMs === metadata.ctimeMs
        );
      },
    });

    if (!unchanged) {
      return yield* failure(
        "plan-stale",
        "The hook directory namespace changed during metadata inspection."
      );
    }

    return {
      directory: metadata,
      files: files.toSorted((left, right) =>
        left.name.localeCompare(right.name)
      ),
    };
  }
);

export const makeBoundedCursorHookIdentityProbe = (
  options: BoundedCursorHookIdentityOptions
): ((
  request: SelectedSourceRequest,
  context: OperationWorkContext
) => Effect.Effect<string | null, AgentStoreFailure>) =>
  Effect.fn("cursorHooks.completedIdentity")(
    function* completedIdentity(request, context) {
      const input: OperationPlanInput = {
        action: "plan",
        arguments: request.arguments,
        bounds: request.bounds,
        purpose:
          "Inspect only the selected Cursor hook metadata for an unchanged live acquisition.",
        scope: request.scope,
        target: {
          revision: "metadata-probe",
          storeGeneration: request.storeGeneration,
          storeId: request.storeId,
        },
      };

      const selection = yield* selectDirectory(options, input);
      const requestEnrollment = enrollmentRequest(input, []);
      const consent = yield* options.enrollment(requestEnrollment, context);
      const { cursors, grantIdentity } = options;
      const { ref } = selection.planned;

      if (
        consent.state !== "authorized" ||
        cursors?.putIfCurrent === undefined ||
        ref === null
      ) {
        return null;
      }

      const grantBefore =
        grantIdentity === undefined
          ? null
          : yield* grantIdentity(requestEnrollment, context);

      if (grantIdentity !== undefined && grantBefore === null) {
        return null;
      }

      const checkpointBefore = yield* cursors.get(ref);

      const metadata = yield* directoryMetadata(selection, {
        ...context,
        visited: new Set(),
      });

      const checkpointAfter = yield* cursors.get(ref);

      const consentAfter = yield* options.enrollment(
        requestEnrollment,
        context
      );

      const grantAfter =
        grantIdentity === undefined
          ? null
          : yield* grantIdentity(requestEnrollment, context);

      if (
        consentAfter.state !== "authorized" ||
        grantAfter !== grantBefore ||
        JSON.stringify(checkpointBefore) !== JSON.stringify(checkpointAfter)
      ) {
        return null;
      }

      return digest(
        JSON.stringify({
          checkpoint: checkpointAfter,
          grantDigest: grantAfter,
          metadata,
          request,
        })
      );
    },
    Effect.match({
      onFailure: () => null,
      onSuccess: (fingerprint: string | null) => fingerprint,
    })
  );

const advanceCheckpoint = Effect.fn("cursorHooks.advanceCheckpoint")(
  function* advance(
    options: BoundedCursorHookOperationOptions,
    snapshot: HookDirectorySnapshot,
    decoded: HookDecodeResult,
    result: HarnessReadResult
  ) {
    const { ref } = snapshot.selection.planned;
    const checkpoint = options.cursors;

    const gaps = result.coverage.gaps.map(
      (gap) => `${gap.code}: ${gap.message}`
    );

    const previous = snapshot.checkpoint?.cursor ?? null;

    if (result.spooledTo !== null || ref === null) {
      return { complete: false, gaps, safeCursor: previous };
    }

    if (!decoded.complete) {
      gaps.push(
        "The previous checkpoint was retained because some reviewed hook records or native observations remain invalid or unsupported."
      );

      return { complete: false, gaps, safeCursor: previous };
    }

    if (checkpoint?.putIfCurrent === undefined) {
      gaps.push(
        "The shared cursor compare-and-set port is unavailable; the previous checkpoint was retained."
      );

      return { complete: false, gaps, safeCursor: previous };
    }

    const unchangedDirectory = yield* Effect.try({
      catch: () =>
        failure(
          "plan-stale",
          "The hook directory identity is unavailable after append."
        ),
      try: () => {
        const current = checkedDirectory(ref.path);

        return (
          `${String(current.dev)}:${String(current.ino)}` ===
            snapshot.identity && current.mtimeMs === snapshot.mtimeMs
        );
      },
    }).pipe(Effect.orElseSucceed(() => false));

    if (!unchangedDirectory) {
      gaps.push(
        "The directory namespace changed after capture; the previous checkpoint was retained so newly arrived earlier lexical records cannot be skipped."
      );

      return { complete: false, gaps, safeCursor: previous };
    }

    if (decoded.retainCheckpoint) {
      gaps.push(
        "The previous global directory checkpoint was intentionally retained because valid records outside this exact selected scope may be needed by a later scope."
      );

      return { complete: true, gaps, safeCursor: previous };
    }

    if (result.cursor === null) {
      return { complete: true, gaps, safeCursor: previous };
    }

    const advanced = yield* checkpoint
      .putIfCurrent(ref, snapshot.checkpoint, {
        cursor: result.cursor,
        lastEventId:
          result.lastEventId ?? snapshot.checkpoint?.lastEventId ?? null,
        mtimeMs: null,
        size: null,
      })
      .pipe(
        Effect.catch((error) => {
          gaps.push(
            `The committed hook checkpoint could not be saved: ${error.message}`
          );

          return Effect.succeed(false);
        })
      );

    if (advanced) {
      return { complete: true, gaps, safeCursor: result.cursor };
    }

    gaps.push(
      "The hook checkpoint changed concurrently; committed observations were retained and the previous checkpoint was not overwritten."
    );

    return { complete: false, gaps, safeCursor: previous };
  }
);

const collectionState = (
  result: HarnessReadResult,
  snapshot: HookDirectorySnapshot,
  complete: boolean
): OperationStep["state"] => {
  if (result.spooledTo !== null) {
    return "spooled";
  }

  if (!complete) {
    return "partial";
  }

  if (result.events === 0 && snapshot.files.length === 0) {
    return "unchanged";
  }

  if (
    result.events > 0 &&
    result.inserted === 0 &&
    result.duplicates === result.events
  ) {
    return "already-applied";
  }

  return "committed";
};

const collectionRemainingWork = (
  result: HarnessReadResult,
  complete: boolean
): string | null => {
  if (result.spooledTo !== null) {
    return "Import the selected staged batch and reread the preserved Cursor hook checkpoint.";
  }

  return complete
    ? null
    : "Recorded observations are retained; resolve reported source and checkpoint gaps in a new selected operation.";
};

const effectResult = (
  plan: OperationPlan,
  step: OperationStep,
  snapshot: HookDirectorySnapshot,
  decoded: HookDecodeResult,
  result: HarnessReadResult,
  checkpoint: {
    readonly safeCursor: CollectCursor | null;
    readonly gaps: readonly string[];
    readonly complete: boolean;
  }
): OperationEffectResult => {
  const { complete, gaps, safeCursor } = checkpoint;

  const mapped: OperationStep = {
    ...step,
    committedThrough: result.spooledTo === null ? result.lastEventId : null,
    duplicates: result.duplicates,
    gaps: gaps.slice(0, 64).map((gap) => gap.slice(0, 4096)),
    inserted: result.inserted,
    rejected: decoded.rejected,
    remainingWork: collectionRemainingWork(result, complete),
    safeCursor: safeCursor === null ? null : JSON.stringify(safeCursor),
    spooledRefs: result.spooledTo === null ? [] : [result.spooledTo],
    state: collectionState(result, snapshot, complete),
  };

  return {
    effects: {
      ...emptyEffects(plan.storeGeneration),
      evidenceIds:
        result.spooledTo === null && result.lastEventId !== null
          ? [result.lastEventId]
          : [],
      filesChanged: mapped.spooledRefs,
    },
    step: mapped,
    verificationRefs: [snapshot.selection.inputRef],
  };
};

export const makeBoundedCursorHookOperationAdapter = (
  options: BoundedCursorHookOperationOptions
): OperationAdapter => {
  const captures = new WeakMap<
    OperationWorkBudget,
    Map<string, HookDirectorySnapshot>
  >();

  const visited = new WeakMap<OperationWorkBudget, Set<string>>();
  const completed = new Map<string, OperationEffectResult>();

  const workContext = (context: OperationWorkContext): HookDirectoryWork => {
    const paths = visited.get(context.budget) ?? new Set<string>();

    visited.set(context.budget, paths);

    return { ...context, visited: paths };
  };

  const snapshotsFor = (budget: OperationWorkBudget) => {
    const snapshots =
      captures.get(budget) ?? new Map<string, HookDirectorySnapshot>();

    captures.set(budget, snapshots);

    return snapshots;
  };

  const prepare = Effect.fn("cursorHooks.prepare")(function* prepare(
    input: OperationPlanInput,
    context: OperationWorkContext
  ): Effect.fn.Return<OperationPreparation, AgentStoreFailure> {
    const selection = yield* selectDirectory(options, input);

    const consent = yield* options.enrollment(
      enrollmentRequest(input, []),
      context
    );

    if (consent.state !== "authorized") {
      return yield* failure(
        consent.state === "denied" ? "scope-denied" : "authorization-required",
        consent.reason ??
          "Existing Cursor source enrollment is required before reading its hook spool."
      );
    }

    const snapshot = yield* captureDirectory(
      options,
      selection,
      workContext(context)
    );

    const cursor = JSON.stringify(snapshot.checkpoint?.cursor ?? null);

    if (input.arguments.kind !== "collect") {
      return yield* failure(
        "invalid-selector",
        "Expected collection arguments."
      );
    }

    if (input.arguments.cursor !== null && input.arguments.cursor !== cursor) {
      return yield* failure(
        "cursor-mismatch",
        "The explicit Cursor hook checkpoint changed."
      );
    }

    const target = selection.inputRef.id;

    return {
      arguments: input.arguments,
      consent: { ...consent, scopeDigest: "pending" },
      effects: {
        destructive: false,
        networkDestinations: [],
        reads: [target],
        writes: [options.env.storePath, spoolDirFor(options.env.storePath)],
      },
      expectedEvidenceImprovement:
        "Import only the reviewed Cursor hook records with their recorded Git scope and native usage semantics.",
      forecast: {
        bytes: snapshot.files.reduce(
          (total, file) => total + file.bytes.byteLength,
          0
        ),
        cost: null,
        elapsedMs: null,
        requests: 0,
      },
      preconditions: [
        {
          allowAppend: false,
          expected: snapshot.identity,
          kind: "source-identity",
          target,
        },
        {
          allowAppend: input.arguments.allowSourceGrowth,
          expected: JSON.stringify({
            digest: snapshot.manifestDigest,
            lastFile: snapshot.files.at(-1)?.name ?? null,
            mtimeMs: snapshot.mtimeMs,
          }),
          kind: "source-content",
          target,
        },
        { allowAppend: false, expected: cursor, kind: "source-cursor", target },
        {
          allowAppend: false,
          expected: BOUNDED_CURSOR_HOOK_OPERATION_VERSION,
          kind: "parser-version",
          target: CURSOR_HOOK_OPERATION_SOURCE,
        },
      ],
      resumeBoundary: "complete-record",
      stopCondition:
        "Stop after the reviewed lexical JSON-file window or when cumulative visited-directory entries, captured bytes, top-level records plus normalized observations, or elapsed-time limits prevent further work. Nested decoder attempts and physical control-store I/O are unavailable. Node/macOS lacks directory-relative openat protection against adversarial ancestor swaps between checks.",
    };
  });

  const validateInputs = Effect.fn("cursorHooks.validateInputs")(
    function* validate(plan: OperationPlan, context: OperationWorkContext) {
      const selection = yield* selectDirectory(options, plan);

      const consent = yield* options.enrollment(
        enrollmentRequest(plan, plan.consent.receiptIds),
        context
      );

      if (consent.state !== "authorized") {
        return [
          consent.reason ?? "Cursor source enrollment is no longer authorized.",
        ];
      }

      const target = selection.inputRef.id;

      const content = plan.preconditions.find(
        (entry) => entry.kind === "source-content" && entry.target === target
      );

      const identity = plan.preconditions.find(
        (entry) => entry.kind === "source-identity" && entry.target === target
      );

      const cursor = plan.preconditions.find(
        (entry) => entry.kind === "source-cursor" && entry.target === target
      );

      const parser = plan.preconditions.find(
        (entry) =>
          entry.kind === "parser-version" &&
          entry.target === CURSOR_HOOK_OPERATION_SOURCE
      );

      if (
        content === undefined ||
        identity === undefined ||
        cursor === undefined ||
        parser?.expected !== BOUNDED_CURSOR_HOOK_OPERATION_VERSION ||
        plan.arguments.kind !== "collect"
      ) {
        return ["The reviewed Cursor hook preconditions are incomplete."];
      }

      const review = yield* decodeReview(content.expected).pipe(
        Effect.mapError(() =>
          failure("plan-stale", "The reviewed hook window is invalid.")
        )
      );

      const retained = snapshotsFor(context.budget).get(plan.planDigest);

      const snapshot =
        retained ??
        (yield* captureDirectory(
          options,
          selection,
          workContext(context),
          review
        ));

      yield* checkCapturedFiles(
        snapshot,
        plan.arguments.allowSourceGrowth,
        workContext(context)
      );

      const checkpoint =
        options.cursors === null ||
        options.cursors === undefined ||
        selection.planned.ref === null
          ? null
          : yield* options.cursors.get(selection.planned.ref);

      if (JSON.stringify(checkpoint?.cursor ?? null) !== cursor.expected) {
        return [
          "The Cursor hook checkpoint changed without this operation's verified receipt.",
        ];
      }

      if (
        snapshot.identity !== identity.expected ||
        snapshot.manifestDigest !== review.digest ||
        (!plan.arguments.allowSourceGrowth &&
          snapshot.mtimeMs !== review.mtimeMs)
      ) {
        return [
          "The selected Cursor hook directory or reviewed file contents changed.",
        ];
      }

      snapshotsFor(context.budget).set(plan.planDigest, snapshot);

      return [];
    }
  );

  const validate = Effect.fn("cursorHooks.validate")(function* validate(
    plan: OperationPlan,
    context: OperationWorkContext
  ) {
    return yield* validateInputs(plan, context).pipe(
      Effect.catch((error) => Effect.succeed([error.message]))
    );
  });

  const execute: OperationAdapter["execute"] = Effect.fn("cursorHooks.execute")(
    function* execute(plan, step, context) {
      if (step.id !== stepId(plan)) {
        return yield* failure(
          "scope-denied",
          "The operation step is outside the selected Cursor hook directory."
        );
      }

      const problems = yield* validateInputs(plan, context);

      if (problems.length > 0) {
        return yield* failure("plan-stale", problems.join(" "));
      }

      const snapshot = snapshotsFor(context.budget).get(plan.planDigest);
      const ref = snapshot?.selection.planned.ref;

      if (snapshot === undefined || ref === null || ref === undefined) {
        return yield* failure(
          "source-unavailable",
          "The reviewed Cursor hook snapshot is unavailable."
        );
      }

      const decoded = yield* decodeDirectory(snapshot, plan.scope, context);

      yield* checkCapturedFiles(snapshot, true, workContext(context));
      yield* context.budget.remaining;

      const appended = yield* Effect.exit(
        runHarnessRead(options.env, {
          context: snapshot.selection.planned.context,
          cursor: snapshot.checkpoint?.cursor ?? null,
          harness: snapshotHarness(snapshot, decoded.batch),
          ref,
        })
      );

      if (Exit.isFailure(appended)) {
        return yield* Effect.failCause(appended.cause).pipe(
          Effect.mapError((error) =>
            failure("source-unavailable", error.message)
          )
        );
      }

      const result = appended.value;

      const checkpoint = yield* advanceCheckpoint(
        options,
        snapshot,
        decoded,
        result
      );

      const output = effectResult(
        plan,
        step,
        snapshot,
        decoded,
        result,
        checkpoint
      );

      if (result.spooledTo === null) {
        if (!completed.has(plan.planDigest) && completed.size >= 256) {
          const oldest = completed.keys().next().value;

          if (oldest !== undefined) {
            completed.delete(oldest);
          }
        }

        completed.set(plan.planDigest, output);
      }

      return output;
    }
  );

  const probe: OperationAdapter["probe"] = Effect.fn("cursorHooks.probe")(
    function* probe(
      plan,
      step,
      _receipt,
      context
    ): Effect.fn.Return<OperationProbe, AgentStoreFailure> {
      const result = completed.get(plan.planDigest);

      if (result !== undefined && result.step.id === step.id) {
        return { result, state: "complete" };
      }

      const selection = yield* selectDirectory(options, plan);
      const { ref } = selection.planned;

      const expected = plan.preconditions.find(
        (entry) =>
          entry.kind === "source-cursor" &&
          entry.target === selection.inputRef.id
      );

      const checkpoint =
        options.cursors === null ||
        options.cursors === undefined ||
        ref === null
          ? null
          : yield* options.cursors.get(ref);

      yield* context.budget.remaining;

      if (
        step.state === "spooled" &&
        expected !== undefined &&
        JSON.stringify(checkpoint?.cursor ?? null) === expected.expected
      ) {
        return { state: "absent" };
      }

      return {
        reason:
          "An interrupted hook append may have committed before its checkpoint or receipt; the original commit delta is unavailable and will not be guessed.",
        state: "indeterminate",
      };
    }
  );

  return {
    authorize: (plan, input, context) =>
      plan.consent.scopeDigest === operationScopeDigest(plan)
        ? options
            .enrollment(
              enrollmentRequest(plan, input.consentReceiptIds),
              context
            )
            .pipe(Effect.map((consent) => consent.state === "authorized"))
        : Effect.succeed(false),
    descriptor: {
      authorization: "existing-enrollment",
      cancellation: "between-steps",
      effects: {
        destructive: false,
        networkDestinations: [],
        reads: [],
        writes: [options.env.storePath, spoolDirFor(options.env.storePath)],
      },
      enabled: true,
      idempotency: "durable-key",
      kind: "collect",
      reason:
        "Bounds count selected directory entry visits, captured source bytes, and top-level JSON records plus normalized observations; nested decoder attempts and physical control-store I/O are unavailable.",
      requiredInputs: [
        "source",
        "inputRefs",
        "selectedRoots",
        "parserVersion",
        "scope",
        "bounds",
      ],
      version: BOUNDED_CURSOR_HOOK_OPERATION_VERSION,
    },
    execute,
    meteredWork: true,
    prepare,
    probe,
    replay: "safe",
    steps: (plan) => [
      operationStep(stepId(plan), CURSOR_HOOK_OPERATION_SOURCE),
    ],
    validate,
  };
};
