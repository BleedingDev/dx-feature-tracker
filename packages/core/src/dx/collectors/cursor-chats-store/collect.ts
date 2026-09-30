// @effect-diagnostics-next-line nodeBuiltinImport:off -- Evidence hashes are a synchronous sha256 of the chat store path and fingerprint.
import { createHash } from "node:crypto";

import { DateTime, Effect } from "effect";

import type { CollectInput } from "../../contracts/services.js";
import type { SourceGap } from "../../model/coverage.js";
import type { DxEventEnvelope, EventBatch } from "../../model/event.js";
import { scopeFor } from "../cursor-local-db/scope.js";
import type { WorktreeScope } from "../cursor-local-db/scope.js";
import { decodeChatStore } from "./decode.js";
import type { ChatModel } from "./decode.js";
import { chatInScope, mapChatModel } from "./map.js";
import {
  chatCwdOf,
  chatStoreFingerprint,
  chatStoresIn,
  readChatStore,
} from "./store.js";

export interface ChatStoreAdapter {
  readonly adapterId: string;
  readonly adapterVersion: string;
}

interface DecodedStore {
  readonly fingerprint: string;
  readonly model: ChatModel | null;
}

const MAX_CACHED_STORES = 512;

const decodedStores = new Map<string, DecodedStore>();

const remember = (storePath: string, decoded: DecodedStore) => {
  decodedStores.delete(storePath);
  decodedStores.set(storePath, decoded);

  for (const stale of [...decodedStores.keys()].slice(
    0,
    Math.max(0, decodedStores.size - MAX_CACHED_STORES)
  )) {
    decodedStores.delete(stale);
  }
};

const decodeStore = (storePath: string) =>
  Effect.gen(function* decodeOneStore() {
    const fingerprint = chatStoreFingerprint(storePath);
    const cached = decodedStores.get(storePath);

    if (cached?.fingerprint === fingerprint) {
      return cached;
    }

    const rows = yield* readChatStore(storePath);

    const decoded = {
      fingerprint,
      model: rows === null ? null : decodeChatStore(rows),
    };

    remember(storePath, decoded);

    return decoded;
  });

const hashOf = (value: string) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

interface Tally {
  excluded: number;
  unreadable: number;
}

const countGap = (count: number, code: string, message: string) =>
  count > 0 ? [{ code, message: `${count} ${message}` }] : [];

const gapsFor = (tally: Tally): SourceGap[] => [
  {
    code: "no-tokens-in-chat-store",
    message:
      "The cursor-agent chat store keeps no token counts or charges; tokens come from the stop hook or Cursor account usage for the same chat",
  },
  ...countGap(
    tally.excluded,
    "scope-excluded",
    "chat(s) of other worktrees were skipped"
  ),
  ...countGap(
    tally.unreadable,
    "chat-store-unrecognized",
    "chat store(s) had no readable agent metadata and were skipped"
  ),
];

const mapStores = (
  input: CollectInput,
  adapter: ChatStoreAdapter,
  scope: WorktreeScope | null,
  observedAt: string
) =>
  Effect.gen(function* mapAllStores() {
    const stores = chatStoresIn(input.selectedInput ?? "");
    const tally: Tally = { excluded: 0, unreadable: 0 };
    const events: DxEventEnvelope[] = [];

    for (const storePath of stores) {
      const decoded = yield* decodeStore(storePath);
      const { model } = decoded;

      if (model === null) {
        tally.unreadable += 1;
      } else if (chatInScope(model, chatCwdOf(storePath), scope)) {
        events.push(
          ...mapChatModel(model, {
            adapterId: adapter.adapterId,
            adapterVersion: adapter.adapterVersion,
            context: input.context,
            observedAt,
            origin: input.origin,
            scope,
            sourceHash: hashOf(`${storePath}\n${decoded.fingerprint}`),
          })
        );
      } else {
        tally.excluded += 1;
      }
    }

    return { events, stores: stores.length, tally };
  });

export const collectChatStores = (
  input: CollectInput,
  adapter: ChatStoreAdapter
): Effect.Effect<EventBatch> =>
  Effect.gen(function* collectCursorChatStores() {
    const scope = scopeFor(input.context);
    const now = yield* DateTime.now;
    const observedAt = DateTime.formatIso(now);
    const result = yield* mapStores(input, adapter, scope, observedAt);

    const times = result.events
      .flatMap((event) => (event.occurredAt === null ? [] : [event.occurredAt]))
      .toSorted();

    const readable = result.stores - result.tally.unreadable;

    const state = (() => {
      if (readable === 0 && result.stores > 0) {
        return "unsupported" as const;
      }

      if (result.events.length === 0) {
        return "none" as const;
      }

      return result.tally.unreadable > 0
        ? ("partial" as const)
        : ("complete" as const);
    })();

    return {
      coverage: {
        adapterId: adapter.adapterId,
        expectedItems: result.stores,
        gaps: gapsFor(result.tally),
        observedItems: result.events.length,
        state,
        watermark: times.at(-1) ?? null,
        windowFrom: times.at(0) ?? null,
        windowTo: times.at(-1) ?? null,
      },
      cursor: null,
      events: result.events,
    };
  });
