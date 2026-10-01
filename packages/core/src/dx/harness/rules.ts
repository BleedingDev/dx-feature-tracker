import { Option, Schema } from "effect";

import type { DxEventEnvelope } from "../model/event.js";
import { CURSOR_RULES } from "./cursor/rules.js";
import { HARNESS_IDS } from "./ids.js";
import type { HarnessId } from "./ids.js";

export type ModelEffortSource =
  | "model-name-suffix"
  | "source-field"
  | "unavailable";

export interface ModelEffort {
  readonly effort: string | null;
  readonly effortReason: string | null;
  readonly effortSource: ModelEffortSource;
  readonly model: string;
}

export interface RawUsageReading {
  readonly categories: Readonly<Record<string, number>>;
  readonly verifiedFields: readonly string[];
}

export interface RawUsageRule {
  readonly adapterId: string;
  readonly read: (
    raw: Readonly<Record<string, number>>
  ) => RawUsageReading | null;
  readonly reason: string;
  readonly sourceKind: string;
}

export interface ListPriceRule {
  readonly field: string;
}

export type ChatEvidenceRole =
  | "agent-stream"
  | "chat-store"
  | "prompt-hooks"
  | "transcript";

export type ChatSessionIdKind = "composerId" | "conversationId" | "sessionId";

export interface ChatChannelRole {
  readonly idKind: ChatSessionIdKind;
  readonly labels: Readonly<
    Partial<Record<"duration" | "requests" | "toolCalls", string>>
  >;
  readonly role: ChatEvidenceRole;
}

export interface HarnessRules {
  readonly chatRole: (event: DxEventEnvelope) => ChatChannelRole | null;
  readonly claims: (event: DxEventEnvelope) => boolean;
  readonly effort: (rawModel: string, recorded: string | null) => ModelEffort;
  readonly listPrice: ListPriceRule | null;
  readonly rawUsage: RawUsageRule | null;
  readonly sourceKindAliases: ReadonlyMap<string, string>;
  readonly takesHookTurn: (event: DxEventEnvelope) => boolean;
}

export const recordedEffort = (
  rawModel: string,
  recorded: string | null
): ModelEffort => {
  const model = rawModel.trim();

  return recorded === null
    ? {
        effort: null,
        effortReason: "the source reports no reasoning level for this model",
        effortSource: "unavailable",
        model,
      }
    : {
        effort: recorded,
        effortReason: null,
        effortSource: "source-field",
        model,
      };
};

export const DEFAULT_RULES: HarnessRules = {
  chatRole: () => null,
  claims: () => false,
  effort: recordedEffort,
  listPrice: null,
  rawUsage: null,
  sourceKindAliases: new Map(),
  takesHookTurn: (event) => event.ai !== null,
};

export const HARNESS_RULES: Readonly<Record<HarnessId, HarnessRules>> = {
  "claude-code": DEFAULT_RULES,
  codex: DEFAULT_RULES,
  cursor: CURSOR_RULES,
  deepseek: DEFAULT_RULES,
  omp: DEFAULT_RULES,
  opencode: DEFAULT_RULES,
  pi: DEFAULT_RULES,
};

export const rulesFor = (harness: HarnessId | null): HarnessRules =>
  harness === null ? DEFAULT_RULES : HARNESS_RULES[harness];

export const harnessOfEvent = (event: DxEventEnvelope): HarnessId | null =>
  event.ai?.harness ??
  HARNESS_IDS.find((id) => HARNESS_RULES[id].claims(event)) ??
  null;

export const rulesForEvent = (event: DxEventEnvelope): HarnessRules =>
  rulesFor(harnessOfEvent(event));

const ALL_RULES = HARNESS_IDS.map((id) => HARNESS_RULES[id]);

export const SOURCE_KIND_ALIASES: ReadonlyMap<string, string> = new Map(
  ALL_RULES.flatMap((rules) => [...rules.sourceKindAliases])
);

export const LIST_PRICE_FIELDS: ReadonlySet<string> = new Set(
  ALL_RULES.flatMap((rules) =>
    rules.listPrice === null ? [] : [rules.listPrice.field]
  )
);

export const rawUsageRuleFor = (sourceKind: string | null) =>
  ALL_RULES.find((rules) => rules.rawUsage?.sourceKind === sourceKind)
    ?.rawUsage ?? null;

const decodeSourceKind = Schema.decodeUnknownOption(Schema.String);

export const sourceKindOfEvent = (event: DxEventEnvelope): string | null =>
  Option.getOrNull(decodeSourceKind(event.payload.sourceKind));
