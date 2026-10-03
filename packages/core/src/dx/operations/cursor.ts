// @effect-diagnostics-next-line nodeBuiltinImport:off -- Captured Cursor inputs use synchronous content digests.
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
  writeFileSync,
  // @effect-diagnostics-next-line nodeBuiltinImport:off -- Nofollow descriptor capture and fstat identity checks have no Effect FileSystem equivalent.
} from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native descriptor metadata uses the matching Node Stats type.
import type { Stats } from "node:fs";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

import { NodeServices } from "@effect/platform-node";
import {
  DateTime,
  Effect,
  Exit,
  FileSystem,
  Match,
  Option,
  Path,
  Schema,
} from "effect";
import type { Scope } from "effect";

import { runHarnessRead } from "../cli/commands/collect.js";
import type { HarnessReadResult } from "../cli/commands/collect.js";
import type { DxCommandEnv } from "../cli/commands/context.js";
import { decodeChatStore } from "../collectors/cursor-chats-store/decode.js";
import type { ChatStoreRows } from "../collectors/cursor-chats-store/decode.js";
import {
  chatInScope,
  mapChatModel,
} from "../collectors/cursor-chats-store/map.js";
import { CURSOR_CLI_SOURCE } from "../collectors/cursor-chats-store/sources.js";
import {
  CURSOR_CLI_ADAPTER_ID,
  CURSOR_CLI_ADAPTER_VERSION,
  parseCursorCliOutput,
} from "../collectors/cursor-cli/collector.js";
import { CURSOR_LOCAL_DB_ADAPTER_ID } from "../collectors/cursor-local-db/descriptor.js";
import { mapAiTracking } from "../collectors/cursor-local-db/map-ai-tracking.js";
import type { MapContext } from "../collectors/cursor-local-db/map-state.js";
import { mapStateDb } from "../collectors/cursor-local-db/map-state.js";
import {
  CodeHashRowSchema,
  HeaderRowSchema,
  KeyValueRowSchema,
  ScoredCommitRowSchema,
  TableNameRowSchema,
  decodeComposerJson,
} from "../collectors/cursor-local-db/schemas.js";
import {
  normalizePath,
  ownsPath,
  scopeFor,
} from "../collectors/cursor-local-db/scope.js";
import type { WorktreeScope } from "../collectors/cursor-local-db/scope.js";
import type { LocalDbRows } from "../collectors/cursor-local-db/snapshot.js";
import type { AgentStoreFailure } from "../contracts/agent-store.js";
import { AgentError } from "../contracts/error-agent.js";
import type { Harness } from "../harness/contract.js";
import type { OperationPlan, OperationStep } from "../model/agent-operation.js";
import type { EventBatch } from "../model/event.js";
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
  OperationWorkContext,
} from "./ports.js";

export const BOUNDED_CURSOR_OPERATION_VERSION = "dx.bounded-cursor.v1";

export const BOUNDED_CURSOR_OPERATION_SOURCES: readonly string[] = [
  CURSOR_LOCAL_DB_ADAPTER_ID,
  CURSOR_CLI_SOURCE,
];

export interface BoundedCursorOperationOptions {
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
  readonly worktreeRoots?: (
    worktree: string,
    context: OperationWorkContext
  ) => Effect.Effect<readonly string[], AgentStoreFailure>;
  readonly knownCommits?: (
    worktree: string,
    shas: readonly string[],
    context: OperationWorkContext
  ) => Effect.Effect<ReadonlySet<string>, AgentStoreFailure>;
}

interface SourceFile {
  readonly path: string;
  readonly identity: string;
  readonly size: number;
  readonly mtimeMs: number;
}

interface CaptureTally {
  bytes: number;
  records: number;
  files: number;
}

type CapturedInput =
  | {
      readonly kind: "local";
      readonly source: string;
      readonly rows: LocalDbRows;
      readonly folders: ReadonlyMap<string, string | null>;
    }
  | {
      readonly kind: "chat";
      readonly source: string;
      readonly rows: ChatStoreRows;
      readonly cwd: string | null;
    }
  | {
      readonly kind: "output";
      readonly source: string;
      readonly text: string;
      readonly frames: number;
    };

interface CursorSnapshot {
  readonly path: Path.Path;
  readonly absent: readonly string[];
  readonly selection: PlannedSourceSelection;
  readonly inputs: readonly CapturedInput[];
  readonly files: readonly SourceFile[];
  readonly directories: readonly SourceFile[];
  readonly digest: string;
}

const LIMITATION =
  "File allowance units count selected files and visited directory entries. Byte allowance units count captured native file bytes and selected SQL values. SQLite and Git physical internal I/O is unavailable and is outside these logical limits. Source content changes require a new reviewed plan. Record allowance units count selected SQL rows, output frames and normalized observations; native nested JSON and protobuf decode attempts are unavailable. Repository placement uses bounded repository worktree metadata. Observed symlinks and rotation are rejected; Node on macOS cannot exclude every adversarial ancestor replacement race.";

const MetaFileSchema = Schema.Struct({
  cwd: Schema.optional(Schema.NullOr(Schema.String)),
  folder: Schema.optional(Schema.String),
});

const decodeMetaFile = Schema.decodeUnknownOption(
  Schema.fromJsonString(MetaFileSchema)
);

const WorkspaceIdSchema = Schema.Struct({ id: Schema.String });

const decodeWorkspaceId = Schema.decodeUnknownOption(WorkspaceIdSchema);

const ChatBlobSchema = Schema.Struct({
  data: Schema.Uint8Array,
  id: Schema.String,
});

const MeasureSchema = Schema.Struct({
  bytes: Schema.Finite,
  records: Schema.Finite,
});

const decodeMeasure = Schema.decodeUnknownSync(MeasureSchema);

const ContentSchema = Schema.Struct({
  digest: Schema.String,
  metadataDigest: Schema.String,
});

const decodeContent = Schema.decodeUnknownOption(
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

const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const identity = (info: Stats): string =>
  `${info.dev}:${info.ino}:${info.birthtimeMs}`;

const metadata = (selected: string, info: Stats): SourceFile => ({
  identity: identity(info),
  mtimeMs: info.mtimeMs,
  path: selected,
  size: info.size,
});

const stepId = (selection: PlannedSourceSelection): string =>
  `cursor:${digest(selection.inputRef.id).slice(0, 32)}`;

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

const checkedReference = (
  item: PlannedSourceSelection,
  request: SelectedSourceRequest
): boolean => {
  const { ref, source } = item.planned;

  return (
    ref !== null &&
    item.inputRef.id === ref.path &&
    ref.harness === "cursor" &&
    ref.source === source &&
    item.planned.harness === "cursor" &&
    item.planned.input === ref.path &&
    ref.channel === "local-db" &&
    source ===
      (request.arguments.kind === "collect" ? request.arguments.source : "") &&
    item.planned.unavailable === null &&
    item.inputRef.storeId === request.storeId &&
    item.inputRef.storeGeneration === request.storeGeneration
  );
};

const checkedSelection = (
  item: PlannedSourceSelection,
  request: SelectedSourceRequest
): boolean => {
  const { ref, context, source } = item.planned;

  return (
    checkedReference(item, request) &&
    request.scope.repoId !== null &&
    request.scope.repoId === context.repoCommonDir &&
    request.scope.worktreeId !== null &&
    request.scope.worktreeId === context.worktreePath &&
    ref?.worktree === context.worktreePath &&
    request.scope.sources.length === 1 &&
    request.scope.sources[0] === source &&
    request.scope.tools.every((tool) => tool === "cursor") &&
    request.scope.flightId === null &&
    (request.scope.branchSelection.kind === "all" ||
      request.scope.branchSelection.kind === "unresolved") &&
    request.scope.branchSelection.branches.length === 0
  );
};

const statSelected = (
  path: Path.Path,
  selected: string,
  directory = false
): SourceFile => {
  if (
    !path.isAbsolute(selected) ||
    selected !== path.resolve(selected) ||
    realpathSync(path.dirname(selected)) !== path.dirname(selected)
  ) {
    throw failure(
      "scope-denied",
      "Selected Cursor paths must be canonical absolute paths without symbolic-link parents."
    );
  }

  const info = lstatSync(selected);

  if (
    info.isSymbolicLink() ||
    (directory ? !info.isDirectory() : !info.isFile())
  ) {
    throw failure(
      "scope-denied",
      "Selected Cursor paths must be regular files or explicitly selected directories without symbolic links."
    );
  }

  return metadata(selected, info);
};

const optionalFile = (path: Path.Path, selected: string): SourceFile | null => {
  try {
    return statSelected(path, selected);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
};

const checkTally = (
  tally: CaptureTally,
  available: {
    readonly maxFiles: number;
    readonly maxBytes: number;
    readonly maxRecords: number;
  }
): void => {
  if (
    tally.files > available.maxFiles ||
    tally.bytes > available.maxBytes ||
    tally.records > available.maxRecords
  ) {
    throw failure(
      "budget-exhausted",
      "The selected Cursor capture exceeds the remaining cumulative file, byte or record allowance before allocation."
    );
  }
};

const readCaptured = (
  file: SourceFile,
  tally: CaptureTally,
  available: {
    readonly maxFiles: number;
    readonly maxBytes: number;
    readonly maxRecords: number;
  },
  deadline: number
): Uint8Array => {
  tally.files += 1;
  tally.bytes += file.size;
  checkTally(tally, available);

  const descriptor = openSync(
    file.path,
    constants.O_RDONLY + constants.O_NOFOLLOW
  );

  try {
    if (
      JSON.stringify(metadata(file.path, fstatSync(descriptor))) !==
      JSON.stringify(file)
    ) {
      throw failure(
        "plan-stale",
        "A selected Cursor file changed before bounded capture."
      );
    }

    const bytes = new Uint8Array(file.size);
    let offset = 0;

    while (offset < bytes.length) {
      if (performance.now() >= deadline) {
        throw failure(
          "budget-exhausted",
          "Cursor file acquisition exceeded its elapsed allowance."
        );
      }

      const count = readSync(
        descriptor,
        bytes,
        offset,
        Math.min(65_536, bytes.length - offset),
        offset
      );

      if (count === 0) {
        throw failure(
          "plan-stale",
          "A selected Cursor file truncated during bounded capture."
        );
      }

      offset += count;
    }

    if (
      JSON.stringify(metadata(file.path, fstatSync(descriptor))) !==
      JSON.stringify(file)
    ) {
      throw failure(
        "plan-stale",
        "A selected Cursor file changed during bounded capture."
      );
    }

    return bytes;
  } finally {
    closeSync(descriptor);
  }
};

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

const selectRows = <A>(
  db: DatabaseSync,
  sql: string,
  columns: readonly string[],
  codec: Schema.Codec<A>,
  tally: CaptureTally,
  available: {
    readonly maxFiles: number;
    readonly maxBytes: number;
    readonly maxRecords: number;
  }
): readonly A[] => {
  const lengths =
    columns
      .map((column) => `coalesce(length(CAST(${quote(column)} AS BLOB)), 0)`)
      .join(" + ") || "0";

  const measure = decodeMeasure(
    db
      .prepare(
        `SELECT count(*) AS records, coalesce(sum(${lengths}), 0) AS bytes FROM (${sql}) WHERE dft_budget()`
      )
      .get()
  );

  tally.records += 1 + measure.records;
  tally.bytes += measure.bytes;
  checkTally(tally, available);

  return Schema.decodeUnknownSync(Schema.Array(codec))(
    db.prepare(`${sql} LIMIT ${String(available.maxRecords)}`).all()
  );
};

const localRows = (
  db: DatabaseSync,
  tally: CaptureTally,
  available: {
    readonly maxFiles: number;
    readonly maxBytes: number;
    readonly maxRecords: number;
  }
): LocalDbRows => {
  const tables = new Set(
    selectRows(
      db,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND dft_budget()",
      ["name"],
      TableNameRowSchema,
      tally,
      available
    ).map((row) => row.name)
  );

  if (tables.has("ai_code_hashes") && tables.has("scored_commits")) {
    return {
      codeHashes: selectRows(
        db,
        "SELECT hash, source, fileExtension, fileName, requestId, conversationId, timestamp, model, createdAt FROM ai_code_hashes WHERE dft_budget()",
        [
          "hash",
          "source",
          "fileExtension",
          "fileName",
          "requestId",
          "conversationId",
          "timestamp",
          "model",
          "createdAt",
        ],
        CodeHashRowSchema,
        tally,
        available
      ),
      layout: "ai-tracking",
      scoredCommits: selectRows(
        db,
        "SELECT commitHash, branchName, scoredAt, linesAdded, linesDeleted, tabLinesAdded, tabLinesDeleted, composerLinesAdded, composerLinesDeleted, humanLinesAdded, humanLinesDeleted, commitDate FROM scored_commits WHERE dft_budget()",
        [
          "commitHash",
          "branchName",
          "scoredAt",
          "linesAdded",
          "linesDeleted",
          "tabLinesAdded",
          "tabLinesDeleted",
          "composerLinesAdded",
          "composerLinesDeleted",
          "humanLinesAdded",
          "humanLinesDeleted",
          "commitDate",
        ],
        ScoredCommitRowSchema,
        tally,
        available
      ),
    };
  }

  if (!tables.has("ItemTable") || !tables.has("cursorDiskKV")) {
    throw failure(
      "source-unavailable",
      "The selected Cursor local database has no recognized native schema."
    );
  }

  const hasHeaders = tables.has("composerHeaders");

  return {
    headers: hasHeaders
      ? selectRows(
          db,
          "SELECT composerId, workspaceId, isSubagent, value FROM composerHeaders WHERE dft_budget()",
          ["composerId", "workspaceId", "isSubagent", "value"],
          HeaderRowSchema,
          tally,
          available
        )
      : [],
    items: selectRows(
      db,
      "SELECT key, CAST(value AS TEXT) AS value FROM ItemTable WHERE key = 'composer.composerData' AND dft_budget()",
      ["key", "value"],
      KeyValueRowSchema,
      tally,
      available
    ),
    kv: selectRows(
      db,
      "SELECT key, CAST(value AS TEXT) AS value FROM cursorDiskKV WHERE (key LIKE 'composerData:%' OR key LIKE 'bubbleId:%') AND dft_budget()",
      ["key", "value"],
      KeyValueRowSchema,
      tally,
      available
    ),
    layout: hasHeaders
      ? "state-vscdb/composer-headers"
      : "state-vscdb/itemtable",
  };
};

const chatRows = (
  db: DatabaseSync,
  tally: CaptureTally,
  available: {
    readonly maxFiles: number;
    readonly maxBytes: number;
    readonly maxRecords: number;
  }
): ChatStoreRows => {
  const meta = selectRows(
    db,
    "SELECT key, CAST(value AS TEXT) AS value FROM meta WHERE dft_budget()",
    ["key", "value"],
    KeyValueRowSchema,
    tally,
    available
  );

  const blobs = selectRows(
    db,
    "SELECT id, data FROM blobs WHERE data IS NOT NULL AND dft_budget()",
    ["id", "data"],
    ChatBlobSchema,
    tally,
    available
  );

  return {
    blobs: new Map(blobs.map((row) => [row.id, row.data])),
    meta: new Map(
      meta.flatMap((row) =>
        row.value === null ? [] : [[row.key, row.value] as const]
      )
    ),
  };
};

const serializedInput = (input: CapturedInput): string =>
  Match.value(input).pipe(
    Match.when({ kind: "chat" }, (value) =>
      JSON.stringify({
        ...value,
        rows: {
          blobs: [...value.rows.blobs].map(([id, bytes]) => [
            id,
            Buffer.from(bytes).toString("base64"),
          ]),
          meta: [...value.rows.meta],
        },
      })
    ),
    Match.when({ kind: "local" }, (value) =>
      JSON.stringify({ ...value, folders: [...value.folders] })
    ),
    Match.when({ kind: "output" }, JSON.stringify),
    Match.exhaustive
  );

const inputDigest = (inputs: readonly CapturedInput[]): string =>
  digest(JSON.stringify(inputs.map(serializedInput)));

interface CaptureBoundary {
  readonly path: Path.Path;
  readonly available: {
    readonly maxFiles: number;
    readonly maxBytes: number;
    readonly maxRecords: number;
    readonly maxElapsedMs: number;
  };
  readonly tally: CaptureTally;
  readonly files: SourceFile[];
  readonly directories: SourceFile[];
  readonly absent: string[];
  readonly root: string;
  readonly deadline: number;
}

const rememberDirectory = (
  selected: string,
  boundary: CaptureBoundary
): void => {
  if (boundary.directories.some((folder) => folder.path === selected)) {
    return;
  }

  boundary.tally.files += 1;
  checkTally(boundary.tally, boundary.available);
  boundary.directories.push(statSelected(boundary.path, selected, true));
};

const fileAt = (
  selected: string,
  boundary: CaptureBoundary
): SourceFile | null => {
  const { path } = boundary;

  if (
    !(
      selected === boundary.root ||
      selected.startsWith(`${boundary.root}${path.sep}`)
    )
  ) {
    throw failure(
      "scope-denied",
      "Derived Cursor metadata paths must stay within a reviewed selected root."
    );
  }

  const file = optionalFile(path, selected);

  if (file === null) {
    boundary.absent.push(selected);
  }

  return file;
};

const metadataAt = (selected: string, boundary: CaptureBoundary) => {
  const { path } = boundary;
  const file = fileAt(selected, boundary);

  if (file === null) {
    return null;
  }

  rememberDirectory(path.dirname(selected), boundary);

  const bytes = readCaptured(
    file,
    boundary.tally,
    boundary.available,
    boundary.deadline
  );

  boundary.files.push(file);
  boundary.tally.records += 1;
  checkTally(boundary.tally, boundary.available);

  return Option.getOrNull(decodeMetaFile(new TextDecoder().decode(bytes)));
};

const selectedPaths = (
  selected: string,
  source: string,
  boundary: CaptureBoundary
): readonly string[] => {
  const { path } = boundary;

  if (!lstatSync(selected).isDirectory()) {
    rememberDirectory(path.dirname(selected), boundary);

    return [statSelected(path, selected).path];
  }

  if (source !== CURSOR_CLI_SOURCE) {
    throw failure(
      "scope-denied",
      "Cursor local database inputs must select an exact database file."
    );
  }

  rememberDirectory(selected, boundary);
  const direct = fileAt(path.join(selected, "store.db"), boundary);

  if (direct !== null) {
    return [direct.path];
  }

  const files: string[] = [];
  const entries = opendirSync(selected);

  try {
    let entry = entries.readSync();

    while (entry !== null) {
      if (performance.now() >= boundary.deadline) {
        throw failure(
          "budget-exhausted",
          "Cursor directory acquisition exceeded its elapsed allowance."
        );
      }

      boundary.tally.files += 1;
      checkTally(boundary.tally, boundary.available);

      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        const child = path.join(selected, entry.name);
        rememberDirectory(child, boundary);
        const store = fileAt(path.join(child, "store.db"), boundary);

        if (store !== null) {
          files.push(store.path);
        }
      }

      entry = entries.readSync();
    }
  } finally {
    entries.closeSync();
  }

  return files.toSorted();
};

const workspaceFolders = (
  rows: LocalDbRows,
  selected: string,
  boundary: CaptureBoundary
): ReadonlyMap<string, string | null> => {
  const { path } = boundary;
  const folders = new Map<string, string | null>();

  if (rows.layout === "ai-tracking") {
    return folders;
  }

  const ids = new Set(
    rows.headers.flatMap((row) =>
      row.workspaceId === null ? [] : [row.workspaceId]
    )
  );

  for (const row of rows.kv.filter((item) =>
    item.key.startsWith("composerData:")
  )) {
    const composer = Option.getOrNull(decodeComposerJson(row.value));

    const id = Option.getOrNull(
      decodeWorkspaceId(composer?.workspaceIdentifier)
    );

    if (id !== null) {
      ids.add(id.id);
    }
  }

  for (const id of ids) {
    if (
      id.length > 256 ||
      id !== path.basename(id) ||
      id === "." ||
      id === ".."
    ) {
      throw failure(
        "scope-denied",
        "Cursor workspace identifiers must be bounded local directory names."
      );
    }

    const selectedMetadata = path.join(
      path.dirname(path.dirname(selected)),
      "workspaceStorage",
      id,
      "workspace.json"
    );

    const meta = metadataAt(selectedMetadata, boundary);
    folders.set(id, normalizePath(meta?.folder ?? ""));
  }

  return folders;
};

const outputFrames = (bytes: Uint8Array): number => {
  let frames = 0;

  for (const byte of bytes) {
    if (byte === 10) {
      frames += 1;
    }
  }

  return bytes.length === 0 || bytes.at(-1) === 10 ? frames : frames + 1;
};

const capturedInput = (
  selected: string,
  source: string,
  copy: string,
  boundary: CaptureBoundary
): CapturedInput => {
  const { path } = boundary;

  if (performance.now() >= boundary.deadline) {
    throw failure(
      "budget-exhausted",
      "Cursor capture exceeded the remaining elapsed allowance."
    );
  }

  const journal = fileAt(`${selected}-journal`, boundary);

  if (journal !== null) {
    throw failure(
      "source-unavailable",
      "A selected Cursor database has a rollback journal; retry after its writer closes the transaction."
    );
  }

  const main = statSelected(path, selected);

  const bytes = readCaptured(
    main,
    boundary.tally,
    boundary.available,
    boundary.deadline
  );

  boundary.files.push(main);

  if (
    Buffer.from(bytes.subarray(0, 16)).toString("latin1") !==
    "SQLite format 3\u0000"
  ) {
    if (source !== CURSOR_CLI_SOURCE) {
      throw failure(
        "source-unavailable",
        "The selected Cursor local database is not SQLite."
      );
    }

    const frames = outputFrames(bytes);
    boundary.tally.records += frames;
    checkTally(boundary.tally, boundary.available);

    return {
      frames,
      kind: "output",
      source: selected,
      text: new TextDecoder().decode(bytes),
    };
  }

  writeFileSync(copy, bytes, { flag: "wx", mode: 0o600 });

  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = fileAt(`${selected}${suffix}`, boundary);

    if (sidecar !== null) {
      boundary.files.push(sidecar);
      writeFileSync(
        `${copy}${suffix}`,
        readCaptured(
          sidecar,
          boundary.tally,
          boundary.available,
          boundary.deadline
        ),
        { flag: "wx", mode: 0o600 }
      );
    }
  }

  const db = new DatabaseSync(copy, {
    readOnly: true,
    timeout: Math.max(1, Math.min(1000, boundary.available.maxElapsedMs)),
  });

  try {
    db.function("dft_budget", () => {
      if (performance.now() >= boundary.deadline) {
        throw failure(
          "budget-exhausted",
          "Cursor SQL exceeded the remaining elapsed allowance."
        );
      }

      return 1;
    });
    db.exec("BEGIN");

    if (source === CURSOR_CLI_SOURCE) {
      const rows = chatRows(db, boundary.tally, boundary.available);

      const meta = metadataAt(
        path.join(path.dirname(selected), "meta.json"),
        boundary
      );

      return { cwd: meta?.cwd ?? null, kind: "chat", rows, source: selected };
    }

    const rows = localRows(db, boundary.tally, boundary.available);

    return {
      folders: workspaceFolders(rows, selected, boundary),
      kind: "local",
      rows,
      source: selected,
    };
  } finally {
    db.close();
  }
};

const currentFiles = (snapshot: CursorSnapshot): boolean =>
  snapshot.absent.every(
    (selected) => optionalFile(snapshot.path, selected) === null
  ) &&
  snapshot.files.every(
    (file) =>
      JSON.stringify(statSelected(snapshot.path, file.path)) ===
      JSON.stringify(file)
  ) &&
  snapshot.directories.every(
    (folder) =>
      JSON.stringify(statSelected(snapshot.path, folder.path, true)) ===
      JSON.stringify(folder)
  );

const capture = Effect.fn("cursor.capture")(
  function* capture(
    selection: PlannedSourceSelection,
    context: OperationWorkContext
  ): Effect.fn.Return<
    CursorSnapshot,
    AgentStoreFailure,
    FileSystem.FileSystem | Path.Path | Scope.Scope
  > {
    const available = yield* context.budget.remaining;

    const usage = {
      byteUnits: available.maxBytes,
      bytesRead: null,
      filesRead: available.maxFiles,
      recordUnits: available.maxRecords,
      recordsDecoded: null,
      requests: 0,
      retries: 0,
    };

    const reserved = yield* context.budget.reserve(usage);
    const filesystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const directory = yield* filesystem
      .makeTempDirectoryScoped({ prefix: "dft-cursor-operation-" })
      .pipe(Effect.mapError(mapped));

    const captured = yield* Effect.exit(
      Effect.try({
        catch: mapped,
        try: () => {
          const { ref } = selection.planned;

          if (ref === null) {
            throw failure(
              "scope-denied",
              "A Cursor source reference is required."
            );
          }

          const boundary: CaptureBoundary = {
            absent: [],
            available,
            deadline: performance.now() + available.maxElapsedMs,
            directories: [],
            files: [],
            path,
            root: selection.root,
            tally: { bytes: 0, files: 0, records: 0 },
          };

          const selected = selectedPaths(
            ref.path,
            selection.planned.source,
            boundary
          );

          if (selected.length === 0) {
            throw failure(
              "source-unavailable",
              "The selected Cursor input contains no native chat database."
            );
          }

          const inputs = selected.map((file, index) =>
            capturedInput(
              file,
              selection.planned.source,
              path.join(directory, `cursor-${String(index)}.db`),
              boundary
            )
          );

          const snapshot = {
            absent: boundary.absent,
            digest: inputDigest(inputs),
            directories: boundary.directories,
            files: boundary.files,
            inputs,
            path,
            selection,
            tally: boundary.tally,
          };

          if (!currentFiles(snapshot)) {
            throw failure(
              "plan-stale",
              "Selected Cursor files or directories changed during capture."
            );
          }

          return snapshot;
        },
      })
    );

    if (Exit.isFailure(captured)) {
      yield* reserved.complete(usage);

      return yield* Effect.failCause(captured.cause);
    }

    yield* reserved.complete({
      byteUnits: captured.value.tally.bytes,
      bytesRead: null,
      filesRead: captured.value.tally.files,
      recordUnits: captured.value.tally.records,
      recordsDecoded: captured.value.tally.records,
      requests: 0,
      retries: 0,
    });

    return captured.value;
  },
  Effect.scoped,
  Effect.provide(NodeServices.layer)
);

const cursorText = (stored: StoredCursor | null): string =>
  JSON.stringify(stored?.cursor ?? null);

const checkpointIdentity = (stored: StoredCursor | null): string =>
  JSON.stringify(stored);

const disclosedReads = (
  snapshots: readonly CursorSnapshot[]
): readonly string[] => {
  const paths = [
    ...new Set(
      snapshots.flatMap((snapshot) => snapshot.files.map((file) => file.path))
    ),
  ];

  if (paths.length > 256 || paths.some((selected) => selected.length > 256)) {
    throw failure(
      "budget-exhausted",
      "Captured Cursor input paths exceed the bounded reviewed read disclosure."
    );
  }

  return paths;
};

const metadataDigest = (snapshot: CursorSnapshot): string =>
  digest(
    JSON.stringify({
      absent: snapshot.absent,
      directories: snapshot.directories,
      files: snapshot.files,
    })
  );

interface ConvertedInput {
  readonly partial?: boolean;
  readonly unsettled?: boolean;
  readonly events: EventBatch["events"];
  readonly gaps: EventBatch["coverage"]["gaps"];
  readonly rejected: number;
  readonly watermark: string | null;
}

const inputRecords = (input: CapturedInput): number =>
  Match.value(input).pipe(
    Match.when({ kind: "output" }, (value) => value.frames),
    Match.when(
      { kind: "chat" },
      (value) => value.rows.meta.size + value.rows.blobs.size
    ),
    Match.when({ kind: "local" }, (value) =>
      value.rows.layout === "ai-tracking"
        ? value.rows.codeHashes.length + value.rows.scoredCommits.length
        : value.rows.headers.length +
          value.rows.items.length +
          value.rows.kv.length
    ),
    Match.exhaustive
  );

const convertChat = (
  input: Extract<CapturedInput, { kind: "chat" }>,
  ctx: MapContext
): ConvertedInput => {
  const gaps: EventBatch["coverage"]["gaps"][number][] = [
    {
      code: "no-tokens-in-chat-store",
      message:
        "The Cursor CLI chat store carries no token counts or billed charges.",
    },
  ];

  const model = decodeChatStore(input.rows);

  if (model === null) {
    return {
      events: [],
      gaps: [
        ...gaps,
        {
          code: "chat-store-unrecognized",
          message: "The selected native chat metadata could not be decoded.",
        },
      ],
      rejected: 1,
      watermark: null,
    };
  }

  if (chatInScope(model, input.cwd, ctx.scope ?? null)) {
    return {
      events: mapChatModel(model, {
        adapterId: CURSOR_CLI_ADAPTER_ID,
        adapterVersion: CURSOR_CLI_ADAPTER_VERSION,
        context: ctx.context,
        observedAt: ctx.observedAt,
        origin: ctx.origin,
        scope: ctx.scope ?? null,
        sourceHash: ctx.sourceHash,
      }),
      gaps,
      rejected: 0,
      watermark: null,
    };
  }

  return {
    events: [],
    gaps: [
      ...gaps,
      {
        code: "scope-excluded",
        message: "A captured chat belongs to another worktree and was skipped.",
      },
    ],
    rejected: 0,
    watermark: null,
  };
};

const convertLocal = Effect.fn("cursor.convertLocal")(function* convertLocal(
  input: Extract<CapturedInput, { kind: "local" }>,
  ctx: MapContext,
  options: BoundedCursorOperationOptions,
  context: OperationWorkContext
): Effect.fn.Return<ConvertedInput, AgentStoreFailure> {
  const gaps: EventBatch["coverage"]["gaps"][number][] = [
    {
      code: "no-billed-charge",
      message:
        "Cursor local database usage meters are separate from billed charges.",
    },
  ];

  let knownCommits: ReadonlySet<string> = new Set();

  if (
    input.rows.layout === "ai-tracking" &&
    input.rows.scoredCommits.length > 0
  ) {
    if (
      options.knownCommits === undefined ||
      ctx.scope === null ||
      ctx.scope === undefined
    ) {
      gaps.push({
        code: "commit-membership-unavailable",
        message:
          "Scored commit repository membership is unavailable; those rows were withheld.",
      });
    } else {
      knownCommits = yield* options.knownCommits(
        ctx.scope.own,
        [...new Set(input.rows.scoredCommits.map((row) => row.commitHash))],
        context
      );
    }
  }

  const scoped: MapContext = {
    ...ctx,
    folderOf: (id) => input.folders.get(id) ?? null,
    knownCommits,
  };

  const result =
    input.rows.layout === "ai-tracking"
      ? mapAiTracking(input.rows, scoped)
      : mapStateDb(input.rows, scoped);

  if (result.excluded > 0) {
    gaps.push({
      code: "scope-excluded",
      message: `${String(result.excluded)} native rows of other scopes were skipped.`,
    });
  }

  if (result.unreadable > 0) {
    gaps.push({
      code: "unreadable-rows",
      message: `${String(result.unreadable)} native rows did not match a recognized shape.`,
    });
  }

  return {
    events: result.events,
    gaps,
    rejected: result.unreadable,
    watermark: result.watermark,
  };
});

const scopedOutputEvents = (
  events: EventBatch["events"],
  scope: WorktreeScope | null | undefined
): EventBatch["events"] => {
  if (scope === null || scope === undefined) {
    return [];
  }

  return events.flatMap((event) => {
    const cwd = event.context.worktreePath;

    if (cwd === null || !ownsPath(scope, cwd)) {
      return [];
    }

    return [
      {
        ...event,
        ai: event.ai === null ? null : { ...event.ai, cwd },
        context: { ...event.context, worktreePath: scope.own },
        payload: { ...event.payload, cwd },
      },
    ];
  });
};

const convertInput = Effect.fn("cursor.convertInput")(function* convertInput(
  input: CapturedInput,
  ctx: MapContext,
  options: BoundedCursorOperationOptions,
  context: OperationWorkContext
): Effect.fn.Return<ConvertedInput, AgentStoreFailure> {
  if (input.kind === "local") {
    return yield* convertLocal(input, ctx, options, context);
  }

  if (input.kind === "chat") {
    return convertChat(input, ctx);
  }

  const batch = parseCursorCliOutput(
    input.text,
    {
      adapterId: CURSOR_CLI_ADAPTER_ID,
      context: { ...ctx.context, worktreePath: null },
      cursor: null,
      origin: ctx.origin,
      scratchDir: null,
      selectedInput: input.source,
    },
    ctx.observedAt
  );

  const events = scopedOutputEvents(batch.events, ctx.scope);

  const excluded = batch.events.length - events.length;

  const gaps = [
    ...batch.coverage.gaps,
    ...(excluded === 0
      ? []
      : [
          {
            code: "scope-unproven",
            message: `${String(excluded)} saved CLI observations lack native proof of the selected worktree and were withheld.`,
          },
        ]),
  ];

  return {
    events,
    gaps,
    partial: batch.coverage.state === "partial" || excluded > 0,
    rejected: 0,
    unsettled: batch.coverage.gaps.some(
      (gap) => gap.code === "run-without-result"
    ),
    watermark: batch.coverage.watermark,
  };
});

const coverageState = (
  rejected: number,
  events: number,
  partial: boolean
): EventBatch["coverage"]["state"] => {
  if (rejected > 0 || partial) {
    return "partial";
  }

  return events === 0 ? "none" : "complete";
};

const decodeBatch = Effect.fn("cursor.decodeBatch")(function* decodeBatch(
  snapshot: CursorSnapshot,
  options: BoundedCursorOperationOptions,
  context: OperationWorkContext
): Effect.fn.Return<EventBatch, AgentStoreFailure> {
  const tracked = snapshot.selection.planned.context;

  if (tracked.worktreePath === null || options.worktreeRoots === undefined) {
    return yield* failure(
      "source-unavailable",
      "Bounded repository worktree membership is required before assigning native Cursor observations."
    );
  }

  const roots = yield* options.worktreeRoots(tracked.worktreePath, context);
  const scope: WorktreeScope | null = scopeFor(tracked, () => roots);

  if (scope === null) {
    return yield* failure(
      "scope-denied",
      "Cursor conversion requires one explicitly tracked worktree."
    );
  }

  const ctx: MapContext = {
    context: { ...tracked, branch: null, flightId: null, headSha: null },
    observedAt: DateTime.formatIso(yield* DateTime.now),
    origin: "imported",
    scope,
    sourceHash: `sha256:${snapshot.digest}`,
  };

  const events: EventBatch["events"][number][] = [];

  const gaps: EventBatch["coverage"]["gaps"][number][] = [
    { code: "logical-work-boundary", message: LIMITATION },
    {
      code: "attribution-unavailable",
      message:
        "Collection-time branch, commit and flight do not prove native event attribution; only source-recorded branches and commits are retained.",
    },
  ];

  let partial = false;
  let unsettled = false;
  let rejected = 0;
  let expectedItems = 0;
  let watermark: string | null = null;

  for (const input of snapshot.inputs) {
    const records = inputRecords(input);
    yield* context.budget.charge({
      bytesRead: 0,
      filesRead: 0,
      recordUnits: records,
      recordsDecoded: null,
      requests: 0,
      retries: 0,
    });
    expectedItems += records;
    const converted = yield* convertInput(input, ctx, options, context);
    events.push(...converted.events);
    gaps.push(...converted.gaps);
    rejected += converted.rejected;
    partial ||= converted.partial === true;
    unsettled ||= converted.unsettled === true;

    if (
      converted.watermark !== null &&
      (watermark === null || converted.watermark > watermark)
    ) {
      ({ watermark } = converted);
    }

    const available = yield* context.budget.remaining;

    if (events.length > available.maxRecords) {
      return yield* failure(
        "budget-exhausted",
        "Normalized Cursor observations exceed the remaining record allowance before append."
      );
    }
  }

  yield* context.budget.charge({
    bytesRead: 0,
    filesRead: 0,
    recordUnits: events.length,
    recordsDecoded: 0,
    requests: 0,
    retries: 0,
  });

  return {
    coverage: {
      adapterId:
        snapshot.selection.planned.source === CURSOR_CLI_SOURCE
          ? CURSOR_CLI_ADAPTER_ID
          : CURSOR_LOCAL_DB_ADAPTER_ID,
      expectedItems,
      gaps,
      observedItems: events.length,
      state: coverageState(rejected, events.length, partial),
      watermark,
      windowFrom: null,
      windowTo: watermark,
    },
    cursor:
      watermark === null
        ? null
        : { adapterId: CURSOR_LOCAL_DB_ADAPTER_ID, value: watermark },
    events,
    unsettled,
  };
});

const harnessFor = (snapshot: CursorSnapshot, batch: EventBatch): Harness => ({
  capabilities: {
    branchSources: ["session-recorded"],
    liveHooks: false,
    storedFigure: null,
    subagents: true,
  },
  channels: ["local-db"],
  discover: Effect.succeed({
    harness: "cursor",
    present: true,
    reason: null,
    roots: [snapshot.selection.root],
    sessions: snapshot.inputs.length,
    version: BOUNDED_CURSOR_OPERATION_VERSION,
  }),
  displayName: "Cursor",
  id: "cursor",
  locate: () => Effect.succeed([]),
  read: () => Effect.succeed(batch),
});

const remainingWork = (
  result: HarnessReadResult,
  checkpointGap: string | null
): string | null => {
  if (result.spooledTo !== null) {
    return "Import the staged selected batch before advancing the Cursor checkpoint.";
  }

  if (checkpointGap !== null) {
    return "Verify the retained Cursor checkpoint before retrying this selected scope.";
  }

  return result.coverage.state === "partial"
    ? "Replan unresolved native Cursor rows."
    : null;
};

const stepState = (
  result: HarnessReadResult,
  checkpointGap: string | null
): OperationStep["state"] => {
  if (result.spooledTo !== null) {
    return "spooled";
  }

  if (checkpointGap !== null || result.coverage.state === "partial") {
    return "partial";
  }

  if (result.events === 0) {
    return "unchanged";
  }

  return result.inserted === 0 ? "already-applied" : "committed";
};

const boundedReceiptGaps = (
  result: Pick<HarnessReadResult, "coverage">,
  checkpointGap: string | null
): readonly string[] => {
  const values = [
    ...new Set([
      ...result.coverage.gaps.map((gap) =>
        `${gap.code}: ${gap.message}`.slice(0, 4096)
      ),
      ...(checkpointGap === null ? [] : [checkpointGap.slice(0, 4096)]),
    ]),
  ];

  if (values.length <= 64) {
    return values;
  }

  return [
    ...values.slice(0, 63),
    `${String(values.length - 63)} additional source gaps were omitted from this bounded receipt.`,
  ];
};

const resultStep = (
  step: OperationStep,
  result: HarnessReadResult,
  stored: StoredCursor | null,
  checkpointGap: string | null
): OperationStep => ({
  ...step,
  committedThrough:
    result.spooledTo === null && checkpointGap === null
      ? result.lastEventId
      : step.committedThrough,
  duplicates: result.duplicates,
  gaps: boundedReceiptGaps(result, checkpointGap),
  inserted: result.inserted,
  rejected: null,
  remainingWork: remainingWork(result, checkpointGap),
  safeCursor: cursorText(stored),
  spooledRefs: result.spooledTo === null ? [] : [result.spooledTo],
  state: stepState(result, checkpointGap),
});

const allObservationsWithheld = (batch: EventBatch): boolean =>
  batch.events.length === 0 &&
  batch.coverage.gaps.some((gap) => gap.code === "scope-unproven");

const withheldStep = (
  step: OperationStep,
  batch: EventBatch,
  previous: StoredCursor | null
): OperationStep => ({
  ...step,
  duplicates: 0,
  gaps: boundedReceiptGaps(batch, null),
  inserted: 0,
  rejected: null,
  remainingWork:
    "Select saved Cursor output with native proof of this repository worktree.",
  safeCursor: cursorText(previous),
  state: "unavailable",
});

const advanceCheckpoint = Effect.fn("cursor.advanceCheckpoint")(
  function* advanceCheckpoint(
    snapshot: CursorSnapshot,
    result: HarnessReadResult,
    previous: StoredCursor | null,
    cursors: HarnessCursorsApi | null | undefined
  ) {
    const { ref } = snapshot.selection.planned;

    if (
      result.spooledTo !== null ||
      cursors === null ||
      cursors === undefined ||
      ref === null
    ) {
      return { checkpoint: previous, gap: null };
    }

    if (result.unsettled) {
      return {
        checkpoint: previous,
        gap: "Native Cursor input remains incomplete; the previous checkpoint was retained.",
      };
    }

    const unchanged = yield* Effect.try({
      catch: mapped,
      try: () => currentFiles(snapshot),
    }).pipe(Effect.orElseSucceed(() => false));

    if (!unchanged) {
      return {
        checkpoint: previous,
        gap: "Cursor files changed after append; the previous checkpoint was retained.",
      };
    }

    if (cursors.putIfCurrent === undefined) {
      return {
        checkpoint: previous,
        gap: "Atomic Cursor checkpoint comparison is unavailable; the previous checkpoint was retained.",
      };
    }

    const next: StoredCursor = {
      cursor: result.cursor,
      lastEventId: result.lastEventId ?? previous?.lastEventId ?? null,
      mtimeMs: Math.max(
        ...snapshot.files.map((file) => file.mtimeMs),
        ...snapshot.directories.map((folder) => folder.mtimeMs)
      ),
      size: snapshot.files.reduce((sum, file) => sum + file.size, 0),
    };

    const advanced = yield* cursors.putIfCurrent(ref, previous, next).pipe(
      Effect.mapError(mapped),
      Effect.orElseSucceed(() => false)
    );

    return advanced
      ? { checkpoint: next, gap: null }
      : {
          checkpoint: previous,
          gap: "Another writer changed the Cursor checkpoint; retained progress needs verification.",
        };
  }
);

export const makeBoundedCursorOperationAdapter = (
  options: BoundedCursorOperationOptions
): OperationAdapter => {
  const acceptedCursors = new WeakMap<
    OperationWorkBudget,
    Map<string, string>
  >();

  const accepted = (budget: OperationWorkBudget) => {
    const values = acceptedCursors.get(budget) ?? new Map<string, string>();
    acceptedCursors.set(budget, values);

    return values;
  };

  const retained = new WeakMap<
    OperationWorkBudget,
    Map<string, readonly CursorSnapshot[]>
  >();

  const snapshots = (budget: OperationWorkBudget) => {
    const values =
      retained.get(budget) ?? new Map<string, readonly CursorSnapshot[]>();

    retained.set(budget, values);

    return values;
  };

  const parserVersion =
    options.parserVersion ?? BOUNDED_CURSOR_OPERATION_VERSION;

  const select = Effect.fn("cursor.select")(function* select(
    value: OperationPlan | OperationPlanInput
  ) {
    const path = yield* Path.Path;

    if (
      value.arguments.kind !== "collect" ||
      !BOUNDED_CURSOR_OPERATION_SOURCES.includes(value.arguments.source) ||
      value.arguments.parserVersion !== parserVersion
    ) {
      return yield* failure(
        "invalid-selector",
        "Select an installed bounded Cursor source and parser version."
      );
    }

    const selected = yield* options.selected(requestOf(value));

    if (
      selected.length === 0 ||
      selected.length !== value.arguments.inputRefs.length ||
      selected.length > 80 ||
      new Set(selected.map((item) => item.inputRef.id)).size !==
        selected.length ||
      !sameOperationAgentRefs(
        selected.map((item) => item.inputRef),
        value.arguments.inputRefs
      )
    ) {
      return yield* failure(
        "scope-denied",
        "Each selected Cursor input must resolve to one exact reviewed reference."
      );
    }

    const roots = new Set(value.arguments.selectedRoots);

    for (const item of selected) {
      const selectedPath = item.planned.ref?.path ?? "";

      if (
        !roots.has(item.root) ||
        !path.isAbsolute(item.root) ||
        item.root !== path.resolve(item.root) ||
        !(
          selectedPath === item.root ||
          selectedPath.startsWith(`${item.root}${path.sep}`)
        ) ||
        !checkedSelection(item, requestOf(value))
      ) {
        return yield* failure(
          "scope-denied",
          "Cursor selection must match exact selected roots, retained input references and the enrolled repository scope."
        );
      }
    }

    if (
      [...roots].some((root) => !selected.some((item) => item.root === root))
    ) {
      return yield* failure(
        "scope-denied",
        "Every selected Cursor root must contain a reviewed input."
      );
    }

    return selected;
  }, Effect.provide(NodeServices.layer));

  const cursorOf = (
    selection: PlannedSourceSelection
  ): Effect.Effect<StoredCursor | null, AgentStoreFailure> =>
    options.cursors === null ||
    options.cursors === undefined ||
    selection.planned.ref === null
      ? Effect.succeed(null)
      : options.cursors.get(selection.planned.ref);

  const validate = Effect.fn("cursor.validate")(
    function* validate(plan: OperationPlan, context: OperationWorkContext) {
      const consent = yield* options.enrollment(
        enrollmentOf(plan, plan.consent.receiptIds),
        context
      );

      if (consent.state !== "authorized") {
        return [
          consent.reason ??
            "The selected Cursor repository is no longer enrolled.",
        ];
      }

      const selected = yield* select(plan);

      if (
        !plan.preconditions.some(
          (entry) =>
            entry.kind === "parser-version" && entry.expected === parserVersion
        )
      ) {
        return ["The bounded Cursor parser version changed."];
      }

      for (const item of selected) {
        if (
          plan.preconditions.find(
            (entry) =>
              entry.kind === "source-cursor" &&
              entry.target === item.inputRef.id
          )?.expected !== checkpointIdentity(yield* cursorOf(item)) &&
          accepted(context.budget).get(
            `${plan.planDigest}:${item.inputRef.id}`
          ) !== checkpointIdentity(yield* cursorOf(item))
        ) {
          return [
            "The selected Cursor checkpoint changed without this operation's durable progress.",
          ];
        }
      }

      if (!snapshots(context.budget).has(plan.planDigest)) {
        const captured: CursorSnapshot[] = [];

        for (const item of selected) {
          const current = yield* capture(item, context);

          const expected = plan.preconditions.find(
            (entry) =>
              entry.kind === "source-content" &&
              entry.target === item.inputRef.id
          );

          const previous =
            expected === undefined
              ? null
              : Option.getOrNull(decodeContent(expected.expected));

          if (
            previous === null ||
            previous.digest !== current.digest ||
            previous.metadataDigest !== metadataDigest(current)
          ) {
            return [
              "Selected Cursor content, identity or approved growth assumptions changed.",
            ];
          }

          captured.push(current);
        }

        snapshots(context.budget).set(plan.planDigest, captured);
      }

      return [];
    },
    Effect.matchEffect({
      onFailure: (error: AgentStoreFailure) => Effect.succeed([error.message]),
      onSuccess: Effect.succeed,
    })
  );

  const requireEnrollment = Effect.fn("cursor.requireEnrollment")(
    function* requireEnrollment(
      plan: OperationPlan,
      context: OperationWorkContext
    ) {
      const consent = yield* options.enrollment(
        enrollmentOf(plan, plan.consent.receiptIds),
        context
      );

      if (
        consent.state !== "authorized" ||
        !plan.consent.receiptIds.every((id) => consent.receiptIds.includes(id))
      ) {
        return yield* failure(
          "authorization-required",
          consent.reason ??
            "The selected Cursor enrollment was revoked before this effect boundary."
        );
      }

      return yield* Effect.void;
    }
  );

  return {
    authorize: Effect.fn("cursor.authorize")(
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
        "Exact selected native Cursor file or chat directory references",
        "Current tracked repository enrollment",
        "Reviewed file, byte, record and elapsed allowances",
      ],
      version: parserVersion,
    },
    execute: Effect.fn("cursor.execute")(
      function* execute(
        plan,
        step,
        context
      ): Effect.fn.Return<OperationEffectResult, AgentStoreFailure> {
        yield* requireEnrollment(plan, context);

        if (!snapshots(context.budget).has(plan.planDigest)) {
          const problems = yield* validate(plan, context);

          if (problems.length > 0) {
            return yield* failure("plan-stale", problems.join(" "));
          }
        }

        const snapshot = snapshots(context.budget)
          .get(plan.planDigest)
          ?.find((item) => stepId(item.selection) === step.id);

        if (snapshot === undefined || snapshot.selection.planned.ref === null) {
          return yield* failure(
            "scope-denied",
            "The Cursor step is outside the captured reviewed inputs."
          );
        }

        const { ref } = snapshot.selection.planned;

        if (
          !(yield* Effect.try({
            catch: mapped,
            try: () => currentFiles(snapshot),
          }))
        ) {
          return yield* failure(
            "plan-stale",
            "Cursor source files changed before the captured observations were appended."
          );
        }

        const previous = yield* cursorOf(snapshot.selection);

        const expected = plan.preconditions.find(
          (entry) =>
            entry.kind === "source-cursor" &&
            entry.target === snapshot.selection.inputRef.id
        );

        if (
          expected?.expected !== checkpointIdentity(previous) &&
          !(
            step.safeCursor === cursorText(previous) &&
            step.committedThrough !== null &&
            step.committedThrough === previous?.lastEventId
          )
        ) {
          return yield* failure(
            "cursor-mismatch",
            "The Cursor checkpoint changed without this step's retained progress."
          );
        }

        const batch = yield* decodeBatch(snapshot, options, context);

        if (allObservationsWithheld(batch)) {
          return {
            resources: yield* context.budget.measurements,
            step: withheldStep(step, batch, previous),
          };
        }

        yield* requireEnrollment(plan, context);

        const result = yield* runHarnessRead(options.env, {
          context: snapshot.selection.planned.context,
          cursor: previous?.cursor ?? null,
          harness: harnessFor(snapshot, batch),
          ref,
        }).pipe(Effect.mapError(mapped));

        const checkpointState = yield* advanceCheckpoint(
          snapshot,
          result,
          previous,
          options.cursors
        );

        if (checkpointState.gap === null && result.spooledTo === null) {
          accepted(context.budget).set(
            `${plan.planDigest}:${snapshot.selection.inputRef.id}`,
            checkpointIdentity(checkpointState.checkpoint)
          );
        }

        return {
          resources: yield* context.budget.measurements,
          step: resultStep(
            step,
            result,
            checkpointState.checkpoint,
            checkpointState.gap
          ),
        };
      }
    ),
    meteredWork: true,
    prepare: Effect.fn("cursor.prepare")(
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
              "Cursor enrollment is required before reading source content."
          );
        }

        const captured: CursorSnapshot[] = [];
        const preconditions: OperationPlan["preconditions"][number][] = [];

        for (const item of selected) {
          const current = yield* capture(item, context);
          const stored = yield* cursorOf(item);
          const cursor = cursorText(stored);

          if (
            input.arguments.kind === "collect" &&
            input.arguments.cursor !== null &&
            (selected.length !== 1 || input.arguments.cursor !== cursor)
          ) {
            return yield* failure(
              "cursor-mismatch",
              "The explicit Cursor cursor must match the retained checkpoint."
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
                metadataDigest: metadataDigest(current),
              }),
              kind: "source-content",
              target: item.inputRef.id,
            },
            {
              allowAppend: false,
              expected: checkpointIdentity(stored),
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
            reads: yield* Effect.try({
              catch: mapped,
              try: () => disclosedReads(captured),
            }),
            writes: [options.env.storePath, spoolDirFor(options.env.storePath)],
          },
          expectedEvidenceImprovement:
            "Import native Cursor local database and saved CLI observations from explicitly selected bounded inputs.",
          forecast: {
            bytes: null,
            cost: null,
            elapsedMs: null,
            requests: null,
          },
          preconditions: [
            ...preconditions,
            {
              allowAppend: false,
              expected: parserVersion,
              kind: "parser-version",
              target:
                input.arguments.kind === "collect"
                  ? input.arguments.source
                  : "cursor",
            },
          ],
          resumeBoundary: "complete-record",
          stopCondition: `Stop after the selected captured inputs or before any cumulative reviewed allowance is exceeded. ${LIMITATION}`,
        };
      }
    ),
    probe: Effect.fn("cursor.probe")(
      function* probe(plan, step, receipt, context) {
        const consent = yield* options.enrollment(
          enrollmentOf(plan, plan.consent.receiptIds),
          context
        );

        if (consent.state !== "authorized") {
          return {
            reason:
              "Cursor enrollment is unavailable for recovery verification.",
            state: "indeterminate",
          };
        }

        const selected = (yield* select(plan)).find(
          (item) => stepId(item) === step.id
        );

        if (selected === undefined) {
          return {
            reason: "The recovery step does not match a reviewed Cursor input.",
            state: "indeterminate",
          };
        }

        const current = yield* cursorOf(selected);
        const previous = receipt.steps.find((entry) => entry.id === step.id);

        const expected = plan.preconditions.find(
          (entry) =>
            entry.kind === "source-cursor" &&
            entry.target === selected.inputRef.id
        );

        if (
          previous?.safeCursor !== null &&
          previous?.safeCursor !== undefined &&
          previous.safeCursor === cursorText(current) &&
          previous.committedThrough !== null &&
          previous.committedThrough === current?.lastEventId
        ) {
          return {
            result: {
              step:
                previous.state === "partial"
                  ? previous
                  : { ...previous, remainingWork: null, state: "committed" },
            },
            state: "complete",
          };
        }

        if (
          checkpointIdentity(current) !== expected?.expected ||
          previous?.state === "running" ||
          previous?.state === "indeterminate"
        ) {
          return {
            reason:
              "A prior Cursor append or checkpoint may have committed without a durable step receipt; its effect attribution remains indeterminate.",
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
            operationStep(
              `cursor:${digest(ref.id).slice(0, 32)}`,
              plan.arguments.kind === "collect" ? plan.arguments.source : null
            )
          )
        : [],
    validate,
  };
};
