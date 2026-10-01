import { Context, Effect, FileSystem, Layer, Option, Path } from "effect";

import { SourceUnavailable } from "../../contracts/error-source-unavailable.js";
import type { HarnessStore } from "../contract.js";
import { liveFileStore, memoryFileStore } from "../file-store.js";
import type { MemoryStoreInput } from "../file-store.js";
import { HarnessHome } from "../home.js";
import { harnessAdapterId } from "../pending.js";

export interface CodexStoreApi extends HarnessStore {
  readonly readFrom: (
    path: string,
    offset: number
  ) => Effect.Effect<Uint8Array, SourceUnavailable>;
  readonly readHead: (
    path: string,
    maxBytes: number
  ) => Effect.Effect<Uint8Array, SourceUnavailable>;
  readonly sessionIndex: Effect.Effect<string | null>;
}

export interface CodexMemoryInput extends MemoryStoreInput {
  readonly sessionIndex?: string;
}

export const CODEX_SESSION_ROOTS = ["sessions", "archived_sessions"] as const;

export const CODEX_SESSION_INDEX = "session_index.jsonl" as const;

const READ_CHUNK = 4 * 1024 * 1024;

const unavailable = (message: string) =>
  new SourceUnavailable({ adapterId: harnessAdapterId("codex"), message });

export const isCodexSessionFile = (name: string): boolean =>
  name.startsWith("rollout-") && name.endsWith(".jsonl");

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const size = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const joined = new Uint8Array(size);
  let at = 0;

  for (const part of parts) {
    joined.set(part, at);
    at += part.byteLength;
  }

  return joined;
};

const makeLive = Effect.gen(function* makeCodexStore() {
  const home = yield* HarnessHome;
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;

  const base = yield* liveFileStore({
    harness: "codex",
    isSession: (relative) => isCodexSessionFile(path.basename(relative)),
    roots: Effect.succeed(
      CODEX_SESSION_ROOTS.map((root) => path.join(home.dirs.codex, root))
    ),
    version: Effect.succeed(null),
  });

  const readRange = (file: string, offset: number, limit: number | null) =>
    Effect.scoped(
      Effect.gen(function* readFileRange() {
        const handle = yield* fileSystem.open(file, { flag: "r" });

        yield* handle.seek(BigInt(offset), "start");

        const parts: Uint8Array[] = [];
        const budget = limit ?? Number.POSITIVE_INFINITY;
        let total = 0;
        let more = true;

        while (more && total < budget) {
          const chunk = yield* handle.readAlloc(
            Math.min(READ_CHUNK, budget - total)
          );

          more = Option.isSome(chunk) && chunk.value.byteLength > 0;

          if (Option.isSome(chunk)) {
            parts.push(chunk.value);
            total += chunk.value.byteLength;
          }
        }

        return concat(parts);
      })
    ).pipe(
      Effect.mapError((failure) =>
        unavailable(`cannot read ${file}: ${failure.message}`)
      )
    );

  const store: CodexStoreApi = {
    ...base,
    readFrom: (file, offset) => readRange(file, offset, null),
    readHead: (file, maxBytes) => readRange(file, 0, maxBytes),
    sessionIndex: fileSystem
      .readFileString(path.join(home.dirs.codex, CODEX_SESSION_INDEX))
      .pipe(Effect.orElseSucceed(() => null)),
  };

  return store;
});

const makeMemory = (input: CodexMemoryInput): CodexStoreApi => {
  const base = memoryFileStore("codex", input);

  return {
    ...base,
    readFrom: (file, offset) =>
      Effect.map(base.readBytes(file), (bytes) => bytes.subarray(offset)),
    readHead: (file, maxBytes) =>
      Effect.map(base.readBytes(file), (bytes) => bytes.subarray(0, maxBytes)),
    sessionIndex: Effect.succeed(input.sessionIndex ?? null),
  };
};

export class CodexStore extends Context.Service<CodexStore, CodexStoreApi>()(
  "dx/harness/codex/CodexStore",
  { make: makeLive }
) {
  static readonly layer = Layer.effect(this, this.make);

  static readonly memory = (input: CodexMemoryInput): Layer.Layer<CodexStore> =>
    Layer.succeed(this, makeMemory(input));
}
