import {
  Clock,
  Context,
  DateTime,
  Effect,
  Layer,
  Option,
  Schema,
} from "effect";

import type { CoverageState, SourceGap } from "../../model/coverage.js";
import type { DxEventEnvelope, EventBatch } from "../../model/event.js";
import { FileCursorSchema, unchangedSince } from "../contract.js";
import type {
  Discovery,
  Harness,
  HarnessScope,
  ReadInput,
  SessionRef,
} from "../contract.js";
import { hookSpoolRefs, readHookSpool } from "../hook-spool.js";
import { titleUnlessPrompt } from "../title.js";
import {
  CODEX_ADAPTER_ID,
  sessionEvent,
  turnEvent,
  usageEvent,
} from "./events.js";
import type { EventInput } from "./events.js";
import type { CodexHead } from "./head.js";
import { codexHookDecoder } from "./hook.js";
import { CODEX_CHANNELS } from "./meta.js";
import { ScanStateSchema, initialScanState, scanSession } from "./parse.js";
import type { ScanResult, ScanState } from "./parse.js";
import { within } from "./place.js";
import { canonicalCopies, codexHeads, titlesOf } from "./sessions.js";
import type { LocatedSession } from "./sessions.js";
import { CodexStore } from "./store.js";

export const CodexCursorSchema = Schema.Struct({
  ...FileCursorSchema.fields,
  state: ScanStateSchema,
});

export type CodexCursor = typeof CodexCursorSchema.Type;

const decodeCursor = Schema.decodeUnknownOption(
  Schema.fromJsonString(CodexCursorSchema)
);

const encodeCursor = Schema.encodeSync(
  Schema.fromJsonString(CodexCursorSchema)
);

const cursorFor = (input: ReadInput, ref: SessionRef): CodexCursor | null => {
  if (input.cursor === null || input.cursor.adapterId !== CODEX_ADAPTER_ID) {
    return null;
  }

  return Option.match(decodeCursor(input.cursor.value), {
    onNone: () => null,
    onSome: (cursor) => (cursor.path === ref.path ? cursor : null),
  });
};

const basename = (file: string): string => file.split("/").at(-1) ?? file;

const coverageGaps = (result: ScanResult): SourceGap[] => {
  const gaps: SourceGap[] = [
    {
      code: "cost-unavailable",
      message: "Codex session files carry tokens only; no charge or price.",
    },
  ];

  if (result.requests.some((request) => request.source === "token_count")) {
    gaps.push({
      code: "legacy-token-count",
      message:
        "Part of this session predates per-response usage records; requests come from token_count deltas.",
    });
  }

  if (result.counts.malformedLines > 0) {
    gaps.push({
      code: "malformed-lines",
      message: `${String(result.counts.malformedLines)} line(s) could not be read and were skipped.`,
    });
  }

  if (result.state.head === null) {
    gaps.push({
      code: "missing-session-meta",
      message: "No session_meta line; the session cannot be attributed.",
    });
  }

  return gaps;
};

const coverageState = (result: ScanResult, events: number): CoverageState => {
  if (result.state.head === null) {
    return "none";
  }

  if (result.counts.malformedLines > 0) {
    return "partial";
  }

  return events === 0 && result.requests.length === 0 ? "none" : "complete";
};

const batchOf = (
  result: ScanResult,
  events: readonly DxEventEnvelope[],
  cursor: CodexCursor
): EventBatch => ({
  coverage: {
    adapterId: CODEX_ADAPTER_ID,
    expectedItems: null,
    gaps: coverageGaps(result),
    observedItems: events.length,
    state: coverageState(result, events.length),
    watermark: result.lastTimestamp,
    windowFrom: result.firstTimestamp,
    windowTo: result.lastTimestamp,
  },
  cursor: { adapterId: CODEX_ADAPTER_ID, value: encodeCursor(cursor) },
  events,
});

const unchangedBatch = (input: ReadInput): EventBatch => ({
  coverage: {
    adapterId: CODEX_ADAPTER_ID,
    expectedItems: null,
    gaps: [],
    observedItems: 0,
    state: "complete",
    watermark: null,
    windowFrom: null,
    windowTo: null,
  },
  cursor: input.cursor,
  events: [],
});

const refOf = (
  located: LocatedSession,
  worktree: string | null
): SessionRef => ({
  channel: "session-file",
  harness: "codex",
  id:
    worktree === null
      ? located.session.path
      : `${located.session.path}#${worktree}`,
  mtimeMs: located.session.mtimeMs,
  path: located.session.path,
  sessionId: located.threadId,
  size: located.session.size,
  source: CODEX_ADAPTER_ID,
  worktree,
});

const sinceMillis = (since: string | null): number | null => {
  if (since === null) {
    return null;
  }

  const parsed = Date.parse(since);

  return Number.isNaN(parsed) ? null : parsed;
};

const placeInScope = (
  scope: HarnessScope,
  located: LocatedSession
): readonly SessionRef[] => {
  if (scope.worktrees.length === 0) {
    return [refOf(located, null)];
  }

  const cwd = located.location?.cwd ?? null;

  const worktree =
    scope.worktrees
      .filter((candidate) => within(cwd, candidate))
      .toSorted((a, b) => b.length - a.length)
      .at(0) ?? null;

  return worktree === null ? [] : [refOf(located, worktree)];
};

const removedWorktreeOf = (
  scope: HarnessScope,
  located: LocatedSession
): string | null => {
  const cwd = located.location?.cwd ?? null;

  return scope.removed !== undefined &&
    scope.worktrees.length > 0 &&
    cwd !== null &&
    scope.removed.gone(cwd)
    ? cwd
    : null;
};

const makeCodexHarness = Effect.gen(function* makeCodexHarness() {
  const store = yield* CodexStore;
  const heads = codexHeads(store);
  const threadPaths = new Map<string, string>();

  const remember = (sessions: readonly LocatedSession[]) => {
    for (const located of sessions) {
      if (located.location !== null) {
        threadPaths.set(located.location.threadId, located.session.path);
      }
    }
  };

  const located = heads.locateAll.pipe(
    Effect.tap((sessions) =>
      Effect.sync(() => {
        remember(sessions);
      })
    )
  );

  const discover: Effect.Effect<Discovery> = Effect.gen(
    function* discoverCodex() {
      const roots = yield* store.roots;

      const sessions = yield* store.listSessions.pipe(
        Effect.orElseSucceed(() => [])
      );

      const newest = sessions
        .toSorted((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0))
        .at(0);

      const head =
        newest === undefined
          ? null
          : yield* heads
              .readHead(newest.path)
              .pipe(Effect.orElseSucceed(() => null));

      return {
        harness: "codex",
        present: sessions.length > 0,
        reason:
          sessions.length > 0
            ? null
            : `no Codex sessions under ${roots.join(", ")}`,
        roots,
        sessions: sessions.length,
        version: head?.cliVersion ?? (yield* store.version),
      };
    }
  );

  const locate = (scope: HarnessScope) =>
    Effect.gen(function* locateCodex() {
      const since = sinceMillis(scope.since);
      const all = yield* located;

      const recent = all.filter(
        (session) =>
          since === null ||
          session.session.mtimeMs === null ||
          session.session.mtimeMs >= since
      );

      const sessions = yield* Effect.forEach(
        canonicalCopies(recent),
        (session) => {
          const placed = placeInScope(scope, session);
          const removed = removedWorktreeOf(scope, session);

          return placed.length > 0 || removed === null
            ? Effect.succeed(placed)
            : Effect.map(
                heads
                  .readHead(session.session.path)
                  .pipe(Effect.orElseSucceed(() => null)),
                (head) =>
                  head?.commit !== null &&
                  head?.commit !== undefined &&
                  scope.removed?.knowsCommit(head.commit) === true
                    ? [refOf(session, removed)]
                    : []
              );
        }
      );

      return [...sessions.flat(), ...hookSpoolRefs(scope, "codex")];
    });

  const parentOf = (head: CodexHead) =>
    Effect.gen(function* parentHead() {
      if (head.parentId === null || head.branch !== null) {
        return null;
      }

      if (threadPaths.size === 0) {
        yield* located.pipe(Effect.ignore);
      }

      const file = threadPaths.get(head.parentId);

      return file === undefined
        ? null
        : yield* heads.readHead(file).pipe(Effect.orElseSucceed(() => null));
    });

  const readSession = (ref: SessionRef, input: ReadInput) =>
    Effect.gen(function* readCodexSession() {
      const prior = cursorFor(input, ref);

      if (prior !== null && unchangedSince(prior, ref)) {
        return unchangedBatch(input);
      }

      const resume =
        prior !== null && (ref.size === null || prior.offset <= ref.size)
          ? prior
          : null;

      const state: ScanState = resume?.state ?? initialScanState;
      const offset = resume?.offset ?? 0;

      const bytes =
        offset === 0
          ? yield* store.readBytes(ref.path)
          : yield* store.readFrom(ref.path, offset);

      const result = scanSession(bytes, state);
      const { head } = result.state;

      const cursor: CodexCursor = {
        mtimeMs: ref.mtimeMs,
        offset: offset + result.consumed,
        path: ref.path,
        size: ref.size,
        state: result.state,
      };

      if (head === null) {
        return batchOf(result, [], cursor);
      }

      const titles = titlesOf(yield* store.sessionIndex);

      const now = DateTime.formatIso(
        DateTime.makeUnsafe(yield* Clock.currentTimeMillis)
      );

      const eventInput: EventInput = {
        evidenceName: basename(ref.path),
        head,
        home: store.home,
        observedAt: now,
        origin: input.origin,
        parent: yield* parentOf(head),
        selected: input.context,
        title: titleUnlessPrompt(
          titles.get(head.threadId) ?? null,
          result.state.prompts
        ),
      };

      const firstFacts =
        result.endedTurns.at(0)?.facts ??
        result.requests.at(0)?.facts ??
        result.state.facts;

      const events = [
        sessionEvent(eventInput, firstFacts),
        ...result.endedTurns.map((turn) => turnEvent(eventInput, turn)),
        ...result.requests.map((request) => usageEvent(eventInput, request)),
      ];

      return batchOf(result, events, cursor);
    });

  const read = (ref: SessionRef, input: ReadInput) =>
    ref.channel === "hooks"
      ? Effect.sync(() => readHookSpool(ref, codexHookDecoder, input.origin))
      : readSession(ref, input);

  const harness: Harness = {
    capabilities: {
      branchSources: [
        "session-recorded",
        "hook",
        "git-at-time",
        "cwd-inferred",
        "unassigned",
      ],
      liveHooks: true,
      storedFigure: null,
      subagents: true,
    },
    channels: CODEX_CHANNELS,
    discover,
    displayName: "Codex",
    id: "codex",
    locate,
    read,
  };

  return harness;
});

export class CodexHarness extends Context.Service<CodexHarness, Harness>()(
  "dx/harness/codex/CodexHarness",
  { make: makeCodexHarness }
) {
  static readonly layer = Layer.effect(this, this.make);

  static readonly mock = Layer.effect(this, this.make).pipe(
    Layer.provide(CodexStore.memory({ files: [], roots: [] }))
  );
}
