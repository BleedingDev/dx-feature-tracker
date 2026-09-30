import { Option, Schema } from "effect";

import {
  bytesOf,
  hexOf,
  messagesOf,
  numberOf,
  readMessage,
  stringOf,
  stringsOf,
} from "./protobuf.js";
import type { WireField } from "./protobuf.js";

export interface ChatStoreRows {
  readonly blobs: ReadonlyMap<string, Uint8Array>;
  readonly meta: ReadonlyMap<string, string>;
}

export interface ChatMeta {
  readonly agentId: string;
  readonly createdAt: number | null;
  readonly latestRootBlobId: string | null;
  readonly mode: string | null;
  readonly parentAgentId: string | null;
  readonly subagentType: string | null;
}

export interface TrackedRepo {
  readonly branch: string | null;
  readonly path: string;
}

export interface ChatTurn {
  readonly key: string;
  readonly repos: readonly TrackedRepo[];
  readonly activeBranch: string | null;
  readonly requestId: string | null;
  readonly routedModel: string | null;
  readonly startedAt: number | null;
  readonly steps: number;
  readonly toolCalls: number;
  readonly userMessageId: string | null;
}

export interface ChatModel {
  readonly activeBranch: string | null;
  readonly firstActiveBranch: string | null;
  readonly firstRepos: readonly TrackedRepo[];
  readonly agentType: string | null;
  readonly contextLimit: number | null;
  readonly contextUsed: number | null;
  readonly meta: ChatMeta;
  readonly models: readonly string[];
  readonly repos: readonly TrackedRepo[];
  readonly startedAt: number | null;
  readonly turns: readonly ChatTurn[];
  readonly workspaceUris: readonly string[];
}

const MetaSchema = Schema.Struct({
  agentId: Schema.String,
  createdAt: Schema.optional(Schema.NullOr(Schema.Finite)),
  latestRootBlobId: Schema.optional(Schema.NullOr(Schema.String)),
  mode: Schema.optional(Schema.NullOr(Schema.String)),
  subagentInfo: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        parentAgentId: Schema.optional(Schema.NullOr(Schema.String)),
        typeName: Schema.optional(Schema.NullOr(Schema.String)),
      })
    )
  ),
});

const decodeMeta = Schema.decodeUnknownOption(
  Schema.fromJsonString(MetaSchema)
);

const MessageJsonSchema = Schema.Struct({
  content: Schema.optional(Schema.Unknown),
  role: Schema.optional(Schema.String),
});

const MessagePartsSchema = Schema.Array(
  Schema.Struct({
    providerOptions: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          cursor: Schema.optional(
            Schema.NullOr(
              Schema.Struct({ modelName: Schema.optional(Schema.String) })
            )
          ),
        })
      )
    ),
  })
);

const decodeMessageParts = Schema.decodeUnknownOption(MessagePartsSchema);

const decodeMessageJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(MessageJsonSchema)
);

const HEX_TEXT = /^(?:[0-9a-f]{2})+$/u;

const metaText = (value: string): string =>
  HEX_TEXT.test(value) ? Buffer.from(value, "hex").toString("utf-8") : value;

export const decodeChatMeta = (
  meta: ReadonlyMap<string, string>
): ChatMeta | null => {
  for (const value of meta.values()) {
    const decoded = Option.getOrNull(decodeMeta(metaText(value)));

    if (decoded !== null) {
      return {
        agentId: decoded.agentId,
        createdAt: decoded.createdAt ?? null,
        latestRootBlobId: decoded.latestRootBlobId ?? null,
        mode: decoded.mode ?? null,
        parentAgentId: decoded.subagentInfo?.parentAgentId ?? null,
        subagentType: decoded.subagentInfo?.typeName ?? null,
      };
    }
  }

  return null;
};

const ROOT = {
  activeBranch: 19,
  agentType: 22,
  promptMessages: 1,
  startedAt: 26,
  tokenDetails: 5,
  trackedRepos: 21,
  turns: 8,
  workspaceUris: 9,
} as const;

const TURN = {
  requestId: 3,
  routedModel: 7,
  steps: 2,
  userMessage: 1,
  userMessageId: 10,
} as const;

const USER_MESSAGE = { messageId: 2, startedAt: 25 } as const;

const STEP_TOOL_CALL = 2;

const BLOB_REF_BYTES = 32;

const refsOf = (fields: readonly WireField[], no: number) =>
  bytesOf(fields, no)
    .filter((value) => value.length === BLOB_REF_BYTES)
    .map(hexOf);

const blobMessage = (rows: ChatStoreRows, id: string) => {
  const blob = rows.blobs.get(id);

  return blob === undefined ? null : readMessage(blob);
};

const isRoot = (fields: readonly WireField[]) =>
  numberOf(fields, ROOT.startedAt) !== null &&
  refsOf(fields, ROOT.turns).length > 0;

const trackedRepos = (fields: readonly WireField[]): readonly TrackedRepo[] =>
  messagesOf(fields, ROOT.trackedRepos).flatMap((repo) => {
    const repoPath = stringOf(repo, 1);

    return repoPath === null || repoPath === ""
      ? []
      : [{ branch: stringOf(repo, 2), path: repoPath }];
  });

interface TurnStructure {
  readonly key: string;
  readonly requestId: string | null;
  readonly routedModel: string | null;
  readonly stepRefs: readonly string[];
  readonly userMessageId: string | null;
  readonly userMessageRef: string | null;
}

const AGENT_TURN = 1;

const turnStructure = (
  rows: ChatStoreRows,
  ref: string
): TurnStructure | null => {
  const wrapper = blobMessage(rows, ref);

  const fields =
    wrapper === null ? null : (messagesOf(wrapper, AGENT_TURN)[0] ?? null);

  if (fields === null) {
    return null;
  }

  const requestId = stringOf(fields, TURN.requestId);
  const userMessageId = stringOf(fields, TURN.userMessageId);

  return {
    key: requestId ?? userMessageId ?? ref,
    requestId,
    routedModel: stringOf(fields, TURN.routedModel),
    stepRefs: refsOf(fields, TURN.steps),
    userMessageId,
    userMessageRef: refsOf(fields, TURN.userMessage)[0] ?? null,
  };
};

const userMessageOf = (rows: ChatStoreRows, ref: string | null) => {
  const fields = ref === null ? null : blobMessage(rows, ref);

  return {
    messageId:
      fields === null ? null : stringOf(fields, USER_MESSAGE.messageId),
    startedAt:
      fields === null ? null : numberOf(fields, USER_MESSAGE.startedAt),
  };
};

const toolCallsOf = (rows: ChatStoreRows, stepRefs: readonly string[]) =>
  stepRefs.filter((ref) =>
    (blobMessage(rows, ref) ?? []).some(
      (field) => field.no === STEP_TOOL_CALL && field.kind === "bytes"
    )
  ).length;

interface RootSnapshot {
  readonly fields: readonly WireField[];
  readonly id: string;
  readonly order: number;
  readonly turns: readonly TurnStructure[];
}

const rootSnapshots = (rows: ChatStoreRows): readonly RootSnapshot[] => {
  const seen = new Map<string, TurnStructure | null>();

  const turnOf = (ref: string) => {
    if (!seen.has(ref)) {
      seen.set(ref, turnStructure(rows, ref));
    }

    return seen.get(ref) ?? null;
  };

  return [...rows.blobs.keys()]
    .flatMap((id) => {
      const fields = blobMessage(rows, id);

      if (fields === null || !isRoot(fields)) {
        return [];
      }

      const turns = refsOf(fields, ROOT.turns).flatMap((ref) => {
        const turn = turnOf(ref);

        return turn === null ? [] : [turn];
      });

      const order =
        turns.length * 1_000_000 +
        turns.reduce((sum, turn) => sum + turn.stepRefs.length, 0);

      return [{ fields, id, order, turns }];
    })
    .toSorted((a, b) => a.order - b.order || a.id.localeCompare(b.id));
};

const modelsOf = (rows: ChatStoreRows, root: readonly WireField[]) => {
  const models: string[] = [];

  for (const ref of refsOf(root, ROOT.promptMessages)) {
    const blob = rows.blobs.get(ref);

    const message =
      blob === undefined
        ? null
        : Option.getOrNull(
            decodeMessageJson(Buffer.from(blob).toString("utf-8"))
          );

    const parts =
      message?.role === "assistant"
        ? (Option.getOrNull(decodeMessageParts(message.content)) ?? [])
        : [];

    for (const part of parts) {
      const name = part.providerOptions?.cursor?.modelName ?? null;

      if (name !== null && name !== "") {
        models.push(name);
      }
    }
  }

  return models;
};

const buildTurns = (
  rows: ChatStoreRows,
  roots: readonly RootSnapshot[]
): readonly ChatTurn[] => {
  const first = new Map<string, RootSnapshot>();
  const last = new Map<string, TurnStructure>();

  for (const root of roots) {
    for (const turn of root.turns) {
      if (!first.has(turn.key)) {
        first.set(turn.key, root);
      }

      last.set(turn.key, turn);
    }
  }

  return [...last.values()].map((turn) => {
    const root = first.get(turn.key);
    const message = userMessageOf(rows, turn.userMessageRef);

    return {
      activeBranch:
        root === undefined ? null : stringOf(root.fields, ROOT.activeBranch),
      key: turn.key,
      repos: root === undefined ? [] : trackedRepos(root.fields),
      requestId: turn.requestId,
      routedModel: turn.routedModel,
      startedAt: message.startedAt,
      steps: turn.stepRefs.length,
      toolCalls: toolCallsOf(rows, turn.stepRefs),
      userMessageId: turn.userMessageId ?? message.messageId,
    };
  });
};

export const decodeChatStore = (rows: ChatStoreRows): ChatModel | null => {
  const meta = decodeChatMeta(rows.meta);

  if (meta === null) {
    return null;
  }

  const roots = rootSnapshots(rows);

  const latest =
    (meta.latestRootBlobId === null
      ? null
      : blobMessage(rows, meta.latestRootBlobId)) ??
    roots.at(-1)?.fields ??
    null;

  const tokens =
    latest === null ? null : (messagesOf(latest, ROOT.tokenDetails)[0] ?? null);

  const first = roots[0]?.fields ?? latest;

  return {
    activeBranch: latest === null ? null : stringOf(latest, ROOT.activeBranch),
    agentType: latest === null ? null : stringOf(latest, ROOT.agentType),
    contextLimit: tokens === null ? null : numberOf(tokens, 2),
    contextUsed: tokens === null ? null : numberOf(tokens, 1),
    firstActiveBranch:
      first === null ? null : stringOf(first, ROOT.activeBranch),
    firstRepos: first === null ? [] : trackedRepos(first),
    meta,
    models: latest === null ? [] : modelsOf(rows, latest),
    repos: latest === null ? [] : trackedRepos(latest),
    startedAt: latest === null ? null : numberOf(latest, ROOT.startedAt),
    turns: buildTurns(rows, roots),
    workspaceUris: latest === null ? [] : stringsOf(latest, ROOT.workspaceUris),
  };
};
