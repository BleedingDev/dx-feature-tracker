import { harnessChannelRank } from "../../harness/source-kinds.js";
import type { LedgerKind, TokenCategory } from "../../model/ai.js";
import type { AiTokens, ToolFigure } from "../../model/attribution.js";
import type { DxEventEnvelope } from "../../model/event.js";

export const cacheWritesOf = (tokens: AiTokens): number | null =>
  tokens.cacheWrite1h === null && tokens.cacheWrite5m === null
    ? tokens.cacheWrite
    : Math.max(
        tokens.cacheWrite ?? 0,
        (tokens.cacheWrite5m ?? 0) + (tokens.cacheWrite1h ?? 0)
      );

export const tokenCategoriesOf = (
  tokens: AiTokens
): readonly (readonly [TokenCategory, number])[] => {
  const entries: readonly (readonly [TokenCategory, number | null])[] = [
    ["input", tokens.inputFresh],
    ["cached-input", tokens.cacheRead],
    ["cache-write", cacheWritesOf(tokens)],
    ["output", tokens.output],
    ["reasoning", tokens.reasoning],
    ["total", tokens.total],
  ];

  return entries.flatMap(([category, value]) =>
    value === null ? [] : [[category, value] as const]
  );
};

export const knownTokenTotal = (tokens: AiTokens): number | null => {
  if (tokens.total !== null) {
    return tokens.total;
  }

  const parts = [
    tokens.inputFresh,
    tokens.cacheRead,
    cacheWritesOf(tokens),
    tokens.output,
  ];

  return parts.every((part) => part === null)
    ? null
    : parts.reduce<number>((sum, part) => sum + (part ?? 0), 0);
};

export const eventTokens = (event: DxEventEnvelope): AiTokens | null =>
  event.usage?.tokens ?? null;

export interface FigureLedger {
  readonly currency: string;
  readonly ledger: LedgerKind;
  readonly value: number;
}

export const figureLedger = (figure: ToolFigure | null): FigureLedger | null =>
  figure === null
    ? null
    : {
        currency: figure.currency,
        ledger: figure.kind === "charge" ? "charge" : "list-price-estimate",
        value: figure.amount,
      };

const UNBILLED_LEDGERS: ReadonlySet<unknown> = new Set([
  "metered",
  "unallocated",
]);

export const billedFigureOf = (event: DxEventEnvelope): ToolFigure | null => {
  const figure = event.usage?.toolFigure ?? null;

  return figure !== null &&
    figure.kind === "charge" &&
    !UNBILLED_LEDGERS.has(event.payload.costLedger)
    ? figure
    : null;
};

export const toolOwnFigureOf = (event: DxEventEnvelope): ToolFigure | null => {
  const figure = event.usage?.toolFigure ?? null;

  return figure === null || billedFigureOf(event) !== null ? null : figure;
};

export interface TypedSource {
  readonly label: string;
  readonly rank: number;
}

export const typedSourceOf = (event: DxEventEnvelope): TypedSource | null =>
  event.ai === null
    ? null
    : {
        label: `${event.ai.harness}/${event.ai.channel}`,
        rank: harnessChannelRank(event.ai.harness, event.ai.channel),
      };
