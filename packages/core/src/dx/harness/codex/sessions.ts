import { Effect, Option, Schema } from "effect";

import type { SourceUnavailable } from "../../contracts/error-source-unavailable.js";
import type { StoredSession } from "../contract.js";
import { decodeHeadLine, threadIdOfFile } from "./head.js";
import type { CodexHead } from "./head.js";
import { decodeSessionIndexLine } from "./records.js";
import type { CodexStoreApi } from "./store.js";

const LOCATION_BYTES = 4 * 1024;

const HEAD_BYTES = 64 * 1024;

const MAX_HEAD_BYTES = 4 * 1024 * 1024;

const NEWLINE = 10;

const decoder = new TextDecoder();

export interface SessionLocation {
  readonly cwd: string | null;
  readonly threadId: string;
}

export interface LocatedSession {
  readonly location: SessionLocation | null;
  readonly session: StoredSession;
  readonly threadId: string;
}

const firstLine = (bytes: Uint8Array, limit: number): string | null => {
  const end = bytes.indexOf(NEWLINE);

  if (end !== -1) {
    return decoder.decode(bytes.subarray(0, end));
  }

  return bytes.byteLength < limit ? decoder.decode(bytes) : null;
};

const decodeJsonText = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.String)
);

const META_START =
  /^\{"timestamp":"[^"]*",(?:"ordinal":\d+,)?"type":"session_meta"/u;

const THREAD_ID = /"id":"(?<value>(?:[^"\\]|\\.)*)"/u;

const CWD = /"cwd":"(?<value>(?:[^"\\]|\\.)*)"/u;

const textOf = (pattern: RegExp, prefix: string): string | null => {
  const raw = pattern.exec(prefix)?.groups?.value;

  return raw === undefined
    ? null
    : Option.getOrNull(decodeJsonText(`"${raw}"`));
};

const locationOfPrefix = (prefix: string): SessionLocation | null => {
  if (!META_START.test(prefix)) {
    return null;
  }

  const fields = prefix.split('"payload":')[1] ?? "";

  const scalars = fields.split(/"(?:source|git|base_instructions)":/u)[0] ?? "";

  const threadId = textOf(THREAD_ID, scalars);

  return threadId === null ? null : { cwd: textOf(CWD, scalars), threadId };
};

export const locationOf = (bytes: Uint8Array): SessionLocation | null => {
  const line = firstLine(bytes, LOCATION_BYTES);

  if (line === null) {
    return locationOfPrefix(decoder.decode(bytes));
  }

  const head = decodeHeadLine(line);

  return head === null ? null : { cwd: head.cwd, threadId: head.threadId };
};

const LOCATION_RANK: readonly (readonly [RegExp, number])[] = [
  [/\/sessions\/recovered\//u, 2],
  [/\/sessions\/imported\//u, 3],
  [/\/archived_sessions\//u, 1],
];

const locationRank = (file: string): number =>
  LOCATION_RANK.find(([pattern]) => pattern.test(file))?.[1] ?? 0;

const better = (a: LocatedSession, b: LocatedSession): LocatedSession => {
  const sizeA = a.session.size ?? 0;
  const sizeB = b.session.size ?? 0;

  if (sizeA !== sizeB) {
    return sizeA > sizeB ? a : b;
  }

  return locationRank(a.session.path) <= locationRank(b.session.path) ? a : b;
};

export const canonicalCopies = (
  sessions: readonly LocatedSession[]
): readonly LocatedSession[] => {
  const byThread = new Map<string, LocatedSession>();

  for (const session of sessions) {
    const known = byThread.get(session.threadId);

    byThread.set(
      session.threadId,
      known === undefined ? session : better(known, session)
    );
  }

  return [...byThread.values()].toSorted((a, b) =>
    a.session.path.localeCompare(b.session.path)
  );
};

export const codexHeads = (store: CodexStoreApi) => {
  const heads = new Map<string, CodexHead>();
  const locations = new Map<string, SessionLocation>();

  const readHead = (file: string) =>
    Effect.gen(function* readSessionHead() {
      const cached = heads.get(file);

      if (cached !== undefined) {
        return cached;
      }

      const line =
        firstLine(yield* store.readHead(file, HEAD_BYTES), HEAD_BYTES) ??
        firstLine(yield* store.readHead(file, MAX_HEAD_BYTES), MAX_HEAD_BYTES);

      const head = line === null ? null : decodeHeadLine(line);

      if (head !== null) {
        heads.set(file, head);
      }

      return head;
    });

  const readLocation = (file: string) =>
    Effect.gen(function* readSessionLocation() {
      const cached = locations.get(file);

      if (cached !== undefined) {
        return cached;
      }

      const head = locationOf(yield* store.readHead(file, LOCATION_BYTES));
      const full = head === null ? yield* readHead(file) : null;

      const location =
        head ??
        (full === null ? null : { cwd: full.cwd, threadId: full.threadId });

      if (location !== null) {
        locations.set(file, location);
      }

      return location;
    });

  const locateAll: Effect.Effect<readonly LocatedSession[], SourceUnavailable> =
    Effect.gen(function* locateAllSessions() {
      const sessions = yield* store.listSessions;

      return yield* Effect.forEach((session: StoredSession) =>
        readLocation(session.path).pipe(
          Effect.orElseSucceed(() => null),
          Effect.map((location): LocatedSession => ({
            location,
            session,
            threadId:
              location?.threadId ??
              threadIdOfFile(session.path) ??
              session.path,
          }))
        )
      )(sessions);
    });

  return { locateAll, readHead };
};

export const titlesOf = (text: string | null): ReadonlyMap<string, string> => {
  const titles = new Map<
    string,
    { readonly at: string; readonly name: string }
  >();

  for (const line of (text ?? "").split("\n")) {
    if (line.trim() === "") {
      continue;
    }

    Option.match(decodeSessionIndexLine(line), {
      onNone: () => null,
      onSome: (entry) => {
        const name = entry.thread_name?.trim() ?? "";
        const at = entry.updated_at ?? "";
        const known = titles.get(entry.id);

        if (name !== "" && (known === undefined || at >= known.at)) {
          titles.set(entry.id, { at, name });
        }

        return null;
      },
    });
  }

  return new Map([...titles].map(([id, entry]) => [id, entry.name]));
};
