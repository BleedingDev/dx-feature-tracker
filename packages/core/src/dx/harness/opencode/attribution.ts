import type { AiAttribution, AiTokens } from "../../model/attribution.js";
import type { BranchSource, ModelProvider } from "../ids.js";
import { normalizeModel, providerFor, viaFor } from "../provider.js";
import type { OcModel, OcSession, OcTokens } from "./rows.js";

const DEFAULT_VARIANT = "default";

export const modelRawOf = (model: OcModel | null): string | null => {
  if (model === null) {
    return null;
  }

  return model.providerId === null
    ? model.id
    : `${model.providerId}/${model.id}`;
};

const NOT_A_MAKER: ReadonlySet<ModelProvider> = new Set(["unknown", "local"]);

export const isModelMaker = (providerId: string): boolean =>
  !NOT_A_MAKER.has(providerFor(null, providerId));

export const viaOf = (model: OcModel | null): string | null => {
  if (model === null) {
    return null;
  }

  const known = viaFor(model.id, model.providerId);

  if (known !== null || model.providerId === null) {
    return known;
  }

  const hint = model.providerId.trim().toLowerCase();

  return isModelMaker(hint) ? null : hint;
};

export const effortOf = (model: OcModel | null): string | null => {
  const variant = model?.variant ?? null;

  return variant === null || variant.toLowerCase() === DEFAULT_VARIANT
    ? null
    : variant.toLowerCase();
};

export interface AttributionInput {
  readonly branchSource: BranchSource;
  readonly cwd: string | null;
  readonly model: OcModel | null;
  readonly session: OcSession;
}

export const attributionOf = (input: AttributionInput): AiAttribution => {
  const { model, session } = input;
  const effort = effortOf(model);
  const subagent = session.parentId !== null;

  return {
    agentId: subagent ? session.id : null,
    agentType: subagent ? session.agent : null,
    branchSource: input.branchSource,
    channel: "local-db",
    cwd: input.cwd,
    effort,
    effortSource: effort === null ? null : "harness-recorded",
    harness: "opencode",
    harnessVersion: session.version,
    model: normalizeModel(model?.id ?? null),
    modelRaw: modelRawOf(model),
    parentSessionId: session.parentId,
    provider: providerFor(model?.id ?? null, model?.providerId ?? null),
    sessionId: session.id,
    via: viaOf(model),
  };
};

export const aiTokensOf = (tokens: OcTokens): AiTokens => {
  const output = tokens.output + tokens.reasoning;

  return {
    cacheRead: tokens.cacheRead,
    cacheWrite: tokens.cacheWrite,
    cacheWrite1h: null,
    cacheWrite5m: null,
    inputFresh: tokens.input,
    output,
    reasoning: tokens.reasoning,
    total: tokens.input + tokens.cacheRead + tokens.cacheWrite + output,
  };
};
