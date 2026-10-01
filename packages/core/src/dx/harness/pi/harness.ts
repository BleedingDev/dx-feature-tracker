import { Context, DateTime, Effect, Layer, Path } from "effect";

import type { SourceGap } from "../../model/coverage.js";
import type {
  DxEventEnvelope,
  EventBatch,
  FlightContext,
} from "../../model/event.js";
import { fileCursorOf, readFileCursor, unchangedSince } from "../contract.js";
import type {
  FileCursor,
  Harness,
  HarnessScope,
  ReadInput,
  SessionRef,
  StoredSession,
} from "../contract.js";
import type { GitAt } from "../git.js";
import { GitRunner } from "../git.js";
import { hookSpoolRefs, readHookSpool } from "../hook-spool.js";
import { headerOf, parsePiFile } from "./entries.js";
import type { PiEntry, PiFile } from "./entries.js";
import {
  PI_ADAPTER_ID,
  requestEvent,
  sessionEvent,
  turnEvent,
} from "./events.js";
import type { PiPlace, PiPlaceQuery, PiSessionFacts } from "./events.js";
import { piHookDecoder } from "./hook.js";
import { PI_CHANNELS } from "./meta.js";
import { localProvidersOf } from "./models.js";
import { entryKeysOf, readPiSession } from "./requests.js";
import type { PiAgent, PiRequest, PiSessionReading } from "./requests.js";
import { PiStore, sessionDirSetting } from "./store.js";
import type { PiSessionStore } from "./store.js";

const MAX_TOOL_PATHS = 48;

const SUBAGENT_FILE = /^(?<stem>.+_d\d+_c\d+)\.jsonl$/u;

const unassignedPlace: PiPlace = {
  branchSource: "unassigned",
  context: {
    branch: null,
    flightId: null,
    headSha: null,
    repoCommonDir: null,
    worktreePath: null,
  },
};

const trimmed = (dir: string): string => dir.replace(/\/+$/u, "");

export const isInside = (child: string | null, parent: string): boolean =>
  child !== null &&
  (trimmed(child) === trimmed(parent) ||
    trimmed(child).startsWith(`${trimmed(parent)}/`));

export const sessionIdOfFile = (file: string): string | null => {
  const name = file.split("/").at(-1) ?? "";
  const stem = name.replace(/\.jsonl$/u, "");
  const cut = stem.indexOf("_");

  if (stem === "") {
    return null;
  }

  return cut === -1 ? stem : stem.slice(cut + 1);
};

const fileAgentOf = (file: string): PiAgent | null => {
  const stem = SUBAGENT_FILE.exec(file.split("/").at(-1) ?? "")?.groups?.stem;

  return stem === undefined ? null : { cwd: null, id: stem, type: "ypi" };
};

const placeOfGit = (git: GitAt, source: PiPlace["branchSource"]): PiPlace =>
  git.worktreePath === null
    ? unassignedPlace
    : {
        branchSource: git.branch === null ? "unassigned" : source,
        context: {
          branch: git.branch,
          flightId: null,
          headSha: null,
          repoCommonDir: git.repoCommonDir,
          worktreePath: git.worktreePath,
        },
      };

const placeOfContext = (context: FlightContext): PiPlace => ({
  branchSource: context.branch === null ? "unassigned" : "cwd-inferred",
  context,
});

const emptyBatch = (
  cursor: EventBatch["cursor"],
  gaps: readonly SourceGap[]
): EventBatch => ({
  coverage: {
    adapterId: PI_ADAPTER_ID,
    expectedItems: 0,
    gaps,
    observedItems: 0,
    state: "none",
    watermark: null,
    windowFrom: null,
    windowTo: null,
  },
  cursor,
  events: [],
});

const firstAgentRequests = (
  requests: readonly PiRequest[]
): ReadonlyMap<string, PiRequest> => {
  const byAgent = new Map<string, PiRequest>();

  for (const request of requests) {
    if (request.agent !== null && !byAgent.has(request.agent.id)) {
      byAgent.set(request.agent.id, request);
    }
  }

  return byAgent;
};

interface Opening {
  readonly at: string | null;
  readonly effort: string | null;
  readonly modelRaw: string | null;
  readonly piProvider: string | null;
}

const openingOf = (
  reading: PiSessionReading,
  own: readonly PiRequest[],
  header: PiEntry
): Opening => {
  const [firstTurn] = reading.turns;

  if (firstTurn !== undefined) {
    return firstTurn;
  }

  return (
    own.find((request) => request.kind === "assistant") ?? {
      at: null,
      effort: header.thinkingLevel ?? null,
      modelRaw: header.modelId ?? null,
      piProvider: header.provider ?? null,
    }
  );
};

const sessionEventsOf = (
  facts: PiSessionFacts,
  reading: PiSessionReading,
  header: PiEntry
): readonly DxEventEnvelope[] => {
  const own = reading.requests.filter((request) => request.agent === null);
  const opening = openingOf(reading, own, header);

  const main = sessionEvent(facts, {
    ...opening,
    agent: null,
    requests: own.length,
    title: reading.title,
    turns: reading.turns.length,
  });

  const agents = [...firstAgentRequests(reading.requests).values()].map(
    (request) =>
      sessionEvent(facts, {
        agent: request.agent,
        at: request.at,
        effort: request.effort,
        modelRaw: request.responseModel ?? request.modelRaw,
        piProvider: request.piProvider,
        requests: reading.requests.filter(
          (other) => other.agent?.id === request.agent?.id
        ).length,
        title: request.agent?.type ?? null,
        turns: 0,
      })
  );

  return [main, ...agents];
};

const parentSessionIdOf = (
  header: PiEntry,
  parentFile: PiFile | null
): string | null => {
  const parentPath = header.parentSession ?? null;

  return parentPath === null
    ? null
    : (parentFile?.header?.id ?? sessionIdOfFile(parentPath));
};

const gapsOf = (
  ref: SessionRef,
  file: PiFile,
  parentFile: PiFile | null
): readonly SourceGap[] => {
  const parentPath = file.header?.parentSession ?? null;

  const malformed: readonly SourceGap[] =
    file.malformed > 0
      ? [
          {
            code: "malformed-lines",
            message: `${String(file.malformed)} line(s) of ${ref.path} are not valid Pi entries and were skipped`,
          },
        ]
      : [];

  const orphan: readonly SourceGap[] =
    parentPath !== null && parentFile === null
      ? [
          {
            code: "parent-session-missing",
            message: `the session this one was forked from (${parentPath}) is gone; its copied entries are kept and carry the parent's request keys`,
          },
        ]
      : [];

  return [...malformed, ...orphan];
};

const windowOf = (events: readonly DxEventEnvelope[]) => {
  const times = events
    .flatMap((event) => (event.occurredAt === null ? [] : [event.occurredAt]))
    .toSorted();

  return { from: times.at(0) ?? null, to: times.at(-1) ?? null };
};

export class PiHarness extends Context.Service<PiHarness, Harness>()(
  "dx/harness/pi/PiHarness",
  {
    make: Effect.gen(function* makePiHarness() {
      const store: PiSessionStore = yield* PiStore;
      const git = yield* GitRunner;
      const path = yield* Path.Path;

      const projectRoot = (worktree: string) =>
        store.readOptional(path.join(worktree, ".pi", "settings.json")).pipe(
          Effect.map((text) => {
            const dir = sessionDirSetting(text);

            return dir === null ? [] : [path.resolve(worktree, dir)];
          })
        );

      const projectRoots = (worktrees: readonly string[]) =>
        Effect.forEach(projectRoot)(worktrees).pipe(
          Effect.map((lists) => lists.flat())
        );

      const sessionsAt = (root: string) =>
        store.sessionsUnder(root).pipe(Effect.orElseSucceed(() => []));

      const allSessions = (worktrees: readonly string[]) =>
        Effect.gen(function* listAll() {
          const listed = yield* store.listSessions;
          const extra = yield* projectRoots(worktrees);

          const more = yield* Effect.forEach(sessionsAt)(extra);

          const seen = new Set(listed.map((session) => session.path));

          return [
            ...listed,
            ...more.flat().filter((session) => !seen.has(session.path)),
          ];
        });

      const discover = Effect.gen(function* discoverPi() {
        const roots = yield* store.roots;

        const sessions = yield* store.listSessions.pipe(
          Effect.orElseSucceed(() => [])
        );

        const present = sessions.length > 0;

        return {
          harness: "pi" as const,
          present,
          reason: present
            ? null
            : `no Pi sessions under ${roots.join(", ") || "any folder"}`,
          roots,
          sessions: sessions.length,
          version: yield* store.version,
        };
      });

      const worktreeOf = (
        cwd: string | null,
        worktrees: readonly string[]
      ): string | null =>
        worktrees
          .filter((worktree) => isInside(cwd, worktree))
          .toSorted((a, b) => b.length - a.length)[0] ?? null;

      const mentioned = (file: string, worktrees: readonly string[]) =>
        store.readText(file).pipe(
          Effect.map(
            (text) =>
              worktrees.find(
                (worktree) =>
                  text.includes(`"${trimmed(worktree)}/`) ||
                  text.includes(`"${trimmed(worktree)}"`)
              ) ?? null
          ),
          Effect.orElseSucceed(() => null)
        );

      const locate = (scope: HarnessScope) =>
        Effect.gen(function* locatePi() {
          const sessions = yield* allSessions(scope.worktrees);
          const since = scope.since === null ? null : Date.parse(scope.since);

          const fresh = sessions.filter(
            (session) =>
              since === null ||
              Number.isNaN(since) ||
              session.mtimeMs === null ||
              session.mtimeMs >= since
          );

          const refOf = (session: StoredSession) =>
            Effect.gen(function* refOfSession() {
              const head = yield* store
                .readHead(session.path)
                .pipe(Effect.orElseSucceed(() => ""));

              const header = headerOf(head);
              const cwd = header?.cwd ?? null;

              const worktree =
                scope.worktrees.length === 0
                  ? null
                  : (worktreeOf(cwd, scope.worktrees) ??
                    (yield* mentioned(session.path, scope.worktrees)));

              if (scope.worktrees.length > 0 && worktree === null) {
                return [];
              }

              const ref: SessionRef = {
                channel: "session-file",
                harness: "pi",
                id:
                  worktree === null
                    ? session.path
                    : `${session.path}#${worktree}`,
                mtimeMs: session.mtimeMs,
                path: session.path,
                sessionId: header?.id ?? sessionIdOfFile(session.path),
                size: session.size,
                source: PI_ADAPTER_ID,
                worktree,
              };

              return [ref];
            });

          const refs = yield* Effect.forEach(refOf)(fresh);

          return [...refs.flat(), ...hookSpoolRefs(scope, "pi", "extension")];
        });

      const parentFileOf = (header: PiEntry) =>
        Effect.gen(function* parentFile() {
          const parentPath = header.parentSession ?? null;

          if (parentPath === null) {
            return null;
          }

          const direct = yield* store
            .readText(parentPath)
            .pipe(Effect.orElseSucceed((): string | null => null));

          if (direct !== null) {
            return direct;
          }

          const name = parentPath.split("/").at(-1) ?? "";

          const listed = yield* store.listSessions.pipe(
            Effect.orElseSucceed(() => [])
          );

          const match = listed.find((session) =>
            session.path.endsWith(`/${name}`)
          );

          return match === undefined
            ? null
            : yield* store
                .readText(match.path)
                .pipe(Effect.orElseSucceed((): string | null => null));
        });

      const cachedGit = () => {
        const cache = new Map<string, GitAt>();

        const at = (dir: string) => {
          const cached = cache.get(dir);

          return cached === undefined
            ? git.at(dir).pipe(
                Effect.tap((found) =>
                  Effect.sync(() => {
                    cache.set(dir, found);
                  })
                )
              )
            : Effect.succeed(cached);
        };

        const ofPath = (candidate: string) =>
          at(candidate).pipe(
            Effect.flatMap((found) =>
              found.worktreePath === null
                ? at(path.dirname(candidate))
                : Effect.succeed(found)
            )
          );

        return { at, ofPath };
      };

      const placesFor = (
        file: PiFile,
        reading: PiSessionReading,
        input: ReadInput
      ) =>
        Effect.gen(function* resolvePlaces() {
          const { at: gitAt, ofPath: gitOfPath } = cachedGit();
          const cwd = file.header?.cwd ?? null;

          const cwds = [
            ...new Set([
              ...(cwd === null ? [] : [cwd]),
              ...reading.requests.flatMap((request) =>
                request.agent?.cwd === undefined || request.agent.cwd === null
                  ? []
                  : [request.agent.cwd]
              ),
            ]),
          ];

          const known = input.context.worktreePath;
          const byCwd = new Map<string, PiPlace>();

          for (const dir of cwds) {
            byCwd.set(
              dir,
              known !== null && isInside(dir, known)
                ? placeOfContext(input.context)
                : placeOfGit(yield* gitAt(dir), "cwd-inferred")
            );
          }

          const sessionPlace =
            cwd === null
              ? unassignedPlace
              : (byCwd.get(cwd) ?? unassignedPlace);

          const byTurn = new Map<string, PiPlace>();

          if (sessionPlace.context.worktreePath === null) {
            const candidates = [
              ...new Set(
                [...reading.toolPaths.values()]
                  .flat()
                  .map((raw) => path.resolve(cwd ?? "/", raw))
              ),
            ].slice(0, MAX_TOOL_PATHS);

            const resolved = new Map<string, GitAt>();

            for (const candidate of candidates) {
              resolved.set(candidate, yield* gitOfPath(candidate));
            }

            for (const [turnId, raws] of reading.toolPaths) {
              const repos = new Map<string, GitAt>();

              for (const raw of raws) {
                const found = resolved.get(path.resolve(cwd ?? "/", raw));

                if (
                  found?.worktreePath !== undefined &&
                  found.worktreePath !== null
                ) {
                  repos.set(found.worktreePath, found);
                }
              }

              const [only] = [...repos.values()];

              if (repos.size === 1 && only !== undefined) {
                byTurn.set(turnId, placeOfGit(only, "tool-calls"));
              }
            }
          }

          return (query: PiPlaceQuery): PiPlace => {
            if (query.cwd !== null && query.cwd !== cwd) {
              return byCwd.get(query.cwd) ?? unassignedPlace;
            }

            const turnPlace =
              query.turnId === null ? undefined : byTurn.get(query.turnId);

            return turnPlace ?? sessionPlace;
          };
        });

      const readSession = (ref: SessionRef, input: ReadInput) =>
        Effect.gen(function* readPiFile() {
          const cursor = readFileCursor(input.cursor, ref);

          if (unchangedSince(cursor, ref)) {
            return emptyBatch(input.cursor, []);
          }

          const text = yield* store.readText(ref.path);
          const file = parsePiFile(text);
          const { header } = file;

          if (header === null) {
            return emptyBatch(null, [
              {
                code: "no-session-header",
                message: `${ref.path} has no Pi session header`,
              },
            ]);
          }

          const parentText = yield* parentFileOf(header);

          const parentFile =
            parentText === null ? null : parsePiFile(parentText);

          const reading = readPiSession(
            file,
            parentFile === null ? new Set() : entryKeysOf(parentFile)
          );

          const models =
            store.agentDir === null
              ? null
              : yield* store.readOptional(
                  path.join(store.agentDir, "models.json")
                );

          const placeOf = yield* placesFor(file, reading, input);
          const now = yield* DateTime.now;

          const facts: PiSessionFacts = {
            cwd: header.cwd ?? null,
            fileAgent: fileAgentOf(ref.path),
            localProviders: localProvidersOf(models),
            observedAt: DateTime.formatIso(now),
            origin: input.origin,
            parentSessionId: parentSessionIdOf(header, parentFile),
            path: ref.path,
            placeOf,
            sessionId: header.id ?? sessionIdOfFile(ref.path) ?? ref.path,
            version: yield* store.version,
          };

          const from =
            cursor !== null && cursor.offset <= file.endOffset
              ? cursor.offset
              : 0;

          const startsAfter = (offset: number) => from === 0 || offset >= from;

          const events = [
            ...sessionEventsOf(facts, reading, header),
            ...reading.turns
              .filter((turn) => startsAfter(turn.offset))
              .map((turn) => turnEvent(facts, turn)),
            ...reading.requests
              .filter((request) => startsAfter(request.offset))
              .map((request) => requestEvent(facts, request)),
          ];

          const gaps = gapsOf(ref, file, parentFile);

          const next: FileCursor = {
            mtimeMs: ref.mtimeMs,
            offset: file.endOffset,
            path: ref.path,
            size: ref.size,
          };

          const window = windowOf(events);

          return {
            coverage: {
              adapterId: PI_ADAPTER_ID,
              expectedItems: reading.requests.length,
              gaps,
              observedItems: reading.requests.length,
              state: file.malformed > 0 ? "partial" : "complete",
              watermark: window.to,
              windowFrom: window.from,
              windowTo: window.to,
            },
            cursor: fileCursorOf(PI_ADAPTER_ID, next),
            events,
          } satisfies EventBatch;
        });

      const read = (ref: SessionRef, input: ReadInput) =>
        ref.channel === "extension"
          ? Effect.succeed(readHookSpool(ref, piHookDecoder, input.origin))
          : readSession(ref, input);

      return {
        capabilities: {
          branchSources: [
            "hook",
            "git-at-time",
            "cwd-inferred",
            "tool-calls",
            "unassigned",
          ],
          liveHooks: true,
          storedFigure: "api-equivalent",
          subagents: true,
        },
        channels: PI_CHANNELS,
        discover,
        displayName: "Pi",
        id: "pi",
        locate,
        read,
      } satisfies Harness;
    }),
  }
) {
  static readonly layer = Layer.effect(this, this.make);

  static readonly mock = Layer.effect(this, this.make).pipe(
    Layer.provide(PiStore.memory({ files: [], roots: [] })),
    Layer.provide(GitRunner.memory([])),
    Layer.provide(Path.layer)
  );
}
