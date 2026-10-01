import { NodeCrypto } from "@effect/platform-node";
import {
  Context,
  Crypto,
  Effect,
  FileSystem,
  Layer,
  Path,
  PlatformError,
} from "effect";

import { defaultDftHome } from "../../registry/runtime.js";
import type { HarnessScope, HarnessStore } from "../contract.js";
import { liveFileStore, memoryFileStore } from "../file-store.js";
import type { MemoryStoreInput } from "../file-store.js";
import { HarnessHome } from "../home.js";
import {
  CURSOR_TRANSCRIPT_SOURCE,
  cursorProjectSlug,
  cursorSources,
} from "./sources.js";
import type { CursorSource } from "./sources.js";

export type CursorCollectorServices = FileSystem.FileSystem | Crypto.Crypto;

export interface CursorStoreApi extends HarnessStore {
  readonly folder: string;
  readonly present: Effect.Effect<boolean>;
  readonly reader: Context.Context<CursorCollectorServices>;
  readonly sources: (
    scope: HarnessScope
  ) => Effect.Effect<readonly CursorSource[]>;
}

export interface CursorMemoryInput extends MemoryStoreInput {
  readonly folder?: string;
}

const isTranscript = (file: string) =>
  file.endsWith(".jsonl") || file.endsWith(".txt");

const makeLive = Effect.gen(function* makeCursorStore() {
  const home = yield* HarnessHome;
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const reader = yield* Effect.context<CursorCollectorServices>();

  const base = yield* liveFileStore({
    harness: "cursor",
    isSession: (relative) =>
      relative.includes(`agent-transcripts${path.sep}`) &&
      isTranscript(relative),
    roots: Effect.succeed([path.join(home.dirs.cursor, "projects")]),
    version: Effect.succeed(null),
  });

  const store: CursorStoreApi = {
    ...base,
    folder: home.dirs.cursor,
    present: fileSystem
      .exists(home.dirs.cursor)
      .pipe(Effect.orElseSucceed(() => false)),
    reader,
    sources: (scope) =>
      Effect.sync(() =>
        cursorSources({
          dftHome: scope.dftHome ?? defaultDftHome(),
          home: home.home,
          repoCommonDir: scope.repoCommonDir,
          worktrees: scope.worktrees,
        })
      ),
  };

  return store;
});

const missing = (method: string, target: string) =>
  PlatformError.badArgument({
    description: `no file at ${target} in the Cursor memory store`,
    method,
    module: "FileSystem",
  });

const makeMemory = (input: CursorMemoryInput) =>
  Effect.gen(function* makeCursorMemoryStore() {
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const base = memoryFileStore("cursor", input);
    const paths = input.files.map((file) => file.path);

    const fileSystem = FileSystem.makeNoop({
      exists: (target) =>
        Effect.succeed(
          paths.some(
            (file) => file === target || file.startsWith(`${target}${path.sep}`)
          )
        ),
      readFile: (target) =>
        base
          .readBytes(target)
          .pipe(Effect.mapError(() => missing("readFile", target))),
      readFileString: (target) =>
        base
          .readText(target)
          .pipe(Effect.mapError(() => missing("readFileString", target))),
    });

    const transcriptsOf = (worktree: string): readonly CursorSource[] => {
      const prefixes = input.roots.map(
        (root) =>
          `${path.join(root, cursorProjectSlug(worktree), "agent-transcripts")}${path.sep}`
      );

      return paths
        .filter(
          (file) =>
            isTranscript(file) &&
            prefixes.some((prefix) => file.startsWith(prefix))
        )
        .toSorted()
        .map((file) => ({
          input: file,
          source: CURSOR_TRANSCRIPT_SOURCE,
          worktree,
        }));
    };

    const store: CursorStoreApi = {
      ...base,
      folder: input.folder ?? "the Cursor memory store",
      present: Effect.succeed(paths.length > 0),
      reader: Context.make(FileSystem.FileSystem, fileSystem).pipe(
        Context.add(Crypto.Crypto, crypto)
      ),
      sources: (scope) =>
        Effect.succeed(scope.worktrees.flatMap(transcriptsOf)),
    };

    return store;
  });

export class CursorStore extends Context.Service<CursorStore, CursorStoreApi>()(
  "dx/harness/cursor/CursorStore",
  { make: makeLive }
) {
  static readonly layer = Layer.effect(this, this.make);

  static readonly memory = (
    input: CursorMemoryInput
  ): Layer.Layer<CursorStore> =>
    Layer.effect(this, makeMemory(input)).pipe(
      Layer.provide(Layer.mergeAll(Path.layer, NodeCrypto.layer))
    );
}
