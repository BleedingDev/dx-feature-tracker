import { Context, DateTime, Effect, Layer, Ref } from "effect";

import type { DxEventEnvelope, FlightContext } from "../../model/event.js";
import type {
  Discovery,
  Harness,
  HarnessScope,
  ReadInput,
  SessionRef,
  StoredSession,
} from "../contract.js";
import { hookSpoolRefs, readHookSpool } from "../hook-spool.js";
import { harnessAdapterId } from "../pending.js";
import {
  ompCursorOf,
  ompCursorUnchanged,
  readOmpCursor,
  resumeFrom,
} from "./cursor.js";
import {
  batchOf,
  fixedPlacer,
  parseGaps,
  placementFor,
  requestEventsOf,
  sessionEventsOf,
  statsGaps,
  timeOf,
  toolCallPlacer,
  turnEventsOf,
  unplaced,
} from "./emit.js";
import type { Ancestor, Placer, SessionReading } from "./emit.js";
import { ompSpawnFallbackEvent } from "./events.js";
import type { OmpSessionFacts } from "./events.js";
import type { OmpTaskResult } from "./format.js";
import { ompHookDecoder } from "./hook.js";
import { OMP_CHANNELS } from "./meta.js";
import { headerFromHead, parseOmpSession } from "./parse.js";
import type { OmpHeader, ParsedOmpSession } from "./parse.js";
import {
  isInside,
  isOmpSessionPath,
  isStrictAncestor,
  parentSessionCandidates,
  sessionIdFromName,
  sessionStem,
  subagentIdOf,
} from "./paths.js";
import { OmpStore } from "./store.js";
import type { OmpStoreService } from "./store.js";

export { ownerOf } from "./emit.js";

export const OMP_CAPABILITIES = {
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
} as const satisfies Harness["capabilities"];

interface ParentInfo {
  readonly headerId: string | null;
  readonly size: number;
  readonly spawns: ReadonlyMap<string, OmpTaskResult>;
}

type WorktreeForms = readonly (readonly [string, readonly string[]])[];

const PARENT_CACHE_LIMIT = 16;

const LINEAGE_LIMIT = 16;

const refOf = (
  session: StoredSession,
  header: OmpHeader | null,
  worktree: string | null
): SessionRef => ({
  channel: "session-file",
  harness: "omp",
  id: worktree === null ? session.path : `${session.path}#${worktree}`,
  mtimeMs: session.mtimeMs,
  path: session.path,
  sessionId: header?.id ?? sessionIdFromName(session.path),
  size: session.size,
  source: harnessAdapterId("omp"),
  worktree,
});

const insideAny = (
  forms: readonly string[],
  roots: readonly string[]
): boolean => forms.some((form) => roots.some((root) => isInside(form, root)));

const deepestContaining = (
  cwdForms: readonly string[],
  worktrees: WorktreeForms
): string | null =>
  worktrees
    .flatMap(([worktree, forms]) =>
      insideAny(cwdForms, forms) ? [worktree] : []
    )
    .toSorted((a, b) => b.length - a.length)[0] ?? null;

const worktreesBelow = (
  cwdForms: readonly string[],
  worktrees: WorktreeForms
): readonly string[] =>
  worktrees.flatMap(([worktree, forms]) =>
    cwdForms.some((cwd) => forms.some((form) => isStrictAncestor(cwd, form)))
      ? [worktree]
      : []
  );

const withParent = (
  current: ReadonlyMap<string, ParentInfo>,
  path: string,
  info: ParentInfo
): ReadonlyMap<string, ParentInfo> => {
  const next = new Map(current);

  next.delete(path);
  next.set(path, info);

  for (const oldest of next.keys()) {
    if (next.size <= PARENT_CACHE_LIMIT) {
      break;
    }

    next.delete(oldest);
  }

  return next;
};

const makeHarness = (store: OmpStoreService) =>
  Effect.gen(function* makeOmpHarnessService() {
    const parents = yield* Ref.make<ReadonlyMap<string, ParentInfo>>(new Map());

    const headerAt = (file: string) =>
      store.readHead(file).pipe(
        Effect.flatMap((head) => {
          const header = headerFromHead(head);

          return header === null
            ? store.readSession(file).pipe(Effect.map(headerFromHead))
            : Effect.succeed(header);
        }),
        Effect.orElseSucceed(() => null)
      );

    const listed = store.listSessions.pipe(
      Effect.orElseSucceed((): readonly StoredSession[] => [])
    );

    const discover = Effect.gen(function* discoverOmp() {
      const roots = yield* store.roots;
      const sessions = yield* listed;
      const found = sessions.length > 0;

      const discovery: Discovery = {
        harness: "omp",
        present: found,
        reason: found
          ? null
          : `no OMP sessions under ${roots.join(", ") || "any known folder"}`,
        roots,
        sessions: sessions.length,
        version: yield* store.version,
      };

      return discovery;
    });

    const realForms = (dir: string | null) =>
      dir === null
        ? Effect.succeed([])
        : store.realPath(dir).pipe(Effect.map((real) => [dir, real]));

    const touchedWorktrees = (file: string, worktrees: readonly string[]) =>
      store.readSession(file).pipe(
        Effect.map((bytes) => {
          const paths = parseOmpSession(bytes).requests.flatMap(
            (request) => request.toolPaths
          );

          return worktrees.filter((worktree) =>
            paths.some((path) => isInside(path, worktree))
          );
        }),
        Effect.orElseSucceed((): readonly string[] => [])
      );

    const placeSession = (session: StoredSession, worktrees: WorktreeForms) =>
      Effect.gen(function* placeOne() {
        const header = yield* headerAt(session.path);

        if (header === null) {
          return [];
        }

        const cwdForms = yield* realForms(header.cwd);
        const deepest = deepestContaining(cwdForms, worktrees);

        if (deepest !== null) {
          return [refOf(session, header, deepest)];
        }

        const below = worktreesBelow(cwdForms, worktrees);

        const touched =
          below.length === 0
            ? []
            : yield* touchedWorktrees(session.path, below);

        return touched.map((worktree) => refOf(session, header, worktree));
      });

    const locate = (scope: HarnessScope) =>
      Effect.gen(function* locateOmp() {
        const since = timeOf(scope.since);

        const sessions = (yield* store.listSessions).filter(
          (session) =>
            since === null ||
            session.mtimeMs === null ||
            session.mtimeMs >= since
        );

        const hooks = hookSpoolRefs(scope, "omp", "extension");

        if (scope.worktrees.length === 0) {
          return [
            ...sessions.map((session) => refOf(session, null, null)),
            ...hooks,
          ];
        }

        const worktrees = yield* Effect.forEach((worktree: string) =>
          realForms(worktree).pipe(
            Effect.map((forms) => [worktree, forms] as const)
          )
        )(scope.worktrees);

        const placed = yield* Effect.forEach((session: StoredSession) =>
          placeSession(session, worktrees)
        )(sessions);

        return [...placed.flat(), ...hooks];
      });

    const parentFrom = (candidate: string, bytes: Uint8Array) =>
      Effect.gen(function* parseParent() {
        const cached = (yield* Ref.get(parents)).get(candidate);

        if (cached?.size === bytes.length) {
          return cached;
        }

        const parsed = parseOmpSession(bytes);

        const info: ParentInfo = {
          headerId: parsed.header?.id ?? null,
          size: bytes.length,
          spawns: new Map(parsed.spawns.map((spawn) => [spawn.id, spawn])),
        };

        yield* Ref.update(parents, (current) =>
          withParent(current, candidate, info)
        );

        return info;
      });

    const parentInfo = (file: string) =>
      Effect.gen(function* findParent() {
        for (const candidate of parentSessionCandidates(file)) {
          const bytes = yield* store
            .readSession(candidate)
            .pipe(Effect.orElseSucceed(() => null));

          if (bytes !== null) {
            return yield* parentFrom(candidate, bytes);
          }
        }

        return null;
      });

    const sessionIndex = listed.pipe(
      Effect.map(
        (sessions) =>
          new Map(
            sessions.flatMap((session) => {
              const id = sessionIdFromName(session.path);

              return id === null ? [] : [[id, session.path] as const];
            })
          )
      )
    );

    const lineageOf = (header: OmpHeader) =>
      Effect.gen(function* walkLineage() {
        const chain: Ancestor[] = [];

        if (header.parentSession === null) {
          return chain;
        }

        const index = yield* sessionIndex;
        const seen = new Set<string>([header.id]);
        let next: string | null = header.parentSession;

        while (next !== null && chain.length < LINEAGE_LIMIT) {
          const reference: string = next;

          const file = isOmpSessionPath(reference)
            ? reference
            : (index.get(reference) ?? null);

          const parent = file === null ? null : yield* headerAt(file);

          if (parent === null || seen.has(parent.id)) {
            chain.push({
              id: sessionIdFromName(reference) ?? reference,
              present: false,
              timestamp: null,
            });

            return chain;
          }

          seen.add(parent.id);
          chain.push({
            id: parent.id,
            present: true,
            timestamp: parent.timestamp,
          });

          next = parent.parentSession;
        }

        return chain;
      });

    const placerFor = (
      ref: SessionRef,
      context: FlightContext,
      cwd: string | null,
      parsed: ParsedOmpSession
    ) =>
      Effect.gen(function* place() {
        const cwdForms = yield* realForms(cwd);
        const scoped = ref.worktree ?? context.worktreePath;

        if (scoped === null) {
          return fixedPlacer(unplaced);
        }

        const scopedForms = yield* realForms(scoped);

        if (insideAny(cwdForms, scopedForms)) {
          return fixedPlacer(placementFor(context, scoped, "cwd-inferred"));
        }

        const placer: Placer =
          ref.worktree === null
            ? fixedPlacer(unplaced)
            : toolCallPlacer(
                parsed,
                placementFor(context, ref.worktree, "tool-calls"),
                scopedForms
              );

        return placer;
      });

    const spawnFallbacks = (reading: SessionReading) =>
      Effect.gen(function* fallBack() {
        const events: DxEventEnvelope[] = [];

        for (const spawn of reading.parsed.spawns) {
          const exists = yield* store
            .readHead(`${sessionStem(reading.facts.path)}/${spawn.id}.jsonl`)
            .pipe(
              Effect.as(true),
              Effect.orElseSucceed(() => false)
            );

          const event = exists
            ? null
            : ompSpawnFallbackEvent({
                facts: reading.facts,
                input: reading.input,
                occurredAt: reading.header.timestamp,
                placement: reading.placer.session,
                spawn,
              });

          if (event !== null) {
            events.push(event);
          }
        }

        return events;
      });

    const factsFor = (
      ref: SessionRef,
      header: OmpHeader,
      parsed: ParsedOmpSession,
      storedAgentType: string | null
    ) =>
      Effect.gen(function* sessionFacts() {
        const parent = yield* parentInfo(ref.path);
        const agentId = subagentIdOf(ref.path);
        const spawn = parent?.spawns.get(agentId) ?? null;

        const facts: OmpSessionFacts = {
          agentId: parent === null ? null : agentId,
          agentType:
            parent === null
              ? null
              : (parsed.sessionInit?.agent ??
                spawn?.agent ??
                storedAgentType ??
                null),
          cwd: header.cwd,
          harnessVersion: yield* store.version,
          parentSessionId: parent?.headerId ?? null,
          path: ref.path,
          sessionId: header.id,
        };

        return facts;
      });

    const readSession = (ref: SessionRef, input: ReadInput) =>
      Effect.gen(function* readOmpSession() {
        const cursor = readOmpCursor(input.cursor, ref);

        if (ompCursorUnchanged(cursor, ref)) {
          return batchOf([], [], input.cursor);
        }

        const bytes = yield* store.readSession(ref.path);
        const resume = resumeFrom(cursor, bytes);
        const parsed = parseOmpSession(bytes, resume);
        const { header } = parsed;

        if (header === null) {
          return batchOf(
            [],
            [
              ...parseGaps(parsed),
              {
                code: "no-session-header",
                message: `${ref.path} has no OMP session header line`,
              },
            ],
            null
          );
        }

        const facts = yield* factsFor(
          ref,
          header,
          parsed,
          cursor?.agentType ?? null
        );

        const reading: SessionReading = {
          facts,
          header,
          input: {
            observedAt: DateTime.formatIso(yield* DateTime.now),
            origin: input.origin,
          },
          lineage: yield* lineageOf(header),
          parsed,
          placer: yield* placerFor(ref, input.context, header.cwd, parsed),
        };

        const events = [
          ...sessionEventsOf(reading),
          ...turnEventsOf(reading),
          ...requestEventsOf(reading),
          ...(yield* spawnFallbacks(reading)),
        ];

        const gaps = [
          ...parseGaps(parsed),
          ...(resume === null
            ? statsGaps((yield* store.statsTotals).get(ref.path), parsed)
            : []),
        ];

        return batchOf(events, gaps, ompCursorOf(ref, parsed, facts.agentType));
      });

    const read = (ref: SessionRef, input: ReadInput) =>
      ref.channel === "extension" || ref.channel === "hooks"
        ? Effect.sync(() => readHookSpool(ref, ompHookDecoder, input.origin))
        : readSession(ref, input);

    const harness: Harness = {
      capabilities: OMP_CAPABILITIES,
      channels: OMP_CHANNELS,
      discover,
      displayName: "OMP",
      id: "omp",
      locate,
      read,
    };

    return harness;
  });

export class OmpHarness extends Context.Service<OmpHarness, Harness>()(
  "dx/harness/omp/OmpHarness",
  {
    make: Effect.gen(function* makeOmpHarness() {
      return yield* makeHarness(yield* OmpStore);
    }),
  }
) {
  static readonly layer = Layer.effect(this, this.make);

  static readonly mock = Layer.effect(this, this.make).pipe(
    Layer.provide(OmpStore.memory({ files: [], roots: [] }))
  );
}
