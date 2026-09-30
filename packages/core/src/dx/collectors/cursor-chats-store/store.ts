// @effect-diagnostics nodeBuiltinImport:off -- cursor-agent chat stores are read through a node:sqlite backup copy in an owned temp folder that is removed afterwards, plus small synchronous directory listings and stats.
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

import { Effect, Option, Schema } from "effect";

import type { ChatStoreRows } from "./decode.js";

export const CHAT_STORE_FILE = "store.db";

const ChatMetaFileSchema = Schema.Struct({
  cwd: Schema.optional(Schema.NullOr(Schema.String)),
});

const decodeMetaFile = Schema.decodeUnknownOption(
  Schema.fromJsonString(ChatMetaFileSchema)
);

const MetaRowSchema = Schema.Struct({
  key: Schema.String,
  value: Schema.NullOr(Schema.String),
});

const BlobRowSchema = Schema.Struct({
  data: Schema.Uint8Array,
  id: Schema.String,
});

export const chatStoresIn = (input: string): readonly string[] => {
  try {
    if (!statSync(input).isDirectory()) {
      return [input];
    }

    const direct = path.join(input, CHAT_STORE_FILE);

    if (existsSync(direct)) {
      return [direct];
    }

    return readdirSync(input, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(input, entry.name, CHAT_STORE_FILE))
      .filter((file) => existsSync(file))
      .toSorted();
  } catch {
    return [];
  }
};

export const chatCwdOf = (storePath: string): string | null => {
  try {
    const text = readFileSync(
      path.join(path.dirname(storePath), "meta.json"),
      "utf-8"
    );

    return Option.getOrNull(decodeMetaFile(text))?.cwd ?? null;
  } catch {
    return null;
  }
};

const statOf = (file: string) => {
  try {
    const stat = statSync(file);

    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "absent";
  }
};

export const chatStoreFingerprint = (storePath: string): string =>
  `${statOf(storePath)}|${statOf(`${storePath}-wal`)}`;

const readCopy = (copyPath: string): ChatStoreRows => {
  const db = new DatabaseSync(copyPath, { readOnly: true });

  try {
    const meta = Schema.decodeUnknownSync(Schema.Array(MetaRowSchema))(
      db.prepare("select key, cast(value as text) as value from meta").all()
    );

    const blobs = Schema.decodeUnknownSync(Schema.Array(BlobRowSchema))(
      db.prepare("select id, data from blobs where data is not null").all()
    );

    return {
      blobs: new Map(blobs.map((row) => [row.id, row.data])),
      meta: new Map(
        meta.flatMap((row) =>
          row.value === null ? [] : [[row.key, row.value] as const]
        )
      ),
    };
  } finally {
    db.close();
  }
};

export const readChatStore = (
  storePath: string
): Effect.Effect<ChatStoreRows | null> =>
  Effect.gen(function* readStoreCopy() {
    const scratch = yield* Effect.try({
      catch: () => null,
      try: () => mkdtempSync(path.join(tmpdir(), "dft-cursor-chat-")),
    }).pipe(Effect.orElseSucceed(() => null));

    if (scratch === null) {
      return null;
    }

    const copyPath = path.join(scratch, CHAT_STORE_FILE);

    return yield* Effect.tryPromise({
      catch: () => null,
      // @effect-diagnostics-next-line asyncFunction:off -- node:sqlite backup is promise-only and Effect.tryPromise is its boundary.
      try: async () => {
        const source = new DatabaseSync(storePath, { readOnly: true });

        try {
          await backup(source, copyPath);
        } finally {
          source.close();
        }

        return readCopy(copyPath);
      },
    }).pipe(
      Effect.orElseSucceed(() => null),
      Effect.ensuring(
        Effect.sync(() => {
          rmSync(scratch, { force: true, recursive: true });
        })
      )
    );
  });
