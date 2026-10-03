// @effect-diagnostics-next-line nodeBuiltinImport:off -- Bounded captured OpenCode rows use a synchronous content digest.
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  writeFileSync,
  // @effect-diagnostics-next-line nodeBuiltinImport:off -- O_NOFOLLOW descriptor reads and fstat identities preserve the selected-source boundary that Effect FileSystem does not expose.
} from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The native descriptor identity proof uses the exact Stats shape returned by fstatSync.
import type { Stats } from "node:fs";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

import { NodeServices } from "@effect/platform-node";
import { Effect, Exit, FileSystem, Layer, Match, Path, Schema } from "effect";
import type { Scope } from "effect";

import { runHarnessRead } from "../cli/commands/collect.js";
import type { HarnessReadResult } from "../cli/commands/collect.js";
import type { DxCommandEnv } from "../cli/commands/context.js";
import type { AgentStoreFailure } from "../contracts/agent-store.js";
import { AgentError } from "../contracts/error-agent.js";
import { SourceUnavailable } from "../contracts/error-source-unavailable.js";
import type { Harness } from "../harness/contract.js";
import { GitRunner } from "../harness/git.js";
import { OpencodeHarness } from "../harness/opencode/harness.js";
import {
  BodyRowSchema,
  SCHEMA_SQL,
  SchemaRowSchema,
  readSql,
  tableColumns,
} from "../harness/opencode/sql.js";
import type {
  BodyRow,
  SchemaRow,
  TableColumns,
} from "../harness/opencode/sql.js";
import { OpencodeStore } from "../harness/opencode/store.js";
import type { AgentRef, AgentScope } from "../model/agent-common.js";
import type { OperationPlan, OperationStep } from "../model/agent-operation.js";
import type {
  HarnessCursorsApi,
  StoredCursor,
} from "../storage/harness-cursors.js";
import { spoolDirFor } from "../storage/store-path.js";
import type { OperationWorkBudget } from "./budget.js";
import type {
  CollectionEnrollmentRequest,
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

export const BOUNDED_OPENCODE_OPERATION_VERSION = "dx.bounded-opencode.v1";

export interface BoundedOpencodeOperationOptions {
  readonly env: DxCommandEnv;
  readonly cursors?: HarnessCursorsApi | null;
  readonly parserVersion?: string;
  readonly selected: (
    request: SelectedSourceRequest
  ) => Effect.Effect<readonly PlannedSourceSelection[], AgentStoreFailure>;
  readonly enrollment: (
    request: CollectionEnrollmentRequest,
    context: OperationWorkContext
  ) => Effect.Effect<
    Pick<OperationPlan["consent"], "state" | "reason" | "receiptIds">,
    AgentStoreFailure
  >;
}

interface SourceFile {
  readonly path: string;
  readonly identity: string;
  readonly size: number;
  readonly mtimeMs: number;
}

interface DatabaseSnapshot {
  readonly selection: PlannedSourceSelection;
  readonly files: readonly SourceFile[];
  readonly schemas: readonly SchemaRow[];
  readonly rows: readonly BodyRow[];
  readonly digest: string;
  readonly rejected: number;
}

const LIMITATION =
  "SQLite's physical read volume is unavailable. Byte allowance units reserve one bounded database, WAL and SHM source copy plus normalized payload bytes, and do not bound SQLite's internal physical I/O. Decoded records measure validated SQL rows; native parser decode volume is unavailable. Repository placement uses explicitly supplied recorded context without Git discovery.";

const TABLES = [
  "session_v2",
  "session",
  "session_message",
  "message",
  "part",
] as const;

const MeasureSchema = Schema.Struct({
  bytes: Schema.Finite,
  records: Schema.Finite,
});

const decodeMeasure = Schema.decodeUnknownSync(MeasureSchema);

const decodeSchemas = Schema.decodeUnknownSync(Schema.Array(SchemaRowSchema));

const decodeBodies = Schema.decodeUnknownSync(Schema.Array(BodyRowSchema));

const ContentSchema = Schema.Struct({
  digest: Schema.String,
  files: Schema.Array(
    Schema.Struct({
      identity: Schema.String,
      mtimeMs: Schema.Finite,
      path: Schema.String,
      size: Schema.Finite,
    })
  ),
});

const decodeContent = Schema.decodeUnknownSync(
  Schema.fromJsonString(ContentSchema)
);

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

const mapped = (cause: unknown): AgentStoreFailure =>
  Schema.is(AgentError)(cause)
    ? cause
    : failure(
        "source-unavailable",
        cause instanceof Error ? cause.message : String(cause)
      );

type DigestInput = string | readonly BodyRow[];

const digest = (value: DigestInput): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const sourceError = (message: string) =>
  new SourceUnavailable({ adapterId: "harness.opencode", message });

const decodeFailure = (error: { readonly message: string }) =>
  sourceError(error.message);

const identity = (info: Stats): string =>
  `${info.dev}:${info.ino}:${info.birthtimeMs}`;

const within = (root: string, selected: string, path: Path.Path): boolean =>
  selected === root || selected.startsWith(`${root}${path.sep}`);

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

const literal = (text: string): string => `'${text.replaceAll("'", "''")}'`;

const refStepId = (ref: AgentRef): string =>
  `opencode:${digest(JSON.stringify([ref.kind, ref.id, ref.storeId, ref.storeGeneration, ref.basisId, ref.version])).slice(0, 32)}`;

const stepId = (selection: PlannedSourceSelection): string =>
  refStepId(selection.inputRef);

const requestOf = (
  value: OperationPlan | OperationPlanInput
): SelectedSourceRequest => ({
  arguments: value.arguments,
  bounds: value.bounds,
  scope: value.scope,
  storeGeneration:
    "target" in value ? value.target.storeGeneration : value.storeGeneration,
  storeId: "target" in value ? value.target.storeId : value.storeId,
});

const enrollmentOf = (
  value: OperationPlan | OperationPlanInput,
  receiptIds: readonly string[]
): CollectionEnrollmentRequest => ({
  bounds: value.bounds,
  inputRefs:
    value.arguments.kind === "collect" ? value.arguments.inputRefs : [],
  receiptIds,
  scope: value.scope,
  selectedRoots:
    value.arguments.kind === "collect" ? value.arguments.selectedRoots : [],
  source: value.arguments.kind === "collect" ? value.arguments.source : "",
});

const statFiles = (
  selection: PlannedSourceSelection,
  path: Path.Path
): readonly SourceFile[] => {
  const { ref } = selection.planned;

  if (
    ref === null ||
    !path.isAbsolute(ref.path) ||
    ref.path !== path.resolve(ref.path) ||
    !within(selection.root, ref.path, path)
  ) {
    throw failure(
      "scope-denied",
      "The OpenCode database must be an exact absolute file within its explicitly selected root."
    );
  }

  if (
    realpathSync(selection.root) !== selection.root ||
    realpathSync(path.dirname(ref.path)) !== path.dirname(ref.path)
  ) {
    throw failure(
      "scope-denied",
      "The selected database root and parent must not contain symbolic links."
    );
  }

  return ["", "-wal", "-shm"].flatMap((suffix): readonly SourceFile[] => {
    const selected = `${ref.path}${suffix}`;
    let info: Stats;

    try {
      info = lstatSync(selected);
    } catch (error) {
      if (
        suffix !== "" &&
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return [];
      }

      throw error;
    }

    if (!info.isFile() || info.isSymbolicLink()) {
      throw failure(
        "scope-denied",
        "Selected OpenCode database files must be regular files without symbolic links."
      );
    }

    return [
      {
        identity: identity(info),
        mtimeMs: info.mtimeMs,
        path: selected,
        size: info.size,
      },
    ];
  });
};

const scopedSql = (
  tables: TableColumns,
  selection: PlannedSourceSelection
): string => {
  const { ref } = selection.planned;

  if (ref === null) {
    throw failure("scope-denied", "An OpenCode session reference is required.");
  }

  const folder = ref.worktree ?? selection.planned.context.worktreePath;

  if (ref.sessionId === null && folder === null) {
    throw failure(
      "scope-denied",
      "Select an exact OpenCode session or a tracked worktree before reading a database."
    );
  }

  const directoryWhere = `(directory = ${literal(folder ?? "")} OR substr(directory, 1, ${String((folder ?? "").length + 1)}) = ${literal(`${folder ?? ""}/`)})`;

  const sessionWhere =
    ref.sessionId === null
      ? directoryWhere
      : `(${directoryWhere}) AND id = ${literal(ref.sessionId)}`;

  const availableSessions = ["session_v2", "session"].filter(
    (table) =>
      tables.get(table)?.has("id") === true &&
      tables.get(table)?.has("directory") === true
  );

  if (availableSessions.length === 0) {
    throw failure(
      "source-unavailable",
      "The selected OpenCode database has no supported session table."
    );
  }

  const sessionIds = availableSessions
    .map((table) => `SELECT id FROM main.${quote(table)} WHERE ${sessionWhere}`)
    .join(" UNION ");

  const messageIds =
    tables.get("message")?.has("session_id") === true
      ? `SELECT id FROM main.message WHERE session_id IN (${sessionIds})`
      : "SELECT NULL WHERE 0";

  return TABLES.flatMap((table) => {
    if (!tables.has(table)) {
      return [];
    }

    let where = `session_id IN (${sessionIds})`;

    if (table === "session" || table === "session_v2") {
      where = sessionWhere;
    } else if (table === "part") {
      where = `message_id IN (${messageIds})`;
    }

    return [
      `${quote(table)} AS (SELECT * FROM main.${quote(table)} WHERE dft_budget() AND ${where})`,
    ];
  }).join(", ");
};

const copySelectedFiles = (
  files: readonly SourceFile[],
  directory: string,
  deadline: number,
  path: Path.Path
): string => {
  for (const file of files) {
    const descriptor = openSync(
      file.path,
      constants.O_RDONLY + constants.O_NOFOLLOW
    );

    try {
      const opened = fstatSync(descriptor);

      if (
        identity(opened) !== file.identity ||
        opened.size !== file.size ||
        opened.mtimeMs !== file.mtimeMs
      ) {
        throw failure(
          "plan-stale",
          "An OpenCode database file changed before its immutable copy was acquired."
        );
      }

      const bytes = new Uint8Array(file.size);
      let offset = 0;

      while (offset < bytes.byteLength) {
        if (performance.now() > deadline) {
          throw failure(
            "budget-exhausted",
            "The selected OpenCode source copy exceeded its reviewed elapsed allowance."
          );
        }

        const count = readSync(
          descriptor,
          bytes,
          offset,
          Math.min(65_536, bytes.byteLength - offset),
          offset
        );

        if (count === 0) {
          throw failure(
            "plan-stale",
            "An OpenCode database file truncated during bounded capture."
          );
        }

        offset += count;
      }

      const after = fstatSync(descriptor);

      if (after.size !== file.size || after.mtimeMs !== file.mtimeMs) {
        throw failure(
          "plan-stale",
          "An OpenCode database file changed during bounded capture."
        );
      }

      writeFileSync(path.join(directory, path.basename(file.path)), bytes, {
        flag: "wx",
        mode: 0o600,
      });
    } finally {
      closeSync(descriptor);
    }
  }

  const [database] = files;

  if (database === undefined) {
    throw failure(
      "source-unavailable",
      "The selected OpenCode database does not exist."
    );
  }

  return path.join(directory, path.basename(database.path));
};

const sourceFiles = Effect.fn("opencode.sourceFiles")(function* sourceFiles(
  selection: PlannedSourceSelection
) {
  const path = yield* Path.Path;

  return yield* Effect.try({
    catch: mapped,
    try: () => statFiles(selection, path),
  });
}, Effect.provide(NodeServices.layer));

const capture = Effect.fn("opencode.capture")(
  function* capture(
    selection: PlannedSourceSelection,
    context: OperationWorkContext
  ): Effect.fn.Return<
    DatabaseSnapshot,
    AgentStoreFailure,
    FileSystem.FileSystem | Path.Path | Scope.Scope
  > {
    const path = yield* Path.Path;

    const files = yield* Effect.try({
      catch: mapped,
      try: () => statFiles(selection, path),
    });

    const available = yield* context.budget.remaining;
    const physicalBytes = files.reduce((sum, file) => sum + file.size, 0);
    const allowance = physicalBytes;

    if (allowance > available.maxBytes || available.maxRecords < 1) {
      return yield* failure(
        "budget-exhausted",
        "The selected database file envelope exceeds the reviewed allowance before it can be opened."
      );
    }

    const usage = {
      byteUnits: available.maxBytes,
      bytesRead: null,
      filesRead: files.length,
      recordUnits: available.maxRecords,
      recordsDecoded: null,
      requests: 0,
      retries: 0,
    };

    const reserved = yield* context.budget.reserve(usage);
    const filesystem = yield* FileSystem.FileSystem;

    const directory = yield* filesystem
      .makeTempDirectoryScoped({ prefix: "dft-opencode-operation-" })
      .pipe(Effect.mapError((error) => mapped(error)));

    const capturedExit = yield* Effect.exit(
      Effect.try({
        catch: mapped,
        try: () => {
          const { ref } = selection.planned;

          if (ref === null) {
            throw failure(
              "scope-denied",
              "An OpenCode database reference is required."
            );
          }

          const deadline = performance.now() + available.maxElapsedMs;

          const immutablePath = copySelectedFiles(
            files,
            directory,
            deadline,
            path
          );

          if (
            JSON.stringify(statFiles(selection, path)) !== JSON.stringify(files)
          ) {
            throw failure(
              "plan-stale",
              "The OpenCode source changed while its immutable database copy was acquired."
            );
          }

          const db = new DatabaseSync(immutablePath, {
            readOnly: true,
            timeout: Math.max(1, Math.min(1000, available.maxElapsedMs)),
          });

          try {
            db.function("dft_budget", () => {
              if (performance.now() > deadline) {
                throw failure(
                  "budget-exhausted",
                  "The selected OpenCode SQL read exceeded its reviewed elapsed allowance."
                );
              }

              return 1;
            });

            db.exec("BEGIN");

            const schemaLimit = Math.min(128, available.maxRecords);

            const rawSchemas = db
              .prepare(
                `${SCHEMA_SQL} AND length(p.name) <= 128 LIMIT ${String(schemaLimit + 1)}`
              )
              .all();

            if (rawSchemas.length > schemaLimit) {
              throw failure(
                "budget-exhausted",
                "The OpenCode schema exceeds the reviewed metadata record allowance."
              );
            }

            const schemas = decodeSchemas(rawSchemas);

            if (
              schemas.length > Math.min(128, available.maxRecords) ||
              Buffer.byteLength(JSON.stringify(schemas)) > 16_384
            ) {
              throw failure(
                "budget-exhausted",
                "The OpenCode schema exceeds the bounded metadata allowance."
              );
            }

            const tables = tableColumns(schemas);
            const ctes = scopedSql(tables, selection);
            let rawRecords = 0;
            let rawBytes = 0;

            for (const table of TABLES.filter((item) => tables.has(item))) {
              const columns = [...(tables.get(table) ?? [])];

              const lengths =
                columns
                  .map(
                    (column) =>
                      `coalesce(length(CAST(${quote(column)} AS BLOB)), 0)`
                  )
                  .join(" + ") || "0";

              const measure = decodeMeasure(
                db
                  .prepare(
                    `WITH ${ctes} SELECT count(*) AS records, coalesce(sum(${lengths}), 0) AS bytes FROM ${quote(table)}`
                  )
                  .get()
              );

              rawRecords += measure.records;
              rawBytes += measure.bytes;

              if (
                rawRecords + schemas.length > available.maxRecords ||
                rawBytes > available.maxBytes - allowance
              ) {
                throw failure(
                  "budget-exhausted",
                  "Selected OpenCode rows exceed the reviewed record or decoded-byte limit before parsing."
                );
              }
            }

            const sql = readSql(tables);

            if (sql === null) {
              throw failure(
                "source-unavailable",
                "The selected OpenCode schema cannot be read by the installed parser."
              );
            }

            const boundedSql = `WITH ${ctes} ${sql}`;

            const measured = decodeMeasure(
              db
                .prepare(
                  `SELECT count(*) AS records, coalesce(sum(length(CAST(body AS BLOB))), 0) AS bytes FROM (${boundedSql})`
                )
                .get()
            );

            const recordUnits =
              schemas.length + rawRecords + measured.records * 2;

            if (
              recordUnits > available.maxRecords ||
              measured.bytes > available.maxBytes - allowance
            ) {
              throw failure(
                "budget-exhausted",
                "Normalized OpenCode rows exceed the reviewed record or decoded-byte limit before allocation."
              );
            }

            const rows = decodeBodies(
              db
                .prepare(
                  `SELECT kind, body FROM (${boundedSql}) ORDER BY kind, body LIMIT ${String(Math.min(available.maxRecords, 100_000))}`
                )
                .all()
            );

            if (
              JSON.stringify(statFiles(selection, path)) !==
              JSON.stringify(files)
            ) {
              throw failure(
                "plan-stale",
                "The OpenCode database changed during capture; replan its selected sessions."
              );
            }

            return {
              digest: digest(rows),
              files,
              measuredBytes: measured.bytes,
              recordUnits: recordUnits - measured.records,
              rejected: 0,
              rows,
              schemas,
              selection,
            };
          } finally {
            db.close();
          }
        },
      })
    );

    if (Exit.isFailure(capturedExit)) {
      yield* reserved.complete(usage);

      return yield* Effect.failCause(capturedExit.cause);
    }

    const captured = capturedExit.value;

    yield* reserved.complete({
      byteUnits: allowance + captured.measuredBytes,
      bytesRead: null,
      filesRead: files.length,
      recordUnits: captured.recordUnits,
      recordsDecoded: captured.schemas.length + captured.rows.length,
      requests: 0,
      retries: 0,
    });

    return captured;
  },
  Effect.scoped,
  Effect.provide(NodeServices.layer)
);

const makeSnapshotHarness = (
  snapshot: DatabaseSnapshot
): Effect.Effect<Harness, AgentStoreFailure> => {
  const { context } = snapshot.selection.planned;

  const store = OpencodeStore.of({
    listSessions: Effect.succeed([]),
    query: (_dbPath, sql, decoder) =>
      Schema.decodeEffect(Schema.Array(decoder))(
        sql === SCHEMA_SQL ? snapshot.schemas : snapshot.rows
      ).pipe(Effect.mapError(decodeFailure)),
    readBytes: () =>
      Effect.fail(
        sourceError("Captured OpenCode rows have no ambient file reader.")
      ),
    readText: () =>
      Effect.fail(
        sourceError("Captured OpenCode rows have no ambient text reader.")
      ),
    roots: Effect.succeed([snapshot.selection.root]),
    version: Effect.succeed(BOUNDED_OPENCODE_OPERATION_VERSION),
  });

  const repos =
    context.repoCommonDir === null || context.worktreePath === null
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

  return OpencodeHarness.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(OpencodeStore, store),
        GitRunner.memory(repos)
      )
    )
  );
};

const checkedScope = (
  scope: AgentScope,
  branch: string | null,
  flightId: string | null
): boolean => {
  if (
    scope.sources.length !== 1 ||
    scope.sources[0] !== "harness.opencode" ||
    scope.tools.some((tool) => tool !== "opencode")
  ) {
    return false;
  }

  if (scope.flightId !== null && scope.flightId !== flightId) {
    return false;
  }

  return Match.value(scope.branchSelection.kind).pipe(
    Match.when("all", () => scope.branchSelection.branches.length === 0),
    Match.when(
      "unresolved",
      () => branch === null && scope.branchSelection.branches.length === 0
    ),
    Match.when(
      "current",
      () =>
        branch !== null &&
        scope.branchSelection.branches.length === 1 &&
        scope.branchSelection.branches[0] === branch
    ),
    Match.when(
      "selected",
      () => branch !== null && scope.branchSelection.branches.includes(branch)
    ),
    Match.exhaustive
  );
};

const checkedSelection = (
  item: PlannedSourceSelection,
  request: SelectedSourceRequest
): boolean => {
  const { ref, context, source, unavailable } = item.planned;

  if (
    item.inputRef.storeId !== request.storeId ||
    item.inputRef.storeGeneration !== request.storeGeneration ||
    ref === null
  ) {
    return false;
  }

  if (
    ref.harness !== "opencode" ||
    ref.channel !== "local-db" ||
    source !== "harness.opencode" ||
    unavailable !== null
  ) {
    return false;
  }

  return (
    context.repoCommonDir !== null &&
    context.worktreePath !== null &&
    ref.worktree === context.worktreePath &&
    request.scope.repoId === context.repoCommonDir &&
    request.scope.worktreeId === context.worktreePath &&
    checkedScope(request.scope, context.branch, context.flightId)
  );
};

const resultStep = (
  step: OperationStep,
  result: HarnessReadResult,
  safeCursor: string | null,
  checkpointGap: string | null
): OperationStep => {
  const gaps = [
    ...result.coverage.gaps.map((gap) => `${gap.code}: ${gap.message}`),
    LIMITATION,
    "Rejected source-row count is unavailable because the native parser does not expose it.",
  ];

  if (checkpointGap !== null) {
    gaps.push(checkpointGap);
  }

  let state: OperationStep["state"] = "committed";

  if (result.spooledTo !== null) {
    state = "spooled";
  } else if (checkpointGap !== null) {
    state = "partial";
  } else if (result.events === 0) {
    state = "unchanged";
  } else if (result.inserted === 0 && result.duplicates === result.events) {
    state = "already-applied";
  }

  return {
    ...step,
    committedThrough: result.spooledTo === null ? result.lastEventId : null,
    duplicates: result.duplicates,
    gaps: gaps.map((gap) => gap.slice(0, 4096)).slice(0, 64),
    inserted: result.inserted,
    rejected: null,
    remainingWork:
      state === "spooled"
        ? "Import the staged selected batch before advancing this source checkpoint."
        : "Replan the selected database for later rows and unresolved source gaps.",
    safeCursor,
    spooledRefs: result.spooledTo === null ? [] : [result.spooledTo],
    state,
  };
};

const storedCursorText = (previous: StoredCursor | null): string | null =>
  previous?.cursor === null || previous?.cursor === undefined
    ? null
    : JSON.stringify(previous.cursor);

const checkpointResult = Effect.fn("opencode.checkpointResult")(
  function* checkpointResult(
    checkpoint: HarnessCursorsApi | null | undefined,
    previous: StoredCursor | null,
    snapshot: DatabaseSnapshot,
    result: HarnessReadResult
  ) {
    if (
      checkpoint === null ||
      checkpoint === undefined ||
      result.spooledTo !== null ||
      snapshot.selection.planned.ref === null
    ) {
      return { gap: null, safeCursor: storedCursorText(previous) };
    }

    const { ref } = snapshot.selection.planned;
    const current = yield* checkpoint.get(ref);

    const files = yield* sourceFiles(snapshot.selection);

    if (
      JSON.stringify(current) !== JSON.stringify(previous) ||
      JSON.stringify(files) !== JSON.stringify(snapshot.files)
    ) {
      return {
        gap: "OpenCode changed after acquisition; the previous checkpoint was retained.",
        safeCursor: storedCursorText(previous),
      };
    }

    const next = {
      cursor: result.cursor,
      lastEventId: result.lastEventId ?? previous?.lastEventId ?? null,
      mtimeMs: result.unsettled
        ? null
        : Math.max(...files.map((file) => file.mtimeMs)),
      size: result.unsettled
        ? null
        : files.reduce((sum, file) => sum + file.size, 0),
    };

    if (checkpoint.putIfCurrent === undefined) {
      return {
        gap: "Atomic OpenCode checkpoint comparison is unavailable; the previous checkpoint was retained.",
        safeCursor: storedCursorText(previous),
      };
    }

    if (!(yield* checkpoint.putIfCurrent(ref, previous, next))) {
      return {
        gap: "Another operation advanced the OpenCode checkpoint; the previous checkpoint was retained.",
        safeCursor: storedCursorText(previous),
      };
    }

    return {
      gap: null,
      safeCursor: result.cursor === null ? null : JSON.stringify(result.cursor),
    };
  }
);

const checkpointFailure = (error: AgentStoreFailure) =>
  Effect.succeed({ gap: error.message, safeCursor: null });

const validationFailure = (error: AgentStoreFailure) =>
  Effect.succeed([error.message]);

export const makeBoundedOpencodeOperationAdapter = (
  options: BoundedOpencodeOperationOptions
): OperationAdapter => {
  const retained = new WeakMap<
    OperationWorkBudget,
    Map<string, readonly DatabaseSnapshot[]>
  >();

  const snapshots = (budget: OperationWorkBudget) => {
    const values =
      retained.get(budget) ?? new Map<string, readonly DatabaseSnapshot[]>();

    retained.set(budget, values);

    return values;
  };

  const parserVersion =
    options.parserVersion ?? BOUNDED_OPENCODE_OPERATION_VERSION;

  const select = Effect.fn("opencode.select")(function* select(
    value: OperationPlan | OperationPlanInput
  ) {
    const path = yield* Path.Path;

    if (
      value.arguments.kind !== "collect" ||
      value.arguments.source !== "harness.opencode" ||
      value.arguments.parserVersion !== parserVersion
    ) {
      return yield* failure(
        "invalid-selector",
        "Select harness.opencode with the installed bounded OpenCode parser version."
      );
    }

    const selected = yield* options.selected(requestOf(value));

    if (
      selected.length === 0 ||
      selected.length !== value.arguments.inputRefs.length ||
      selected.length > 80
    ) {
      return yield* failure(
        "scope-denied",
        "Each explicitly selected OpenCode input must resolve to one bounded database session reference."
      );
    }

    if (
      !sameOperationAgentRefs(
        value.arguments.inputRefs,
        selected.map((item) => item.inputRef)
      )
    ) {
      return yield* failure(
        "scope-denied",
        "The selected OpenCode references must exactly match the reviewed semantic input identities."
      );
    }

    const roots = new Set(value.arguments.selectedRoots);

    for (const item of selected) {
      if (
        !roots.has(item.root) ||
        !path.isAbsolute(item.root) ||
        item.root !== path.resolve(item.root) ||
        !checkedSelection(item, requestOf(value))
      ) {
        return yield* failure(
          "scope-denied",
          "OpenCode selection must match the enrolled tracked repository, exact selected roots and local database references."
        );
      }
    }

    if (
      [...roots].some((root) => !selected.some((item) => item.root === root))
    ) {
      return yield* failure(
        "scope-denied",
        "Every selected root must contain an explicitly selected OpenCode input."
      );
    }

    return selected;
  }, Effect.provide(NodeServices.layer));

  const cursorOf = (selection: PlannedSourceSelection) =>
    options.cursors === null ||
    options.cursors === undefined ||
    selection.planned.ref === null
      ? Effect.succeed("null")
      : options.cursors
          .get(selection.planned.ref)
          .pipe(Effect.map((stored) => JSON.stringify(stored?.cursor ?? null)));

  const validate = Effect.fn("opencode.validate")(
    function* validate(plan: OperationPlan, context: OperationWorkContext) {
      const consent = yield* options.enrollment(
        enrollmentOf(plan, plan.consent.receiptIds),
        context
      );

      if (consent.state !== "authorized") {
        return [
          consent.reason ??
            "The selected OpenCode source is no longer enrolled.",
        ];
      }

      const selected = yield* select(plan);

      if (
        !plan.preconditions.some(
          (entry) =>
            entry.kind === "parser-version" && entry.expected === parserVersion
        )
      ) {
        return ["The bounded OpenCode parser version changed."];
      }

      for (const item of selected) {
        const cursor = plan.preconditions.find(
          (entry) =>
            entry.kind === "source-cursor" && entry.target === item.inputRef.id
        );

        const currentCursor = yield* cursorOf(item);

        if (cursor?.expected !== currentCursor) {
          return [
            "The selected OpenCode checkpoint changed without durable reviewed progress.",
          ];
        }
      }

      if (!snapshots(context.budget).has(plan.planDigest)) {
        const captured: DatabaseSnapshot[] = [];

        for (const item of selected) {
          const current = yield* capture(item, context);

          const expected = plan.preconditions.find(
            (entry) =>
              entry.kind === "source-content" &&
              entry.target === item.inputRef.id
          );

          const previous =
            expected === undefined ? null : decodeContent(expected.expected);

          if (
            previous === null ||
            previous.digest !== current.digest ||
            previous.files.some(
              (file) =>
                !current.files.some(
                  (fresh) =>
                    fresh.path === file.path &&
                    fresh.identity === file.identity &&
                    fresh.size >= file.size
                )
            ) ||
            (plan.arguments.kind === "collect" &&
              !plan.arguments.allowSourceGrowth &&
              JSON.stringify(previous.files) !== JSON.stringify(current.files))
          ) {
            return [
              "The selected OpenCode rows, file identity or approved growth assumptions changed.",
            ];
          }

          captured.push(current);
        }

        snapshots(context.budget).set(plan.planDigest, captured);
      }

      return [];
    },
    Effect.matchEffect({
      onFailure: validationFailure,
      onSuccess: Effect.succeed,
    })
  );

  return {
    authorize: Effect.fn("opencode.authorize")(
      function* authorize(plan, input, context) {
        if (plan.consent.scopeDigest !== operationScopeDigest(plan)) {
          return false;
        }

        const consent = yield* options.enrollment(
          enrollmentOf(plan, input.consentReceiptIds),
          context
        );

        return (
          consent.state === "authorized" &&
          plan.consent.receiptIds.every((id) => consent.receiptIds.includes(id))
        );
      }
    ),
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
      reason: LIMITATION,
      requiredInputs: [
        "Exact local OpenCode database references and selected roots",
        "Tracked repository enrollment",
        "Reviewed file, byte, record and elapsed bounds",
      ],
      version: parserVersion,
    },
    execute: Effect.fn("opencode.execute")(
      function* execute(
        plan,
        step,
        context
      ): Effect.fn.Return<OperationEffectResult, AgentStoreFailure> {
        const problems = yield* validate(plan, context);

        if (problems.length > 0) {
          return yield* failure("plan-stale", problems.join(" "));
        }

        const snapshot = snapshots(context.budget)
          .get(plan.planDigest)
          ?.find((item) => stepId(item.selection) === step.id);

        if (snapshot === undefined) {
          return yield* failure(
            "scope-denied",
            "The OpenCode step is outside the selected database snapshot."
          );
        }

        const { ref } = snapshot.selection.planned;

        if (ref === null) {
          return yield* failure(
            "scope-denied",
            "An OpenCode reference is required."
          );
        }

        const actualFiles = yield* sourceFiles(snapshot.selection);

        if (JSON.stringify(actualFiles) !== JSON.stringify(snapshot.files)) {
          return yield* failure(
            "plan-stale",
            "The OpenCode source changed before the captured observations were committed."
          );
        }

        const harness = yield* makeSnapshotHarness(snapshot);

        const checkpoint =
          options.cursors === null || options.cursors === undefined
            ? null
            : yield* options.cursors.get(ref);

        const expected = plan.preconditions.find(
          (entry) =>
            entry.kind === "source-cursor" &&
            entry.target === snapshot.selection.inputRef.id
        );

        const checkpointValue = JSON.stringify(checkpoint?.cursor ?? null);

        if (
          expected?.expected !== checkpointValue &&
          step.safeCursor !== checkpointValue
        ) {
          return yield* failure(
            "cursor-mismatch",
            "The OpenCode checkpoint changed after plan validation without this step's durable progress."
          );
        }

        const batch = yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* parseRows() {
            const usage = {
              bytesRead: 0,
              filesRead: 0,
              recordUnits: snapshot.rows.length,
              recordsDecoded: null,
              requests: 0,
              retries: 0,
            };

            const reserved = yield* context.budget.reserve(usage);

            const decoded = yield* Effect.exit(
              restore(
                harness.read(
                  {
                    ...ref,
                    mtimeMs: Math.max(
                      ...snapshot.files.map((file) => file.mtimeMs)
                    ),
                    size: snapshot.files.reduce(
                      (sum, file) => sum + file.size,
                      0
                    ),
                  },
                  {
                    context: snapshot.selection.planned.context,
                    cursor: checkpoint?.cursor ?? null,
                    origin: "imported",
                  }
                )
              )
            );

            yield* reserved.complete(usage);

            return Exit.isSuccess(decoded)
              ? decoded.value
              : yield* Effect.failCause(decoded.cause);
          })
        ).pipe(Effect.mapError((error) => mapped(error)));

        const remaining = yield* context.budget.remaining;

        if (batch.events.length > remaining.maxRecords) {
          return yield* failure(
            "budget-exhausted",
            "Normalized OpenCode observations exceed the remaining cumulative record allowance before append."
          );
        }

        yield* context.budget.charge({
          bytesRead: 0,
          filesRead: 0,
          recordUnits: batch.events.length,
          recordsDecoded: 0,
          requests: 0,
          retries: 0,
        });

        const capturedHarness: Harness = {
          ...harness,
          read: () => Effect.succeed(batch),
        };

        const result = yield* runHarnessRead(options.env, {
          context: snapshot.selection.planned.context,
          cursor: checkpoint?.cursor ?? null,
          harness: capturedHarness,
          ref,
        }).pipe(Effect.mapError(mapped));

        const checkpointState = yield* checkpointResult(
          options.cursors,
          checkpoint,
          snapshot,
          result
        ).pipe(Effect.catch(checkpointFailure));

        return {
          resources: yield* context.budget.measurements,
          step: resultStep(
            step,
            result,
            checkpointState.safeCursor,
            checkpointState.gap
          ),
        };
      }
    ),
    meteredWork: true,
    prepare: Effect.fn("opencode.prepare")(
      function* prepare(
        input,
        context
      ): Effect.fn.Return<OperationPreparation, AgentStoreFailure> {
        const selected = yield* select(input);

        const consent = yield* options.enrollment(
          enrollmentOf(input, []),
          context
        );

        if (consent.state !== "authorized") {
          return yield* failure(
            "authorization-required",
            consent.reason ??
              "OpenCode enrollment is required before reading database content."
          );
        }

        const captured: DatabaseSnapshot[] = [];
        const preconditions: OperationPlan["preconditions"][number][] = [];

        for (const item of selected) {
          const current = yield* capture(item, context);
          const cursor = yield* cursorOf(item);

          if (
            input.arguments.kind === "collect" &&
            input.arguments.cursor !== null &&
            (selected.length !== 1 || input.arguments.cursor !== cursor)
          ) {
            return yield* failure(
              "cursor-mismatch",
              "The explicit OpenCode cursor must match its retained checkpoint."
            );
          }

          captured.push(current);
          preconditions.push(
            {
              allowAppend:
                input.arguments.kind === "collect" &&
                input.arguments.allowSourceGrowth,
              expected: JSON.stringify({
                digest: current.digest,
                files: current.files,
              }),
              kind: "source-content",
              target: item.inputRef.id,
            },
            {
              allowAppend: false,
              expected: cursor,
              kind: "source-cursor",
              target: item.inputRef.id,
            }
          );
        }

        return {
          arguments: input.arguments,
          consent: { ...consent, scopeDigest: "pending" },
          effects: {
            destructive: false,
            networkDestinations: [],
            reads: [
              ...new Set(
                captured.flatMap((item) => item.files.map((file) => file.path))
              ),
            ],
            writes: [options.env.storePath, spoolDirFor(options.env.storePath)],
          },
          expectedEvidenceImprovement:
            "Import native OpenCode observations from bounded explicitly selected database rows.",
          forecast: { bytes: null, cost: null, elapsedMs: null, requests: 0 },
          preconditions: [
            ...preconditions,
            {
              allowAppend: false,
              expected: parserVersion,
              kind: "parser-version",
              target: "harness.opencode",
            },
          ],
          resumeBoundary: "complete-record",
          stopCondition:
            "Stop after selected session rows or before a reviewed logical copy, payload, record or elapsed allowance is exceeded. SQLite internal physical I/O remains unmeasured and is outside those logical byte limits.",
        };
      }
    ),
    probe: Effect.fn("opencode.probe")(
      function* probe(
        plan,
        step,
        receipt,
        context
      ): Effect.fn.Return<OperationProbe, AgentStoreFailure> {
        const consent = yield* options.enrollment(
          enrollmentOf(plan, plan.consent.receiptIds),
          context
        );

        if (consent.state !== "authorized") {
          return {
            reason:
              "The selected OpenCode enrollment is unavailable for recovery verification.",
            state: "indeterminate",
          };
        }

        const selected = yield* select(plan);
        const selection = selected.find((item) => stepId(item) === step.id);

        if (selection === undefined) {
          return {
            reason:
              "The recovery step does not match an explicitly selected OpenCode input.",
            state: "indeterminate",
          };
        }

        const currentCursor = yield* cursorOf(selection);
        const previous = receipt.steps.find((entry) => entry.id === step.id);

        const expected = plan.preconditions.find(
          (entry) =>
            entry.kind === "source-cursor" &&
            entry.target === selection.inputRef.id
        );

        if (
          previous?.safeCursor !== null &&
          previous?.safeCursor !== undefined &&
          previous.safeCursor === currentCursor &&
          previous.committedThrough !== null
        ) {
          return {
            result: {
              step: { ...previous, remainingWork: null, state: "committed" },
            },
            state: "complete",
          };
        }

        if (
          currentCursor !== expected?.expected ||
          previous?.state === "running" ||
          previous?.state === "indeterminate"
        ) {
          return {
            reason:
              "The prior OpenCode append or checkpoint may have committed without a durable step receipt; its effect attribution remains indeterminate.",
            state: "indeterminate",
          };
        }

        return { state: "absent" };
      }
    ),
    replay: "safe",
    steps: (plan) =>
      plan.arguments.kind === "collect"
        ? plan.arguments.inputRefs.map((ref) =>
            operationStep(refStepId(ref), "harness.opencode")
          )
        : [],
    validate,
  };
};
