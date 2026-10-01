import { Option, Schema } from "effect";

import { decodeMetaLine } from "./records.js";
import type { SessionMeta } from "./records.js";

export const CodexHeadSchema = Schema.Struct({
  agentNickname: Schema.NullOr(Schema.String),
  agentPath: Schema.NullOr(Schema.String),
  agentRole: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  cliVersion: Schema.NullOr(Schema.String),
  commit: Schema.NullOr(Schema.String),
  cwd: Schema.NullOr(Schema.String),
  depth: Schema.NullOr(Schema.Finite),
  forkedFromId: Schema.NullOr(Schema.String),
  originator: Schema.NullOr(Schema.String),
  parentId: Schema.NullOr(Schema.String),
  providerId: Schema.NullOr(Schema.String),
  rootId: Schema.NullOr(Schema.String),
  source: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(Schema.String),
  subagentKind: Schema.NullOr(Schema.String),
  threadId: Schema.String,
});

export type CodexHead = typeof CodexHeadSchema.Type;

const isText = Schema.is(Schema.String);

const present = (value: string | null | undefined): string | null =>
  value === null || value === undefined || value.trim() === "" ? null : value;

interface SourceFacts {
  readonly kind: string | null;
  readonly other: string | null;
  readonly source: string | null;
  readonly spawn: {
    readonly agent_nickname?: string | null | undefined;
    readonly agent_path?: string | null | undefined;
    readonly agent_role?: string | null | undefined;
    readonly depth?: number | null | undefined;
    readonly parent_thread_id?: string | null | undefined;
  } | null;
}

const sourceFacts = (source: SessionMeta["source"]): SourceFacts => {
  if (source === null || source === undefined) {
    return { kind: null, other: null, source: null, spawn: null };
  }

  if (isText(source)) {
    return { kind: null, other: null, source, spawn: null };
  }

  const { subagent } = source;

  if (subagent === null || subagent === undefined) {
    return { kind: null, other: null, source: null, spawn: null };
  }

  if (isText(subagent)) {
    return { kind: "other", other: subagent, source: "subagent", spawn: null };
  }

  const spawn = subagent.thread_spawn ?? null;

  return {
    kind: spawn === null ? "other" : "thread_spawn",
    other: present(subagent.other),
    source: "subagent",
    spawn,
  };
};

export const headOfMeta = (
  meta: SessionMeta,
  lineTimestamp: string | null
): CodexHead => {
  const facts = sourceFacts(meta.source);
  const rootId = present(meta.session_id);

  const parentId =
    present(meta.parent_thread_id) ??
    present(facts.spawn?.parent_thread_id) ??
    (rootId !== null && rootId !== meta.id ? rootId : null);

  return {
    agentNickname:
      present(meta.agent_nickname) ?? present(facts.spawn?.agent_nickname),
    agentPath: present(meta.agent_path) ?? present(facts.spawn?.agent_path),
    agentRole:
      present(meta.agent_role) ??
      present(facts.spawn?.agent_role) ??
      facts.other,
    branch: present(meta.git?.branch),
    cliVersion: present(meta.cli_version),
    commit: present(meta.git?.commit_hash),
    cwd: present(meta.cwd),
    depth: facts.spawn?.depth ?? null,
    forkedFromId: present(meta.forked_from_id),
    originator: present(meta.originator),
    parentId,
    providerId: present(meta.model_provider),
    rootId,
    source: facts.source,
    startedAt: present(meta.timestamp) ?? lineTimestamp,
    subagentKind: facts.kind,
    threadId: meta.id,
  };
};

export const decodeHeadLine = (line: string): CodexHead | null =>
  Option.match(decodeMetaLine(line), {
    onNone: () => null,
    onSome: (decoded) =>
      headOfMeta(decoded.payload, present(decoded.timestamp)),
  });

export const isSubagent = (head: CodexHead): boolean =>
  head.source === "subagent" || head.parentId !== null;

const UUID_V7 =
  /^(?<high>[0-9a-f]{8})-(?<low>[0-9a-f]{4})-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export const uuidV7Millis = (id: string): number | null => {
  const groups = UUID_V7.exec(id)?.groups;

  return groups === undefined
    ? null
    : Number.parseInt(`${groups.high ?? ""}${groups.low ?? ""}`, 16);
};

export const replaysParentHistory = (head: CodexHead): boolean =>
  head.forkedFromId !== null && uuidV7Millis(head.threadId) !== null;

export const startsOwnHistory = (head: CodexHead, turnId: string): boolean => {
  const thread = uuidV7Millis(head.threadId);
  const turn = uuidV7Millis(turnId);

  return thread === null || (turn !== null && turn >= thread);
};

const THREAD_ID_IN_NAME =
  /(?<id>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/iu;

export const threadIdOfFile = (file: string): string | null =>
  THREAD_ID_IN_NAME.exec(file)?.groups?.id?.toLowerCase() ?? null;
