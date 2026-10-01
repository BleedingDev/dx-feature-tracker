import { Config, Effect, FileSystem, Option, Path, Schema } from "effect";

import type { HarnessLocations } from "./home.js";

export interface InstalledPackage {
  readonly bin: string;
  readonly packages: readonly string[];
}

const PackageJsonSchema = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
});

const decodePackageJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(PackageJsonSchema)
);

const HOME_BIN_DIRS: readonly (readonly string[])[] = [
  [".bun", "bin"],
  [".local", "bin"],
  [".local", "share", "pnpm"],
  [".local", "share", "pnpm", "bin"],
  ["Library", "pnpm"],
  ["Library", "pnpm", "bin"],
  [".npm-global", "bin"],
];

const NODE_VERSION_DIRS: readonly {
  readonly bin: readonly string[];
  readonly root: readonly string[];
}[] = [
  { bin: ["bin"], root: [".proto", "tools", "node"] },
  { bin: ["bin"], root: [".nvm", "versions", "node"] },
  {
    bin: ["installation", "bin"],
    root: [".local", "share", "fnm", "node-versions"],
  },
];

const MAX_PARENTS = 8;

const SHIM_BYTES = 16_384;

const SHIM_TARGET = /(?:\$basedir|%~?dp0%?)[/\\](?<target>[^"'\s]+)/gu;

const decoder = new TextDecoder();

const NODE_VERSION = /^v?(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)/u;

const versionParts = (name: string): readonly number[] => {
  const groups = NODE_VERSION.exec(name)?.groups;

  return groups === undefined
    ? [-1, -1, -1]
    : [groups.major, groups.minor, groups.patch].map(Number);
};

const newestFirst = (a: string, b: string): number => {
  const left = versionParts(a);
  const right = versionParts(b);
  const index = left.findIndex((part, at) => part !== right[at]);

  return index === -1 ? 0 : (right[index] ?? 0) - (left[index] ?? 0);
};

const optionalEnv = (name: string) =>
  Config.option(Config.String(name)).pipe(
    Config.map(Option.getOrNull),
    Effect.orElseSucceed((): string | null => null)
  );

export const installedVersion = Effect.fnUntraced(function* installedVersion(
  locations: HarnessLocations,
  spec: InstalledPackage
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const userHome = yield* optionalEnv("HOME");

  const ownHome =
    userHome !== null &&
    path.resolve(userHome) === path.resolve(locations.home);

  const searchPath = ownHome ? ((yield* optionalEnv("PATH")) ?? "") : "";
  const delimiter = path.sep === "\\" ? ";" : ":";

  const readOptional = (file: string) =>
    fileSystem
      .readFileString(file)
      .pipe(Effect.orElseSucceed((): string | null => null));

  const versionAt = (dir: string) =>
    readOptional(path.join(dir, "package.json")).pipe(
      Effect.map((text) =>
        text === null
          ? null
          : Option.match(decodePackageJson(text), {
              onNone: () => null,
              onSome: (found) =>
                spec.packages.includes(found.name) ? found.version : null,
            })
      )
    );

  const versionAbove = Effect.fnUntraced(function* versionAbove(file: string) {
    let dir = path.dirname(file);

    for (let step = 0; step < MAX_PARENTS; step += 1) {
      const version = yield* versionAt(dir);

      if (version !== null) {
        return version;
      }

      const parent = path.dirname(dir);

      if (parent === dir) {
        return null;
      }

      dir = parent;
    }

    return null;
  });

  const shimTargets = (file: string) =>
    Effect.scoped(
      Effect.gen(function* readShim() {
        const handle = yield* fileSystem.open(file, { flag: "r" });
        const chunk = yield* handle.readAlloc(SHIM_BYTES);

        return Option.match(chunk, {
          onNone: () => "",
          onSome: (bytes) => decoder.decode(bytes),
        });
      })
    ).pipe(
      Effect.map((text) => [
        ...new Set(
          [...text.matchAll(SHIM_TARGET)].flatMap((match) => {
            const target = match.groups?.target;

            return target === undefined
              ? []
              : [path.resolve(path.dirname(file), target)];
          })
        ),
      ]),
      Effect.orElseSucceed((): readonly string[] => [])
    );

  const versionOfBinary = Effect.fnUntraced(function* versionOfBinary(
    file: string
  ) {
    if (
      !(yield* fileSystem.exists(file).pipe(Effect.orElseSucceed(() => false)))
    ) {
      return null;
    }

    const real = yield* fileSystem
      .realPath(file)
      .pipe(Effect.orElseSucceed(() => file));

    const direct = yield* versionAbove(real);

    if (direct !== null) {
      return direct;
    }

    for (const target of yield* shimTargets(real)) {
      const version = yield* versionAbove(target);

      if (version !== null) {
        return version;
      }
    }

    return null;
  });

  const versionedBinDirs = Effect.forEach(
    (layout: (typeof NODE_VERSION_DIRS)[number]) => {
      const root = path.join(locations.home, ...layout.root);

      return fileSystem.readDirectory(root).pipe(
        Effect.map((names) =>
          names
            .toSorted(newestFirst)
            .map((name) => path.join(root, name, ...layout.bin))
        ),
        Effect.orElseSucceed((): readonly string[] => [])
      );
    }
  )(NODE_VERSION_DIRS).pipe(Effect.map((lists) => lists.flat()));

  const binDirs = [
    ...searchPath.split(delimiter).filter((dir) => dir.trim() !== ""),
    ...HOME_BIN_DIRS.map((parts) => path.join(locations.home, ...parts)),
    ...(yield* versionedBinDirs),
  ];

  const names = [spec.bin, `${spec.bin}.cmd`];

  for (const dir of new Set(binDirs)) {
    for (const name of names) {
      const version = yield* versionOfBinary(path.join(dir, name));

      if (version !== null) {
        return version;
      }
    }
  }

  return null;
});
