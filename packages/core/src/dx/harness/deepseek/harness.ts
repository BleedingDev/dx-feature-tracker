import { Context, Effect, Layer, Option } from "effect";

import type { SourceUnavailable } from "../../contracts/error-source-unavailable.js";
import type {
  Harness,
  HarnessScope,
  HarnessStore,
  ReadInput,
  SessionRef,
  StoredSession,
} from "../contract.js";
import { HarnessHome } from "../home.js";
import { hookSpoolRefs, readHookSpool } from "../hook-spool.js";
import { DEEPSEEK_ADAPTER_ID } from "./events.js";
import {
  NO_CWD_PROJECT,
  decodeHeaderLine,
  decodeSegment,
  generationOf,
  projectKey,
} from "./format.js";
import type { Generation } from "./format.js";
import { decodeZstdLog } from "./frames.js";
import { deepseekHookDecoder } from "./hook.js";
import { DEEPSEEK_CHANNELS } from "./meta.js";
import { isInside, readDeepseekSession } from "./read.js";
import { DeepseekStore } from "./store.js";

export interface LocatedSession {
  readonly generation: Generation;
  readonly session: StoredSession;
  readonly sessionDir: string;
}

const relativeTo = (root: string, file: string): string | null => {
  const base = root.replace(/\/+$/u, "");

  return file.startsWith(`${base}/`) ? file.slice(base.length + 1) : null;
};

export const latestGenerations = (
  roots: readonly string[],
  sessions: readonly StoredSession[]
): readonly LocatedSession[] => {
  const latest = new Map<string, LocatedSession>();

  for (const session of sessions) {
    for (const root of roots) {
      const relative = relativeTo(root, session.path);
      const generation = relative === null ? null : generationOf(relative);

      if (generation !== null) {
        const sessionDir = session.path.slice(
          0,
          session.path.length - generation.file.length - 1
        );

        const current = latest.get(sessionDir);

        if (
          current === undefined ||
          generation.version > current.generation.version ||
          (generation.version === current.generation.version &&
            generation.compressed &&
            !current.generation.compressed)
        ) {
          latest.set(sessionDir, { generation, session, sessionDir });
        }

        break;
      }
    }
  }

  return [...latest.values()].toSorted((a, b) =>
    a.session.path.localeCompare(b.session.path)
  );
};

const candidateWorktrees = (
  generation: Generation,
  worktrees: readonly string[]
): readonly string[] =>
  generation.projectDir === NO_CWD_PROJECT
    ? []
    : worktrees.filter((worktree) => {
        const key = projectKey(worktree).slice(0, -2);

        return (
          generation.projectDir === `${key}--` ||
          generation.projectDir.startsWith(`${key}-`)
        );
      });

const HEADER_PROBE_BYTES = 65_536;

const firstFrameEnd = (bytes: Uint8Array): number =>
  Math.min(bytes.length, HEADER_PROBE_BYTES);

const firstLineEnd = (bytes: Uint8Array): number => {
  const newline = bytes.indexOf(0x0a);

  return newline === -1 ? bytes.length : newline;
};

const headerOf = (store: HarnessStore, located: LocatedSession) =>
  store.readBytes(located.session.path).pipe(
    Effect.map((bytes) => {
      const text = located.generation.compressed
        ? decodeZstdLog(bytes.subarray(0, firstFrameEnd(bytes)), 0).text
        : new TextDecoder().decode(bytes.subarray(0, firstLineEnd(bytes)));

      const [line] = text.split("\n");

      return line === undefined
        ? null
        : Option.getOrNull(decodeHeaderLine(line));
    })
  );

const refOf = (
  located: LocatedSession,
  worktree: string | null
): SessionRef => ({
  channel: "session-file",
  harness: "deepseek",
  id: located.sessionDir,
  mtimeMs: located.session.mtimeMs,
  path: located.session.path,
  sessionId: decodeSegment(located.generation.sessionDir),
  size: located.session.size,
  source: DEEPSEEK_ADAPTER_ID,
  worktree,
});

const deepestWorktree = (
  cwd: string | null,
  worktrees: readonly string[]
): string | null =>
  worktrees
    .filter((worktree) => isInside(cwd, worktree))
    .toSorted((a, b) => b.length - a.length)[0] ?? null;

export const locateSessions = (
  store: HarnessStore,
  scope: HarnessScope
): Effect.Effect<readonly SessionRef[], SourceUnavailable> =>
  Effect.gen(function* locateDeepseek() {
    const roots = yield* store.roots;
    const sessions = yield* store.listSessions;
    const since = scope.since === null ? null : Date.parse(scope.since);

    const fresh = latestGenerations(roots, sessions).filter(
      (located) =>
        since === null ||
        Number.isNaN(since) ||
        located.session.mtimeMs === null ||
        located.session.mtimeMs >= since
    );

    if (scope.worktrees.length === 0) {
      return fresh.map((located) => refOf(located, null));
    }

    const refs: SessionRef[] = [];

    for (const located of fresh) {
      const candidates = candidateWorktrees(
        located.generation,
        scope.worktrees
      );

      if (candidates.length > 0) {
        const header = yield* headerOf(store, located).pipe(
          Effect.orElseSucceed(() => null)
        );

        const worktree = deepestWorktree(header?.cwd ?? null, candidates);

        if (worktree !== null) {
          refs.push(refOf(located, worktree));
        }
      }
    }

    return refs;
  });

export class DeepseekHarness extends Context.Service<
  DeepseekHarness,
  Harness
>()("dx/harness/deepseek/DeepseekHarness", {
  make: Effect.gen(function* makeDeepseekHarness() {
    const store = yield* DeepseekStore;

    const discover = Effect.gen(function* discoverDeepseek() {
      const roots = yield* store.roots;

      const located = yield* store.listSessions.pipe(
        Effect.map((sessions) => latestGenerations(roots, sessions)),
        Effect.orElseSucceed((): readonly LocatedSession[] => [])
      );

      return {
        harness: "deepseek" as const,
        present: located.length > 0,
        reason:
          located.length > 0
            ? null
            : `no DeepSeek Harness sessions under ${roots.join(", ")}`,
        roots,
        sessions: located.length,
        version: yield* store.version,
      };
    });

    const locate = (scope: HarnessScope) =>
      locateSessions(store, scope).pipe(
        Effect.map((refs) => [
          ...refs,
          ...hookSpoolRefs(scope, "deepseek", "extension"),
        ])
      );

    const read = (ref: SessionRef, input: ReadInput) =>
      ref.channel === "extension"
        ? Effect.sync(() =>
            readHookSpool(ref, deepseekHookDecoder, input.origin)
          )
        : Effect.gen(function* readSession() {
            const bytes = yield* store.readBytes(ref.path);
            const harnessVersion = yield* store.version;

            return readDeepseekSession({ bytes, harnessVersion, input, ref });
          });

    return {
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
        storedFigure: null,
        subagents: true,
      },
      channels: DEEPSEEK_CHANNELS,
      discover,
      displayName: "DeepSeek Harness",
      id: "deepseek",
      locate,
      read,
    } satisfies Harness;
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);

  static readonly mock = this.layer.pipe(
    Layer.provide(DeepseekStore.memory({ files: [], roots: [] }))
  );
}

export const deepseekHarnessAt = (home: string) =>
  DeepseekHarness.layer.pipe(
    Layer.provide(DeepseekStore.layer),
    Layer.provide(HarnessHome.at(home))
  );
