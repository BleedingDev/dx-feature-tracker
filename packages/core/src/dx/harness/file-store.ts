import { Effect, FileSystem, Option, Path } from "effect";

import { SourceUnavailable } from "../contracts/error-source-unavailable.js";
import type { HarnessStore, StoredSession } from "./contract.js";
import type { HarnessId } from "./ids.js";

export interface FileStoreSpec {
  readonly harness: HarnessId;
  readonly isSession: (relativePath: string) => boolean;
  readonly roots: Effect.Effect<readonly string[]>;
  readonly version: Effect.Effect<string | null>;
}

const unavailable = (harness: HarnessId, message: string) =>
  new SourceUnavailable({ adapterId: `harness.${harness}`, message });

export const liveFileStore = Effect.fnUntraced(function* liveFileStore(
  spec: FileStoreSpec
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const sessionsUnder = (root: string) =>
    Effect.gen(function* listRoot() {
      if (!(yield* fileSystem.exists(root))) {
        return [];
      }

      const entries = yield* fileSystem.readDirectory(root, {
        recursive: true,
      });

      const candidates = entries.filter(spec.isSession).toSorted();

      return yield* Effect.forEach((relative: string) => {
        const absolute = path.join(root, relative);

        return fileSystem.stat(absolute).pipe(
          Effect.map((info): StoredSession => ({
            mtimeMs: Option.match(info.mtime, {
              onNone: () => null,
              onSome: (date) => date.getTime(),
            }),
            path: absolute,
            size: Number(info.size),
          }))
        );
      })(candidates);
    }).pipe(
      Effect.mapError((failure) =>
        unavailable(spec.harness, `cannot list ${root}: ${failure.message}`)
      )
    );

  const listSessions = spec.roots.pipe(
    Effect.flatMap(Effect.forEach(sessionsUnder)),
    Effect.map((lists) => lists.flat())
  );

  const readText = (file: string) =>
    fileSystem
      .readFileString(file)
      .pipe(
        Effect.mapError((failure) =>
          unavailable(spec.harness, `cannot read ${file}: ${failure.message}`)
        )
      );

  const readBytes = (file: string) =>
    fileSystem
      .readFile(file)
      .pipe(
        Effect.mapError((failure) =>
          unavailable(spec.harness, `cannot read ${file}: ${failure.message}`)
        )
      );

  const store: HarnessStore = {
    listSessions,
    readBytes,
    readText,
    roots: spec.roots,
    version: spec.version,
  };

  return store;
});

interface MemoryFileBase {
  readonly mtimeMs?: number;
  readonly path: string;
}

export type MemoryFile =
  | (MemoryFileBase & { readonly text: string })
  | (MemoryFileBase & { readonly bytes: Uint8Array });

export interface MemoryStoreInput {
  readonly files: readonly MemoryFile[];
  readonly roots: readonly string[];
  readonly version?: string | null;
}

const encoder = new TextEncoder();

const decoder = new TextDecoder();

const bytesOf = (file: MemoryFile): Uint8Array =>
  "bytes" in file ? file.bytes : encoder.encode(file.text);

const textOf = (file: MemoryFile): string =>
  "text" in file ? file.text : decoder.decode(file.bytes);

export const memoryFileStore = (
  harness: HarnessId,
  input: MemoryStoreInput
): HarnessStore => {
  const byPath = new Map(input.files.map((file) => [file.path, file]));

  const find = (file: string) => {
    const found = byPath.get(file);

    return found === undefined
      ? Effect.fail(unavailable(harness, `no file at ${file}`))
      : Effect.succeed(found);
  };

  return {
    listSessions: Effect.succeed(
      input.files
        .map((file): StoredSession => ({
          mtimeMs: file.mtimeMs ?? null,
          path: file.path,
          size: bytesOf(file).byteLength,
        }))
        .toSorted((a, b) => a.path.localeCompare(b.path))
    ),
    readBytes: (file) => Effect.map(find(file), bytesOf),
    readText: (file) => Effect.map(find(file), textOf),
    roots: Effect.succeed(input.roots),
    version: Effect.succeed(input.version ?? null),
  };
};
