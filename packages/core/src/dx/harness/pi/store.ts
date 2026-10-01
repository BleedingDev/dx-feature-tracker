import {
  Config,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
} from "effect";

import { SourceUnavailable } from "../../contracts/error-source-unavailable.js";
import type { HarnessStore, StoredSession } from "../contract.js";
import { liveFileStore, memoryFileStore } from "../file-store.js";
import type { MemoryStoreInput } from "../file-store.js";
import { HarnessHome } from "../home.js";
import { harnessAdapterId } from "../pending.js";
import { ownsSharedSession, sharesPiAgentDir } from "../pi-family.js";

export const PI_SESSION_DIR_ENV = "PI_CODING_AGENT_SESSION_DIR";

export interface PiSessionStore extends HarnessStore {
  readonly agentDir: string | null;
  readonly readHead: (path: string) => Effect.Effect<string, SourceUnavailable>;
  readonly readOptional: (path: string) => Effect.Effect<string | null>;
  readonly sessionsUnder: (
    root: string
  ) => Effect.Effect<readonly StoredSession[], SourceUnavailable>;
}

const SettingsSchema = Schema.Struct({
  sessionDir: Schema.optional(Schema.NullOr(Schema.String)),
});

const decodeSettings = Schema.decodeUnknownOption(
  Schema.fromJsonString(SettingsSchema)
);

export const sessionDirSetting = (
  settingsJson: string | null
): string | null =>
  settingsJson === null
    ? null
    : Option.match(decodeSettings(settingsJson), {
        onNone: () => null,
        onSome: (settings) => {
          const value = settings.sessionDir?.trim() ?? "";

          return value === "" ? null : value;
        },
      });

export const isPiSessionFile = (relativePath: string): boolean =>
  relativePath.endsWith(".jsonl");

const HEAD_BYTES = 65_536;

const decoder = new TextDecoder();

const unavailable = (message: string) =>
  new SourceUnavailable({ adapterId: harnessAdapterId("pi"), message });

const uniquePaths = (
  sessions: readonly StoredSession[]
): readonly StoredSession[] => {
  const seen = new Set<string>();

  return sessions.filter((session) => {
    if (seen.has(session.path)) {
      return false;
    }

    seen.add(session.path);

    return true;
  });
};

const optionalEnv = (name: string) =>
  Config.option(Config.String(name)).pipe(
    Config.map(Option.getOrNull),
    Effect.orElseSucceed(() => null)
  );

export const expandHome = (
  home: string,
  value: string,
  path: Path.Path
): string | null => {
  if (value === "~") {
    return home;
  }

  if (value.startsWith("~/")) {
    return path.join(home, value.slice(2));
  }

  return path.isAbsolute(value) ? path.resolve(value) : null;
};

export class PiStore extends Context.Service<PiStore, PiSessionStore>()(
  "dx/harness/pi/PiStore",
  {
    make: Effect.gen(function* makePiStore() {
      const home = yield* HarnessHome;
      const path = yield* Path.Path;
      const fileSystem = yield* FileSystem.FileSystem;

      const services = yield* Effect.context<
        FileSystem.FileSystem | Path.Path
      >();

      const userHome = yield* optionalEnv("HOME");

      const ownHome =
        userHome !== null && path.resolve(userHome) === path.resolve(home.home);

      const envSessionDir = ownHome
        ? yield* optionalEnv(PI_SESSION_DIR_ENV)
        : null;

      const readOptional = (file: string) =>
        fileSystem
          .readFileString(file)
          .pipe(Effect.orElseSucceed((): string | null => null));

      const roots = Effect.gen(function* piRoots() {
        const settingsDir = sessionDirSetting(
          yield* readOptional(path.join(home.dirs.pi, "settings.json"))
        );

        const candidates = [envSessionDir, settingsDir].flatMap((value) => {
          const resolved =
            value === null ? null : expandHome(home.home, value, path);

          return resolved === null ? [] : [resolved];
        });

        return [
          ...new Set([...candidates, path.join(home.dirs.pi, "sessions")]),
        ];
      });

      const storeFor = (rootsOf: Effect.Effect<readonly string[]>) =>
        liveFileStore({
          harness: "pi",
          isSession: isPiSessionFile,
          roots: rootsOf,
          version: Effect.succeed(null),
        }).pipe(Effect.provide(services));

      const base = yield* storeFor(roots);

      const sessionsUnder = (root: string) =>
        storeFor(Effect.succeed([root])).pipe(
          Effect.flatMap((store) => store.listSessions)
        );

      const readHead = (file: string) =>
        Effect.scoped(
          Effect.gen(function* head() {
            const handle = yield* fileSystem.open(file, { flag: "r" });
            const chunk = yield* handle.readAlloc(HEAD_BYTES);

            return Option.match(chunk, {
              onNone: () => "",
              onSome: (bytes) => decoder.decode(bytes),
            });
          })
        ).pipe(
          Effect.mapError((failure) =>
            unavailable(`cannot read ${file}: ${failure.message}`)
          ),
          Effect.flatMap((text) =>
            text.includes("\n") || text.length < HEAD_BYTES
              ? Effect.succeed(text)
              : base.readText(file)
          )
        );

      const ownedByPi = (session: StoredSession) =>
        readHead(session.path).pipe(
          Effect.map((head) => ownsSharedSession("pi", head)),
          Effect.orElseSucceed(() => true)
        );

      const listed = base.listSessions.pipe(Effect.map(uniquePaths));

      const store: PiSessionStore = {
        ...base,
        agentDir: home.dirs.pi,
        listSessions: sharesPiAgentDir(home.dirs)
          ? listed.pipe(Effect.flatMap(Effect.filter(ownedByPi)))
          : listed,
        readHead,
        readOptional,
        sessionsUnder,
      };

      return store;
    }),
  }
) {
  static readonly layer = Layer.effect(this, this.make);

  static readonly memory = (
    input: MemoryStoreInput & { readonly agentDir?: string }
  ): Layer.Layer<PiStore> => {
    const base = memoryFileStore("pi", input);
    const sessions = input.files.filter((file) => isPiSessionFile(file.path));

    const under = (root: string) =>
      base.listSessions.pipe(
        Effect.map((listed) =>
          listed.filter(
            (session) =>
              session.path.startsWith(`${root.replace(/\/+$/u, "")}/`) &&
              sessions.some((file) => file.path === session.path)
          )
        )
      );

    const listSessions = Effect.forEach(under)(input.roots).pipe(
      Effect.map((lists) => uniquePaths(lists.flat()))
    );

    return Layer.succeed(this, {
      ...base,
      agentDir: input.agentDir ?? null,
      listSessions,
      readHead: base.readText,
      readOptional: (file) =>
        base.readText(file).pipe(Effect.orElseSucceed(() => null)),
      sessionsUnder: under,
    });
  };
}
