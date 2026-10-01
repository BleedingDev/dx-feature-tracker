import { DateTime, Option } from "effect";

import type { AiTokens } from "../../model/attribution.js";
import type { ModelProvider } from "../ids.js";
import { inferProvider, inferVia, providerFor, viaFor } from "../provider.js";
import type { Usage } from "./format.js";

const ROUTE_SUFFIX = /-(?:official|account|api-key|api|platform)$/u;

export const providerHintOf = (configured: string | null): string | null => {
  if (configured === null) {
    return null;
  }

  let hint = configured.trim().toLowerCase();

  while (ROUTE_SUFFIX.test(hint)) {
    hint = hint.replace(ROUTE_SUFFIX, "");
  }

  return hint === "" ? null : hint;
};

const isMaker = (hint: string): boolean => {
  const maker = providerFor(null, hint);

  return maker !== "unknown" && maker !== "local";
};

export const makerOf = (
  modelRaw: string | null,
  configured: string | null
): ModelProvider => {
  const fromModel = inferProvider(modelRaw);

  return fromModel === "unknown"
    ? providerFor(modelRaw, providerHintOf(configured))
    : fromModel;
};

export const viaOf = (
  modelRaw: string | null,
  configured: string | null
): string | null => {
  const hint = providerHintOf(configured);

  if (hint === null) {
    return inferVia(modelRaw);
  }

  const known = viaFor(modelRaw, hint);

  if (known !== null) {
    return known;
  }

  return isMaker(hint) ? null : (configured?.trim().toLowerCase() ?? null);
};

export const isZeroUsage = (usage: Usage): boolean =>
  usage.inputTokens === 0 &&
  usage.outputTokens === 0 &&
  (usage.cacheReadTokens ?? 0) === 0 &&
  (usage.cacheWriteTokens ?? 0) === 0;

export const tokensOf = (usage: Usage): AiTokens => {
  const known =
    usage.inputTokens +
    usage.outputTokens +
    (usage.cacheReadTokens ?? 0) +
    (usage.cacheWriteTokens ?? 0);

  const consistent = usage.totalTokens === known;
  const cacheRead = usage.cacheReadTokens ?? (consistent ? 0 : null);
  const cacheWrite = usage.cacheWriteTokens ?? (consistent ? 0 : null);

  return {
    cacheRead,
    cacheWrite,
    cacheWrite1h: null,
    cacheWrite5m: null,
    inputFresh: usage.inputTokens,
    output: usage.outputTokens,
    reasoning: usage.reasoningTokens ?? null,
    total:
      usage.totalTokens ??
      (cacheRead === null || cacheWrite === null ? null : known),
  };
};

export const isoOf = (time: number | null): string | null =>
  time === null
    ? null
    : Option.match(DateTime.make(time), {
        onNone: () => null,
        onSome: DateTime.formatIso,
      });
