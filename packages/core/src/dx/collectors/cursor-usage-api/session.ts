// @effect-diagnostics nodeBuiltinImport:off -- The logged-in Cursor session is read at runtime from the local state DB through a node:sqlite backup copy in an owned temp dir that is removed afterwards.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

import { Effect, Option, Schema } from "effect";

export interface CursorSession {
  readonly accessToken: string;
  readonly userId: string;
}

export const cursorStateDbPath = (home: string): string =>
  process.platform === "darwin"
    ? path.join(
        home,
        "Library",
        "Application Support",
        "Cursor",
        "User",
        "globalStorage",
        "state.vscdb"
      )
    : path.join(
        home,
        ".config",
        "Cursor",
        "User",
        "globalStorage",
        "state.vscdb"
      );

const unquote = (value: string): string =>
  value.trim().replaceAll(/^"|"$/gu, "");

const decodeClaims = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ sub: Schema.String }))
);

export const userIdFromToken = (token: string): string | null => {
  const [, payload] = token.split(".");

  if (payload === undefined) {
    return null;
  }

  return Option.match(
    decodeClaims(Buffer.from(payload, "base64url").toString("utf-8")),
    {
      onNone: () => null,
      onSome: (claims) => {
        const id = claims.sub.split("|").at(-1) ?? "";

        return id === "" ? null : id;
      },
    }
  );
};

export const sessionFromToken = (raw: string | null): CursorSession | null => {
  if (raw === null) {
    return null;
  }

  const accessToken = unquote(raw);
  const userId = userIdFromToken(accessToken);

  return accessToken === "" || userId === null ? null : { accessToken, userId };
};

const decodeRow = Schema.decodeUnknownOption(
  Schema.Struct({ value: Schema.String })
);

const readTokenFromCopy = (copy: string): string | null => {
  const db = new DatabaseSync(copy, { readOnly: true });

  try {
    const row = db
      .prepare(
        "SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'"
      )
      .get();

    return Option.match(decodeRow(row), {
      onNone: () => null,
      onSome: (decoded) => decoded.value,
    });
  } finally {
    db.close();
  }
};

export const readCursorSession = (
  dbPath: string
): Effect.Effect<CursorSession | null> =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(path.join(tmpdir(), "dft-cursor-usage-"))),
    (dir) =>
      // @effect-diagnostics-next-line asyncFunction:off -- node:sqlite backup is promise-only and Effect.tryPromise is its boundary.
      Effect.tryPromise(async () => {
        const source = new DatabaseSync(dbPath, { readOnly: true });
        const copy = path.join(dir, "state.db");

        try {
          await backup(source, copy);
        } finally {
          source.close();
        }

        return sessionFromToken(readTokenFromCopy(copy));
      }).pipe(Effect.orElseSucceed(() => null)),
    (dir) =>
      Effect.sync(() => {
        rmSync(dir, { force: true, recursive: true });
      })
  );
