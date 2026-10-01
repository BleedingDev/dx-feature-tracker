import { Effect, Option, Schema } from "effect";

import type { GitRunner } from "../../collectors/git-observation/git-runner.js";
import { withBranchSource } from "../../model/attribution.js";
import type { DxEventEnvelope } from "../../model/event.js";
import { normalizePath } from "../repo/path.js";
import {
  buildRepoMap,
  parseWorktreePorcelain,
  resolvePath,
} from "../repo/worktree-map.js";
import type { RepoMap, WorktreeRecord } from "../repo/worktree-map.js";

export type PlacementMethod =
  | "tool-cwd"
  | "file-path"
  | "modified-files"
  | "same-chat";

export interface WorktreePlacement {
  readonly branch: string | null;
  readonly eventId: string;
  readonly fromWorktree: string | null;
  readonly method: PlacementMethod;
  readonly worktree: string;
}

export interface PlacedEvents {
  readonly events: readonly DxEventEnvelope[];
  readonly placements: readonly WorktreePlacement[];
}

const OWN_PATH_LOCATIONS: ReadonlySet<string> = new Set([
  "tool-cwd",
  "file-path",
  "modified-files",
]);

const PlacementPayloadSchema = Schema.Struct({
  cwd: Schema.optional(Schema.NullOr(Schema.String)),
  filePath: Schema.optional(Schema.NullOr(Schema.String)),
  locatedBy: Schema.optional(Schema.NullOr(Schema.String)),
  modifiedFiles: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  parentToolCallId: Schema.optional(Schema.NullOr(Schema.String)),
  toolCallId: Schema.optional(Schema.NullOr(Schema.String)),
});

type PlacementPayload = typeof PlacementPayloadSchema.Type;

const decodePlacementPayload = Schema.decodeUnknownOption(
  PlacementPayloadSchema
);

const payloadOf = (event: DxEventEnvelope): PlacementPayload =>
  Option.getOrElse(decodePlacementPayload(event.payload), () => ({}));

const sameDir = (a: string | null, b: string | null): boolean =>
  a !== null && b !== null && normalizePath(a) === normalizePath(b);

const dirOf = (file: string): string => {
  const index = file.lastIndexOf("/");

  return index <= 0 ? "/" : file.slice(0, index);
};

const absoluteFrom = (base: string | null, target: string): string | null => {
  const slashed = target.replaceAll("\\", "/");

  if (slashed.startsWith("/") || /^[A-Za-z]:\//u.test(slashed)) {
    return normalizePath(slashed);
  }

  return base === null ? null : normalizePath(`${base}/${slashed}`);
};

interface OwnPath {
  readonly by: Exclude<PlacementMethod, "same-chat">;
  readonly path: string;
}

export const ownPathsOf = (event: DxEventEnvelope): readonly OwnPath[] => {
  const payload = payloadOf(event);
  const cwd = payload.cwd ?? null;
  const base = cwd ?? event.context.worktreePath;

  const toolCwd =
    cwd === null ? null : absoluteFrom(event.context.worktreePath, cwd);

  const file =
    payload.filePath === null || payload.filePath === undefined
      ? null
      : absoluteFrom(base, payload.filePath);

  const modified = (payload.modifiedFiles ?? []).flatMap((item) => {
    const absolute = absoluteFrom(base, item);

    return absolute === null ? [] : [dirOf(absolute)];
  });

  return [
    ...(toolCwd === null ? [] : [{ by: "tool-cwd" as const, path: toolCwd }]),
    ...(file === null ? [] : [{ by: "file-path" as const, path: dirOf(file) }]),
    ...modified.map((path) => ({ by: "modified-files" as const, path })),
  ];
};

const capturedByOwnPath = (event: DxEventEnvelope): boolean => {
  const by = payloadOf(event).locatedBy ?? null;

  return by !== null && OWN_PATH_LOCATIONS.has(by);
};

const worktreeFor = (
  maps: readonly RepoMap[],
  event: DxEventEnvelope
): { readonly by: OwnPath["by"]; readonly worktree: WorktreeRecord } | null => {
  for (const own of ownPathsOf(event)) {
    const resolved = resolvePath(maps, own.path);

    if (
      resolved.status === "matched" &&
      sameDir(resolved.repoCommonDir, event.context.repoCommonDir)
    ) {
      return { by: own.by, worktree: resolved.worktree };
    }
  }

  return null;
};

const REASONS: Record<PlacementMethod, string> = {
  "file-path": "the file it touched is in this worktree",
  "modified-files": "the files the subagent changed are in this worktree",
  "same-chat":
    "no path of its own; every other event of the same chat with a path is in this worktree",
  "tool-cwd": "the tool ran in this worktree",
};

const place = (
  event: DxEventEnvelope,
  worktree: WorktreeRecord,
  method: PlacementMethod
): DxEventEnvelope => ({
  ...event,
  ai: withBranchSource(
    event.ai,
    worktree.detached ? null : worktree.branch,
    "tool-calls"
  ),
  context: {
    ...event.context,
    branch: worktree.detached ? null : worktree.branch,
    headSha: null,
    worktreePath: worktree.path,
  },
  payload: {
    ...event.payload,
    worktreePlacement: {
      fromBranch: event.context.branch,
      fromWorktree: event.context.worktreePath,
      method,
      reason: REASONS[method],
      worktree: worktree.path,
    },
  },
});

export const linkSubagentToolCalls = (
  events: readonly DxEventEnvelope[]
): readonly DxEventEnvelope[] => {
  const childByToolCall = new Map<string, string>();

  for (const event of events) {
    const payload = payloadOf(event);
    const toolCallId = payload.toolCallId ?? null;
    const child = event.identity.sessionId;

    if (
      event.payload.isSubagent === true &&
      toolCallId !== null &&
      child !== null
    ) {
      childByToolCall.set(toolCallId, child);
    }
  }

  if (childByToolCall.size === 0) {
    return events;
  }

  return events.map((event) => {
    const parentToolCallId = payloadOf(event).parentToolCallId ?? null;

    const child =
      parentToolCallId === null
        ? undefined
        : childByToolCall.get(parentToolCallId);

    return child === undefined || child === event.identity.sessionId
      ? event
      : {
          ...event,
          identity: { ...event.identity, sessionId: child },
          payload: {
            ...event.payload,
            chatFrom: {
              method: "parent-tool-call-id",
              sessionId: event.identity.sessionId,
            },
          },
        };
  });
};

export const placeByOwnPaths = (
  maps: readonly RepoMap[],
  events: readonly DxEventEnvelope[]
): readonly DxEventEnvelope[] =>
  events.map((event) => {
    if (capturedByOwnPath(event) || event.context.repoCommonDir === null) {
      return event;
    }

    const found = worktreeFor(maps, event);

    return found === null ||
      sameDir(event.context.worktreePath, found.worktree.path)
      ? event
      : place(event, found.worktree, found.by);
  });

const worktreeRecordOf = (
  maps: readonly RepoMap[],
  repoCommonDir: string,
  worktreePath: string
): WorktreeRecord | null =>
  maps
    .find((map) => sameDir(map.repoCommonDir, repoCommonDir))
    ?.worktrees.find((w) => sameDir(worktreePath, w.path)) ?? null;

const hasOwnPlace = (
  maps: readonly RepoMap[],
  event: DxEventEnvelope
): boolean => capturedByOwnPath(event) || worktreeFor(maps, event) !== null;

export const placeBySameChat = (
  maps: readonly RepoMap[],
  events: readonly DxEventEnvelope[]
): readonly DxEventEnvelope[] => {
  const anchors = new Map<string, Set<string>>();

  for (const event of events) {
    const { sessionId } = event.identity;
    const { repoCommonDir, worktreePath } = event.context;

    if (
      sessionId !== null &&
      repoCommonDir !== null &&
      worktreePath !== null &&
      hasOwnPlace(maps, event)
    ) {
      const key = `${repoCommonDir}\u0000${sessionId}`;
      anchors.set(key, (anchors.get(key) ?? new Set()).add(worktreePath));
    }
  }

  return events.map((event) => {
    const { sessionId } = event.identity;
    const { repoCommonDir } = event.context;

    if (
      sessionId === null ||
      repoCommonDir === null ||
      hasOwnPlace(maps, event) ||
      event.payload.sessionJoin !== undefined
    ) {
      return event;
    }

    const found = anchors.get(`${repoCommonDir}\u0000${sessionId}`);
    const [only] = found === undefined || found.size !== 1 ? [] : [...found];

    if (only === undefined || sameDir(event.context.worktreePath, only)) {
      return event;
    }

    const record = worktreeRecordOf(maps, repoCommonDir, only);

    return record === null ? event : place(event, record, "same-chat");
  });
};

const PlacementSchema = Schema.Struct({
  fromWorktree: Schema.NullOr(Schema.String),
  method: Schema.Literals([
    "tool-cwd",
    "file-path",
    "modified-files",
    "same-chat",
  ]),
});

const decodePlacement = Schema.decodeUnknownOption(PlacementSchema);

const placementOf = (event: DxEventEnvelope): readonly WorktreePlacement[] => {
  const worktree = event.context.worktreePath;

  return Option.match(decodePlacement(event.payload.worktreePlacement), {
    onNone: () => [],
    onSome: (placement) =>
      worktree === null
        ? []
        : [
            {
              branch: event.context.branch,
              eventId: event.eventId,
              fromWorktree: placement.fromWorktree,
              method: placement.method,
              worktree,
            },
          ],
  });
};

export const placeEventsInWorktrees = (
  maps: readonly RepoMap[],
  events: readonly DxEventEnvelope[]
): PlacedEvents => {
  const placed = placeBySameChat(
    maps,
    placeByOwnPaths(maps, linkSubagentToolCalls(events))
  );

  return { events: placed, placements: placed.flatMap(placementOf) };
};

const repoDirsOf = (events: readonly DxEventEnvelope[]): readonly string[] => [
  ...new Set(
    events.flatMap((event) =>
      event.context.repoCommonDir === null ? [] : [event.context.repoCommonDir]
    )
  ),
];

export const loadRepoMaps = (
  runGit: GitRunner,
  events: readonly DxEventEnvelope[]
): Effect.Effect<readonly RepoMap[]> =>
  Effect.forEach(
    repoDirsOf(events),
    (repoCommonDir) =>
      runGit(repoCommonDir, ["worktree", "list", "--porcelain"]).pipe(
        Effect.map((text) =>
          buildRepoMap(repoCommonDir, parseWorktreePorcelain(text))
        ),
        Effect.orElseSucceed(() => null)
      ),
    { concurrency: 2 }
  ).pipe(
    Effect.map((maps) => maps.flatMap((map) => (map === null ? [] : [map])))
  );
