import { Context, Effect, Layer } from "effect";

import type { SourceGap } from "../../model/coverage.js";
import type { DxEventEnvelope, EventBatch } from "../../model/event.js";
import type {
  Discovery,
  Harness,
  HarnessScope,
  ReadInput,
  SessionRef,
} from "../contract.js";
import { fileCursorOf, readFileCursor, unchangedSince } from "../contract.js";
import { GitRunner, notARepo } from "../git.js";
import type { GitAt } from "../git.js";
import { hookSpoolRefs, readHookSpool } from "../hook-spool.js";
import { harnessAdapterId } from "../pending.js";
import { isoOf, sessionEvents } from "./events.js";
import { opencodeHookDecoder } from "./hook.js";
import { OPENCODE_CHANNELS } from "./meta.js";
import { placeSessions, toolPathsToResolve } from "./placement.js";
import type { Placement } from "./placement.js";
import { decodeRows } from "./rows.js";
import type { OcRows } from "./rows.js";
import { viewSessions } from "./sessions.js";
import type { OcSessionView } from "./sessions.js";
import {
  BodyRowSchema,
  CountRowSchema,
  SCHEMA_SQL,
  SchemaRowSchema,
  countSql,
  readSql,
  tableColumns,
} from "./sql.js";
import { OpencodeStore } from "./store.js";

const ADAPTER_ID = harnessAdapterId("opencode");

const GIT_CONCURRENCY = 8;

const within = (child: string, parent: string): boolean => {
  const base = parent.replace(/\/+$/u, "");

  return child === base || child.startsWith(`${base}/`);
};

const inWorktree = (event: DxEventEnvelope, worktree: string | null) =>
  worktree === null ||
  (event.context.worktreePath !== null &&
    within(event.context.worktreePath, worktree));

const latestUpdate = (rows: OcRows): number | null => {
  const times = [
    ...rows.sessions.map((session) => session.updated),
    ...rows.messages.map((message) => message.updated),
  ];

  return times.length === 0 ? null : Math.max(...times);
};

const gapsOf = (rows: OcRows, views: readonly OcSessionView[]): SourceGap[] => {
  const gaps: SourceGap[] = [
    {
      code: "no-branch-recorded",
      message:
        "OpenCode records only the folder of a session, never the branch; the branch comes from git for that folder and is refined by checkout history",
    },
  ];

  if (rows.failures > 0) {
    gaps.push({
      code: "rows-not-decoded",
      message: `${rows.failures} OpenCode row(s) did not match the expected shape and were skipped`,
    });
  }

  const inFlight = views.reduce((sum, view) => sum + view.inFlight, 0);

  if (inFlight > 0) {
    gaps.push({
      code: "requests-in-flight",
      message: `${inFlight} request(s) have no result yet; they are read once OpenCode stores one, and requests abandoned mid-stream never carried tokens`,
    });
  }

  const over = views.filter((view) => view.overcount !== null).length;

  if (over > 0) {
    gaps.push({
      code: "messages-exceed-session-total",
      message: `${over} session(s) store more message tokens than their session total; the messages are kept`,
    });
  }

  return gaps;
};

export class OpencodeHarness extends Context.Service<
  OpencodeHarness,
  Harness
>()("dx/harness/opencode/OpencodeHarness", {
  make: Effect.gen(function* makeOpencodeHarness() {
    const store = yield* OpencodeStore;
    const git = yield* GitRunner;

    const readRows = Effect.fnUntraced(function* readRows(dbPath: string) {
      const tables = tableColumns(
        yield* store.query(dbPath, SCHEMA_SQL, SchemaRowSchema)
      );

      const sql = readSql(tables);

      if (sql === null) {
        return decodeRows([]);
      }

      return decodeRows(yield* store.query(dbPath, sql, BodyRowSchema));
    });

    const countSessions = Effect.fnUntraced(function* countSessions(
      dbPath: string
    ) {
      const tables = tableColumns(
        yield* store.query(dbPath, SCHEMA_SQL, SchemaRowSchema)
      );

      const sql = countSql(tables);

      if (sql === null) {
        return 0;
      }

      const [row] = yield* store.query(dbPath, sql, CountRowSchema);

      return row?.sessions ?? 0;
    });

    const resolveInto = Effect.fnUntraced(function* resolveInto(
      cache: Map<string, GitAt>,
      paths: readonly string[]
    ) {
      const missing = [...new Set(paths)].filter((path) => !cache.has(path));

      // oxlint-disable-next-line unicorn/no-array-method-this-argument -- Effect.forEach takes an options object, not a thisArg.
      const resolveAll = Effect.forEach((path: string) => git.at(path), {
        concurrency: GIT_CONCURRENCY,
      });

      const found = yield* resolveAll(missing);

      for (const [index, path] of missing.entries()) {
        cache.set(path, found[index] ?? notARepo);
      }
    });

    const discover = Effect.gen(function* discoverOpencode() {
      const roots = yield* store.roots;

      const databases = yield* store.listSessions.pipe(
        Effect.orElseSucceed(() => [])
      );

      const counts = yield* Effect.forEach((db: { readonly path: string }) =>
        countSessions(db.path).pipe(Effect.orElseSucceed(() => 0))
      )(databases);

      const discovery: Discovery = {
        harness: "opencode",
        present: databases.length > 0,
        reason:
          databases.length > 0
            ? null
            : `no OpenCode database in ${roots.join(", ")}`,
        roots,
        sessions: counts.reduce((sum, count) => sum + count, 0),
        version: yield* store.version,
      };

      return discovery;
    });

    const locate = (scope: HarnessScope) =>
      Effect.gen(function* locateOpencode() {
        const databases = yield* store.listSessions;

        const worktrees: readonly (string | null)[] =
          scope.worktrees.length === 0 ? [null] : scope.worktrees;

        const dbRefs = databases.flatMap((db) =>
          worktrees.map((worktree): SessionRef => ({
            channel: "local-db",
            harness: "opencode",
            id: worktree === null ? db.path : `${db.path}#${worktree}`,
            mtimeMs: db.mtimeMs,
            path: db.path,
            sessionId: null,
            size: db.size,
            source: ADAPTER_ID,
            worktree,
          }))
        );

        return [...dbRefs, ...hookSpoolRefs(scope, "opencode", "extension")];
      });

    const readDatabase = (ref: SessionRef, input: ReadInput) =>
      Effect.gen(function* readOpencodeDb() {
        const previous = readFileCursor(input.cursor, ref);

        if (unchangedSince(previous, ref)) {
          const batch: EventBatch = {
            coverage: {
              adapterId: ADAPTER_ID,
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
          };

          return batch;
        }

        const rows = yield* readRows(ref.path);
        const views = viewSessions(rows);
        const cache = new Map<string, GitAt>();
        const lookup = (path: string) => cache.get(path) ?? notARepo;

        yield* resolveInto(
          cache,
          views.flatMap((view) => [
            view.cwd,
            ...view.requests.map((request) => request.cwd),
            ...view.turns.map((turn) => turn.cwd),
          ])
        );

        yield* resolveInto(cache, toolPathsToResolve(views, lookup));

        const placements = placeSessions(views, lookup);
        const since = previous === null ? null : previous.offset;

        const events = views.flatMap((view) => {
          const placement = placements.get(view.session.id);

          if (placement === undefined) {
            return [];
          }

          const turnPlacement = (turn: OcSessionView["turns"][number]) => {
            const own = lookup(turn.cwd);

            if (own.worktreePath !== null) {
              const placed: Placement = {
                branchSource:
                  own.branch === null ? "unassigned" : "cwd-inferred",
                git: own,
                share: 1,
              };

              return placed;
            }

            const request = view.requests.find(
              (candidate) => candidate.turnId === turn.id
            );

            const placed =
              request === undefined
                ? undefined
                : placement.requests.get(request.message.id)?.[0];

            return placed ?? placement.session;
          };

          return sessionEvents({
            ctx: { context: input.context, origin: input.origin },
            placement,
            since,
            turnPlacement,
            view,
          });
        });

        const kept = events.filter((event) => inWorktree(event, ref.worktree));
        const watermark = latestUpdate(rows);

        const times = kept
          .flatMap((event) =>
            event.occurredAt === null ? [] : [event.occurredAt]
          )
          .toSorted();

        const gaps = gapsOf(rows, views);

        const batch: EventBatch = {
          coverage: {
            adapterId: ADAPTER_ID,
            expectedItems: null,
            gaps,
            observedItems: kept.length,
            state: rows.failures > 0 ? "partial" : "complete",
            watermark: watermark === null ? null : isoOf(watermark),
            windowFrom: times[0] ?? null,
            windowTo: times.at(-1) ?? null,
          },
          cursor: fileCursorOf(ADAPTER_ID, {
            mtimeMs: ref.mtimeMs,
            offset: watermark ?? 0,
            path: ref.path,
            size: ref.size,
          }),
          events: kept,
        };

        return batch;
      });

    const read = (ref: SessionRef, input: ReadInput) =>
      ref.channel === "extension" || ref.channel === "hooks"
        ? Effect.sync(() =>
            readHookSpool(ref, opencodeHookDecoder, input.origin)
          )
        : readDatabase(ref, input);

    const harness: Harness = {
      capabilities: {
        branchSources: [
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
      channels: OPENCODE_CHANNELS,
      discover,
      displayName: "OpenCode",
      id: "opencode",
      locate,
      read,
    };

    return harness;
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);

  static readonly mock = Layer.effect(this, this.make).pipe(
    Layer.provide(OpencodeStore.memory({ files: [], roots: [] })),
    Layer.provide(GitRunner.memory([]))
  );
}
