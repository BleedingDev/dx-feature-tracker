import {
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Stream,
} from "effect";

import { SourceUnavailable } from "../../contracts/error-source-unavailable.js";
import type { HarnessStore, StoredSession } from "../contract.js";
import { liveFileStore, memoryFileStore } from "../file-store.js";
import type { MemoryStoreInput } from "../file-store.js";
import { HarnessHome } from "../home.js";
import type { HarnessLocations } from "../home.js";
import { harnessAdapterId } from "../pending.js";
import {
  familyFilesFor,
  isSessionFile,
  projectDirOf,
  SESSION_EXTENSION,
} from "./paths.js";

export interface ClaudeCodeFiles extends HarnessStore {
  readonly home: string | null;
  readonly isRepoRoot: (dir: string) => Effect.Effect<boolean>;
  readonly listFamily: (
    ref: string
  ) => Effect.Effect<readonly StoredSession[], SourceUnavailable>;
  readonly present: Effect.Effect<boolean>;
  readonly readHead: (
    path: string,
    bytes: number
  ) => Effect.Effect<Uint8Array, SourceUnavailable>;
  readonly readFrom: (
    path: string,
    offset: number
  ) => Effect.Effect<Uint8Array, SourceUnavailable>;
}

export interface ClaudeCodeMemoryInput extends MemoryStoreInput {
  readonly home?: string;
  readonly repoRoots?: readonly string[];
}

const CHUNK_BYTES = 1024 * 1024;

const unavailable = (message: string) =>
  new SourceUnavailable({
    adapterId: harnessAdapterId("claude-code"),
    message,
  });

export const claudeConfigDirs = (
  locations: HarnessLocations,
  path: Path.Path
): readonly string[] => {
  const configured = locations.dirs.claudeCode
    .split(",")
    .map((dir) => dir.trim())
    .filter((dir) => dir !== "")
    .map((dir) => path.resolve(dir));

  const isDefault =
    configured.length === 1 &&
    configured[0] === path.join(locations.home, ".claude");

  const xdg = path.join(path.dirname(locations.dirs.opencodeConfig), "claude");

  return isDefault ? [...configured, xdg] : configured;
};

const concatBytes = (chunks: readonly Uint8Array[]): Uint8Array => {
  let total = 0;

  for (const chunk of chunks) {
    total += chunk.byteLength;
  }

  const bytes = new Uint8Array(total);
  let at = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }

  return bytes;
};

const makeLive = Effect.gen(function* makeClaudeCodeStore() {
  const home = yield* HarnessHome;
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const configDirs = claudeConfigDirs(home, path);
  const roots = configDirs.map((dir) => path.join(dir, "projects"));

  const base = yield* liveFileStore({
    harness: "claude-code",
    isSession: isSessionFile,
    roots: Effect.succeed(roots),
    version: Effect.succeed(null),
  });

  const canonicalProjects = (sessions: readonly StoredSession[]) =>
    Effect.gen(function* resolveProjects() {
      const projects = [
        ...new Set(
          sessions.flatMap((session) => {
            const project = projectDirOf(roots, session.path);

            return project === null ? [] : [project];
          })
        ),
      ];

      const realOf = (dir: string) =>
        fileSystem.realPath(dir).pipe(Effect.orElseSucceed(() => dir));

      const resolved = yield* Effect.forEach((project: string) =>
        Effect.all({
          parent: realOf(path.dirname(project)),
          real: realOf(project),
        }).pipe(
          Effect.map(({ parent, real }) => ({
            canonical: real === path.join(parent, path.basename(project)),
            project,
            real,
          }))
        )
      )(projects);

      const seen = new Set<string>();
      const kept = new Set<string>();

      const ordered = resolved.toSorted(
        (a, b) =>
          Number(b.canonical) - Number(a.canonical) ||
          a.project.localeCompare(b.project)
      );

      for (const { project, real } of ordered) {
        if (!seen.has(real)) {
          seen.add(real);
          kept.add(project);
        }
      }

      return sessions.filter((session) => {
        const project = projectDirOf(roots, session.path);

        return project === null || kept.has(project);
      });
    });

  const statOf = (file: string) =>
    fileSystem.stat(file).pipe(
      Effect.map((info): StoredSession => ({
        mtimeMs: Option.match(info.mtime, {
          onNone: () => null,
          onSome: (date) => date.getTime(),
        }),
        path: file,
        size: Number(info.size),
      }))
    );

  const listUnder = (dir: string) =>
    Effect.gen(function* listFamilyDir() {
      if (!(yield* fileSystem.exists(dir))) {
        return [];
      }

      const entries = yield* fileSystem.readDirectory(dir, {
        recursive: true,
      });

      return yield* Effect.forEach((relative: string) =>
        statOf(path.join(dir, relative))
      )(entries.filter(isSessionFile).toSorted());
    });

  const listFamily = (ref: string) =>
    Effect.gen(function* listFamilyFiles() {
      if (!ref.endsWith(SESSION_EXTENSION)) {
        return yield* listUnder(ref);
      }

      const main = (yield* fileSystem.exists(ref)) ? [yield* statOf(ref)] : [];

      const members = yield* listUnder(ref.slice(0, -SESSION_EXTENSION.length));

      return [...main, ...members];
    }).pipe(
      Effect.mapError((failure) =>
        unavailable(`cannot list ${ref}: ${failure.message}`)
      )
    );

  const readFrom = (file: string, offset: number) =>
    fileSystem.stream(file, { chunkSize: CHUNK_BYTES, offset }).pipe(
      Stream.runCollect,
      Effect.map(concatBytes),
      Effect.mapError((failure) =>
        unavailable(`cannot read ${file}: ${failure.message}`)
      )
    );

  const readHead = (file: string, bytes: number) =>
    fileSystem
      .stream(file, { bytesToRead: bytes, chunkSize: CHUNK_BYTES })
      .pipe(
        Stream.runCollect,
        Effect.map(concatBytes),
        Effect.mapError((failure) =>
          unavailable(`cannot read ${file}: ${failure.message}`)
        )
      );

  const files: ClaudeCodeFiles = {
    ...base,
    home: home.home,
    isRepoRoot: (dir) =>
      fileSystem
        .exists(path.join(dir, ".git"))
        .pipe(Effect.orElseSucceed(() => false)),
    listFamily,
    listSessions: base.listSessions.pipe(Effect.flatMap(canonicalProjects)),
    present: Effect.forEach((dir: string) =>
      fileSystem.exists(dir).pipe(Effect.orElseSucceed(() => false))
    )(configDirs).pipe(Effect.map((found) => found.includes(true))),
    readFrom,
    readHead,
  };

  return files;
});

export const memoryClaudeCodeFiles = (
  input: ClaudeCodeMemoryInput
): ClaudeCodeFiles => {
  const base = memoryFileStore("claude-code", input);
  const repoRoots = new Set(input.repoRoots);

  const sessions = base.listSessions.pipe(
    Effect.map((all) => all.filter((file) => isSessionFile(file.path)))
  );

  return {
    ...base,
    home: input.home ?? null,
    isRepoRoot: (dir) => Effect.succeed(repoRoots.has(dir)),
    listFamily: (ref) =>
      sessions.pipe(Effect.map((all) => familyFilesFor(ref, all))),
    listSessions: sessions,
    present: Effect.succeed(input.files.length > 0),
    readFrom: (file, offset) =>
      base.readBytes(file).pipe(Effect.map((bytes) => bytes.subarray(offset))),
    readHead: (file, length) =>
      base
        .readBytes(file)
        .pipe(Effect.map((bytes) => bytes.subarray(0, length))),
  };
};

export class ClaudeCodeStore extends Context.Service<
  ClaudeCodeStore,
  ClaudeCodeFiles
>()("dx/harness/claude-code/ClaudeCodeStore", { make: makeLive }) {
  static readonly layer = Layer.effect(this, this.make);

  static readonly memory = (
    input: ClaudeCodeMemoryInput
  ): Layer.Layer<ClaudeCodeStore> =>
    Layer.succeed(this, memoryClaudeCodeFiles(input));
}
