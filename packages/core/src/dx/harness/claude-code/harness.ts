import {
  Clock,
  Context,
  DateTime,
  Effect,
  Layer,
  Option,
  Schema,
} from "effect";

import type { SourceGap } from "../../model/coverage.js";
import type { DxEventEnvelope, EventBatch } from "../../model/event.js";
import type {
  Discovery,
  Harness,
  HarnessScope,
  ReadInput,
  SessionRef,
  StoredSession,
} from "../contract.js";
import { hookSpoolRefs, readHookSpool } from "../hook-spool.js";
import { readSessionCursor, isUnchanged, sessionCursorOf } from "./cursor.js";
import {
  CLAUDE_CODE_ADAPTER_ID,
  costEvent,
  isStreamStart,
  sessionEvent,
  turnEvent,
  turnKeyOf,
  usageEvent,
} from "./events.js";
import type { EventInput, Placement, SessionFacts } from "./events.js";
import { claudeCodeHookDecoder } from "./hook.js";
import { splitLines } from "./lines.js";
import { CLAUDE_CODE_CHANNELS } from "./meta.js";
import {
  groupFamilies,
  isOwnFolderFamily,
  metaPathOf,
  slugMayHold,
} from "./paths.js";
import type { SessionFamily } from "./paths.js";
import { anyPointsIntoWorktree, ownedBy, placePicks } from "./placement.js";
import type { PlacedPick } from "./placement.js";
import { removedWorktreeFamilies } from "./removed.js";
import type { RemovedFamily } from "./removed.js";
import { decodeClaudeLine } from "./rows.js";
import { scanChunks } from "./scan.js";
import type {
  ChatInfo,
  FileChunk,
  FileState,
  RequestPick,
  ScanTally,
  SubagentMeta,
} from "./scan.js";
import { ClaudeCodeStore } from "./store.js";
import type { ClaudeCodeFiles } from "./store.js";

export const QUIET_MS = 60_000;

export const IDLE_MS = 30 * 60_000;

const VERSION_TAIL_BYTES = 64 * 1024;

const SUBAGENT_SEGMENT = "/subagents/";

const Text = Schema.optional(Schema.NullOr(Schema.String));

const decodeMeta = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      agentType: Text,
      parentAgentId: Text,
      worktreePath: Text,
    })
  )
);

const metaOf = (store: ClaudeCodeFiles, file: string) =>
  file.includes(SUBAGENT_SEGMENT)
    ? store.readText(metaPathOf(file)).pipe(
        Effect.map((text) =>
          Option.match(decodeMeta(text), {
            onNone: (): SubagentMeta | null => null,
            onSome: (meta): SubagentMeta => ({
              agentType: meta.agentType ?? null,
              parentAgentId: meta.parentAgentId ?? null,
              worktreePath: meta.worktreePath ?? null,
            }),
          })
        ),
        Effect.orElseSucceed(() => null)
      )
    : Effect.succeed(null);

const newest = (family: SessionFamily): number | null => {
  let latest: number | null = null;

  for (const file of family.files) {
    if (file.mtimeMs !== null && (latest === null || file.mtimeMs > latest)) {
      latest = file.mtimeMs;
    }
  }

  return latest;
};

const totalSize = (family: SessionFamily): number => {
  let total = 0;

  for (const file of family.files) {
    total += file.size ?? 0;
  }

  return total;
};

const refOf = (family: SessionFamily, worktree: string | null): SessionRef => ({
  channel: "session-file",
  harness: "claude-code",
  id: worktree === null ? family.path : `${family.path}#${worktree}`,
  mtimeMs: newest(family),
  path: family.path,
  sessionId: family.sessionId,
  size: totalSize(family),
  source: CLAUDE_CODE_ADAPTER_ID,
  worktree,
});

const removedRefs = (
  family: SessionFamily,
  { gone, movesInto }: RemovedFamily
): readonly SessionRef[] => {
  const splitAcross = [gone, ...movesInto];

  return movesInto.length === 0
    ? [refOf(family, gone)]
    : splitAcross.map((worktree) => ({
        ...refOf(family, worktree),
        splitAcross,
      }));
};

const sinceMillis = (since: string | null): number | null =>
  since === null
    ? null
    : Option.match(DateTime.make(since), {
        onNone: () => null,
        onSome: DateTime.toEpochMillis,
      });

const recentEnough = (family: SessionFamily, since: number | null): boolean => {
  const latest = newest(family);

  return since === null || latest === null || latest >= since;
};

const GAP_MESSAGES: readonly (readonly [keyof ScanTally, string, string])[] = [
  ["malformed", "malformed-lines", "line(s) were not JSON and were skipped"],
  [
    "unparsedAssistant",
    "unparsed-assistant-rows",
    "assistant row(s) had an unexpected shape and were skipped",
  ],
  [
    "synthetic",
    "synthetic-rows",
    "client-generated <synthetic> row(s) carry no usage and were skipped",
  ],
  [
    "apiErrors",
    "api-error-rows",
    "failed request row(s) (isApiErrorMessage) carry no usage and were skipped",
  ],
  [
    "unsettled",
    "requests-in-progress",
    "request(s) are still streaming; they are read once the session moves on or goes quiet",
  ],
  [
    "unkeyed",
    "request-key-missing",
    "assistant row(s) had no request id, message id or row id",
  ],
  ["noUsage", "usage-missing", "request(s) had no usage block"],
];

const countedGap = (
  count: number,
  code: string,
  message: string
): SourceGap[] =>
  count > 0 ? [{ code, message: `${String(count)} ${message}` }] : [];

const gapsOf = (tally: ScanTally, emitted: Emitted): SourceGap[] => [
  ...GAP_MESSAGES.flatMap(([field, code, message]) =>
    countedGap(tally[field], code, message)
  ),
  ...countedGap(
    emitted.zeroUsage,
    "zero-usage",
    "request(s) reported 0 for every token bucket and were skipped"
  ),
  ...countedGap(
    emitted.incompleteUsage,
    "request-usage-incomplete",
    "request(s) only had stream-start rows; their gross input is kept as a total, the cache split and output are unknown"
  ),
];

interface Emitted {
  readonly events: readonly DxEventEnvelope[];
  readonly incompleteUsage: number;
  readonly zeroUsage: number;
}

interface ChatAnchor {
  readonly anchor: RequestPick;
  readonly facts: SessionFacts;
  readonly placement: Placement;
}

const chatFacts = (
  placed: readonly PlacedPick[],
  titles: ReadonlyMap<string, string>
): ReadonlyMap<string, ChatAnchor> => {
  const chats = new Map<string, ChatAnchor>();

  for (const { pick, placement } of placed) {
    const seen = chats.get(pick.chat.chatId);
    const at = pick.firstTimestamp ?? pick.row.timestamp;

    if (seen === undefined) {
      chats.set(pick.chat.chatId, {
        anchor: pick,
        facts: {
          chat: pick.chat,
          cwd: pick.row.cwd,
          startedAt: at,
          title: titles.get(pick.chat.chatId) ?? null,
          version: pick.row.version,
        },
        placement,
      });
    } else if (
      at !== null &&
      (seen.facts.startedAt === null || at < seen.facts.startedAt)
    ) {
      chats.set(pick.chat.chatId, {
        ...seen,
        facts: { ...seen.facts, startedAt: at },
      });
    }
  }

  return chats;
};

const mainChat = (chatId: string): ChatInfo => ({
  agentId: null,
  agentType: null,
  chatId,
  isSidechain: false,
  parentChatId: null,
  sessionId: chatId,
});

const requestEvents = (
  placed: readonly PlacedPick[],
  input: EventInput,
  owned: (pick: RequestPick) => boolean
): Emitted => {
  const events: DxEventEnvelope[] = [];
  const turns = new Set<string>();
  let zeroUsage = 0;
  let incompleteUsage = 0;

  for (const { pick, placement } of placed) {
    const turnKey = turnKeyOf(pick);
    const firstOfTurn = !turns.has(turnKey);

    turns.add(turnKey);

    if (owned(pick)) {
      const usage = usageEvent(pick, placement, input);

      if (usage === null) {
        zeroUsage += 1;
      } else {
        events.push(usage);
        incompleteUsage += isStreamStart(pick.row) ? 1 : 0;
      }

      if (firstOfTurn) {
        events.push(turnEvent(pick, placement, input));
      }
    }
  }

  return { events, incompleteUsage, zeroUsage };
};

const untitledFacts = (chatId: string, title: string | null): SessionFacts => ({
  chat: mainChat(chatId),
  cwd: null,
  startedAt: null,
  title,
  version: null,
});

const emit = (
  placed: readonly PlacedPick[],
  scan: ReturnType<typeof scanChunks>,
  input: EventInput,
  fallback: Placement | null,
  owned: (pick: RequestPick) => boolean
): Emitted => {
  const requests = requestEvents(placed, input, owned);
  const events = [...requests.events];
  const chats = chatFacts(placed, scan.titles);

  for (const { anchor, facts, placement } of chats.values()) {
    if (owned(anchor)) {
      events.push(sessionEvent(facts, placement, input));
    }
  }

  if (fallback !== null) {
    for (const [chatId, title] of scan.titles) {
      if (!chats.has(chatId)) {
        events.push(
          sessionEvent(untitledFacts(chatId, title), fallback, input)
        );
      }
    }
  }

  for (const cost of scan.costs) {
    const known = chats.get(cost.sessionId);
    const placement = known?.placement ?? fallback;

    if (placement !== null && (known === undefined || owned(known.anchor))) {
      events.push(
        costEvent(
          known?.facts ??
            untitledFacts(
              cost.sessionId,
              scan.titles.get(cost.sessionId) ?? null
            ),
          cost.row,
          placement,
          input
        )
      );
    }
  }

  return { ...requests, events };
};

const batchOf = (
  emitted: Emitted,
  tally: ScanTally,
  cursor: EventBatch["cursor"]
): EventBatch => {
  const usage = emitted.events.filter((event) => event.kind === "ai.usage");

  const times = usage
    .flatMap((event) => (event.occurredAt === null ? [] : [event.occurredAt]))
    .toSorted();

  const degraded = tally.malformed + tally.unparsedAssistant > 0;
  const filled = degraded ? "partial" : "complete";

  return {
    coverage: {
      adapterId: CLAUDE_CODE_ADAPTER_ID,
      expectedItems: null,
      gaps: gapsOf(tally, emitted),
      observedItems: usage.length,
      state: emitted.events.length === 0 ? "none" : filled,
      watermark: times.at(-1) ?? null,
      windowFrom: times[0] ?? null,
      windowTo: times.at(-1) ?? null,
    },
    cursor,
    events: emitted.events,
  };
};

const latestVersion = (
  store: ClaudeCodeFiles,
  families: readonly SessionFamily[]
) => {
  const mains = families.flatMap((family) =>
    family.files.filter((file) => file.path === family.main)
  );

  const latest = mains
    .toSorted((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0))
    .at(0);

  if (latest === undefined) {
    return Effect.succeed(null);
  }

  return store
    .readFrom(latest.path, Math.max(0, (latest.size ?? 0) - VERSION_TAIL_BYTES))
    .pipe(
      Effect.map((bytes) => {
        const rows = splitLines(bytes, 0).complete.map((line) =>
          decodeClaudeLine(line.text)
        );

        for (const row of rows.toReversed()) {
          if (
            (row.kind === "assistant" || row.kind === "user") &&
            row.version !== null
          ) {
            return row.version;
          }
        }

        return null;
      }),
      Effect.orElseSucceed(() => null)
    );
};

export class ClaudeCodeHarness extends Context.Service<
  ClaudeCodeHarness,
  Harness
>()("dx/harness/claude-code/ClaudeCodeHarness", {
  make: Effect.gen(function* makeClaudeCodeHarness() {
    const store = yield* ClaudeCodeStore;
    const clock = yield* Clock.Clock;

    const families = Effect.all([store.roots, store.listSessions]).pipe(
      Effect.map(([roots, sessions]) => groupFamilies(roots, sessions))
    );

    const discover = Effect.gen(function* discoverClaudeCode() {
      const roots = yield* store.roots;
      const present = yield* store.present;

      const found = yield* families.pipe(
        Effect.orElseSucceed((): readonly SessionFamily[] => [])
      );

      return {
        harness: "claude-code" as const,
        present: present || found.length > 0,
        reason:
          present || found.length > 0
            ? null
            : `no Claude Code folder at ${roots.join(", ")}`,
        roots,
        sessions: found.length,
        version: yield* latestVersion(store, found),
      } satisfies Discovery;
    });

    const locate = (scope: HarnessScope) =>
      Effect.gen(function* locateClaudeCode() {
        const since = sinceMillis(scope.since);

        const recent = (yield* families).filter((family) =>
          recentEnough(family, since)
        );

        const removed = yield* removedWorktreeFamilies(store, scope, recent);

        const sessions =
          scope.worktrees.length === 0
            ? recent.map((family) => refOf(family, null))
            : recent.flatMap((family) => {
                const gone = removed.get(family.path);

                return gone === undefined
                  ? scope.worktrees
                      .filter((worktree) =>
                        slugMayHold(family.project, worktree)
                      )
                      .map((worktree) => refOf(family, worktree))
                  : removedRefs(family, gone);
              });

        return [...sessions, ...hookSpoolRefs(scope, "claude-code")];
      });

    const chunkOf = (
      file: StoredSession,
      prior: FileState | undefined,
      now: number
    ) =>
      Effect.gen(function* readChunk() {
        const offset =
          prior !== undefined && prior.offset <= (file.size ?? 0)
            ? prior.offset
            : 0;

        const bytes = yield* store.readFrom(file.path, offset);

        const quietFor =
          file.mtimeMs === null ? Number.POSITIVE_INFINITY : now - file.mtimeMs;

        const chunk: FileChunk = {
          idle: quietFor >= IDLE_MS,
          lines: splitLines(bytes, offset),
          meta: yield* metaOf(store, file.path),
          mtimeMs: file.mtimeMs,
          offset,
          path: file.path,
          quiet: quietFor >= QUIET_MS,
          size: file.size,
          turnId: offset === 0 ? null : (prior?.turnId ?? null),
        };

        return chunk;
      });

    const readFamily = (
      ref: SessionRef,
      input: ReadInput,
      files: readonly StoredSession[],
      prior: ReadonlyMap<string, FileState>
    ) =>
      Effect.gen(function* readClaudeFamily() {
        const now = clock.currentTimeMillisUnsafe();
        const kept: FileState[] = [];
        const chunks: FileChunk[] = [];

        for (const file of files) {
          const state = prior.get(file.path);

          if (
            state !== undefined &&
            isUnchanged(state, file.mtimeMs, file.size)
          ) {
            kept.push(state);
          } else {
            chunks.push(yield* chunkOf(file, state, now));
          }
        }

        const scan = scanChunks(chunks);

        const picked = yield* placePicks(
          ref.worktree,
          input.context,
          scan.requests,
          store.isRepoRoot
        );

        return { kept, picked, scan };
      });

    const readSession = (ref: SessionRef, input: ReadInput) =>
      Effect.gen(function* readClaudeSession() {
        const files = yield* store.listFamily(ref.path);
        const prior = readSessionCursor(input.cursor, ref.id);

        const scoped =
          ref.worktree === null || isOwnFolderFamily(ref.path, ref.worktree)
            ? null
            : ref.worktree;

        const first = yield* readFamily(
          ref,
          input,
          files,
          scoped !== null && prior.pointsIn === null ? new Map() : prior.files
        );

        const pointsIn =
          scoped === null ||
          prior.pointsIn === true ||
          anyPointsIntoWorktree(scoped, store.home, first.picked);

        const { kept, picked, scan } =
          pointsIn && prior.pointsIn === false && prior.files.size > 0
            ? yield* readFamily(ref, input, files, new Map())
            : first;

        const owned = ownedBy(ref.worktree, ref.splitAcross);
        const placed = pointsIn ? picked : [];

        const observedAt = DateTime.formatIso(yield* DateTime.now);

        const fallback: Placement | null =
          ref.worktree === null
            ? { branchSource: "cwd-inferred", context: input.context }
            : null;

        const emitted = emit(
          placed,
          scan,
          { home: store.home, observedAt, origin: input.origin },
          fallback,
          owned
        );

        return {
          ...batchOf(
            emitted,
            scan.tally,
            sessionCursorOf(ref.id, [...kept, ...scan.states], pointsIn)
          ),
          unsettled: scan.states.some((state) => state.pending),
        };
      });

    const read = (ref: SessionRef, input: ReadInput) =>
      ref.channel === "hooks"
        ? Effect.sync(() =>
            readHookSpool(ref, claudeCodeHookDecoder, input.origin)
          )
        : readSession(ref, input);

    return {
      capabilities: {
        branchSources: [
          "harness-recorded",
          "hook",
          "git-at-time",
          "cwd-inferred",
          "tool-calls",
          "subagent-split",
          "unassigned",
        ],
        liveHooks: true,
        storedFigure: "api-equivalent",
        subagents: true,
      },
      channels: CLAUDE_CODE_CHANNELS,
      discover,
      displayName: "Claude Code",
      id: "claude-code",
      locate,
      read,
    } satisfies Harness;
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);

  static readonly mock = Layer.effect(this, this.make).pipe(
    Layer.provide(ClaudeCodeStore.memory({ files: [], roots: [] }))
  );
}
