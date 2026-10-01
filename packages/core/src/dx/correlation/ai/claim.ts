import { Option, Schema } from "effect";

import {
  UNKNOWN_SOURCE_RANK,
  aiSourceRank,
} from "../../harness/source-kinds.js";
import {
  figureLedger,
  tokenCategoriesOf,
  typedSourceOf,
} from "../../metrics/ai-usage/typed.js";
import {
  AiSourceKindSchema,
  LedgerKindSchema,
  canonicalRequestKey,
} from "../../model/ai.js";
import type { LedgerKind, TokenCategory } from "../../model/ai.js";
import type { DxEventEnvelope } from "../../model/event.js";
import { EvidenceIdSchema, RequestKeySchema } from "../../model/ids.js";
import type { EvidenceId, RequestKey } from "../../model/ids.js";

export const AI_CLAIM_KINDS: ReadonlySet<string> = new Set([
  "ai.request",
  "ai.turn",
  "ai.usage",
]);

export const AGGREGATE_SOURCE_KINDS: ReadonlySet<string> = new Set([
  "dashboard-json",
]);

export interface ClaimAmount {
  readonly category: TokenCategory | null;
  readonly currency: string | null;
  readonly ledger: LedgerKind;
  readonly value: number;
}

export interface AiClaim {
  readonly aggregate: boolean;
  readonly amounts: readonly ClaimAmount[];
  readonly event: DxEventEnvelope;
  readonly estimated: boolean;
  readonly evidenceId: EvidenceId;
  readonly occurredMs: number | null;
  readonly rank: number;
  readonly requestKey: RequestKey | null;
  readonly sourceKind: string;
  readonly strongKeys: readonly string[];
  readonly turnKey: string | null;
}

const nonEmpty = (value: string | null): string | null =>
  value === null || value === "" ? null : value;

const isLedger = Schema.is(LedgerKindSchema);

const isAiSourceKind = Schema.is(AiSourceKindSchema);

const MeasurementViewSchema = Schema.Struct({
  category: Schema.optionalKey(Schema.NullOr(Schema.String)),
  currency: Schema.optionalKey(Schema.NullOr(Schema.String)),
  ledger: Schema.String,
  unit: Schema.optionalKey(Schema.NullOr(Schema.String)),
  value: Schema.NullOr(Schema.Finite),
});

const PayloadViewSchema = Schema.Struct({
  aggregate: Schema.optionalKey(Schema.Boolean),
  charge: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  costLedger: Schema.optionalKey(Schema.NullOr(Schema.String)),
  costUsd: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  measurements: Schema.optionalKey(Schema.Array(MeasurementViewSchema)),
  sourceKind: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

type PayloadView = typeof PayloadViewSchema.Type;

type MeasurementView = typeof MeasurementViewSchema.Type;

const decodePayload = Schema.decodeUnknownOption(PayloadViewSchema);

const EMPTY_VIEW: PayloadView = {};

export const payloadView = (event: DxEventEnvelope): PayloadView =>
  decodePayload(event.payload).pipe(Option.getOrElse(() => EMPTY_VIEW));

const tokenAmounts = (event: DxEventEnvelope): ClaimAmount[] =>
  event.usage === null
    ? []
    : tokenCategoriesOf(event.usage.tokens).map(([category, value]) => ({
        category,
        currency: null,
        ledger: "tokens" as const,
        value,
      }));

const figureAmounts = (event: DxEventEnvelope): ClaimAmount[] => {
  const figure = figureLedger(event.usage?.toolFigure ?? null);

  return figure === null
    ? []
    : [
        {
          category: null,
          currency: figure.currency,
          ledger: figure.ledger,
          value: figure.value,
        },
      ];
};

const measurementAmount = (entry: MeasurementView): ClaimAmount[] => {
  const { ledger, value } = entry;

  if (value === null || !isLedger(ledger) || ledger === "tokens") {
    return [];
  }

  const cents = entry.unit === "usd-cents";

  return [
    {
      category: null,
      currency: cents ? "USD" : (entry.currency ?? null),
      ledger,
      value: cents ? value / 100 : value,
    },
  ];
};

const moneyAmounts = (view: PayloadView): ClaimAmount[] => {
  const charge = view.charge ?? null;

  if (charge !== null) {
    return [
      { category: null, currency: "USD", ledger: "charge", value: charge },
    ];
  }

  const cost = view.costUsd ?? null;
  const ledger = view.costLedger ?? null;

  return cost !== null && isLedger(ledger)
    ? [{ category: null, currency: "USD", ledger, value: cost }]
    : [];
};

const amountsOf = (
  event: DxEventEnvelope,
  view: PayloadView
): ClaimAmount[] => {
  const money = [
    ...(view.measurements ?? []).flatMap(measurementAmount),
    ...moneyAmounts(view),
  ];

  return [
    ...tokenAmounts(event),
    ...(money.length === 0 ? figureAmounts(event) : money),
  ];
};

export const sourceRank = (sourceKind: string): number =>
  isAiSourceKind(sourceKind) ? aiSourceRank(sourceKind) : UNKNOWN_SOURCE_RANK;

const requestKeyOf = (
  sourceKind: string,
  requestId: string | null,
  sessionId: string | null,
  generationId: string | null
): RequestKey | null => {
  if (isAiSourceKind(sourceKind)) {
    return canonicalRequestKey({
      generationId,
      requestId,
      sessionId,
      sourceKind,
      turnIndex: null,
    });
  }

  if (requestId !== null) {
    return RequestKeySchema.make(`source:${sourceKind}:request:${requestId}`);
  }

  return sessionId !== null && generationId !== null
    ? RequestKeySchema.make(
        `source:${sourceKind}:session:${sessionId}:turn:${generationId}`
      )
    : null;
};

const parseMs = (iso: string | null): number | null => {
  if (iso === null) {
    return null;
  }

  const ms = Date.parse(iso);

  return Number.isNaN(ms) ? null : ms;
};

export const toClaim = (event: DxEventEnvelope): AiClaim | null => {
  if (!AI_CLAIM_KINDS.has(event.kind)) {
    return null;
  }

  const { identity } = event;
  const view = payloadView(event);

  const typed =
    view.sourceKind === undefined || view.sourceKind === null
      ? typedSourceOf(event)
      : null;

  const sourceKind = view.sourceKind ?? typed?.label ?? event.adapterId;

  const requestId = nonEmpty(identity.requestId);
  const sessionId = nonEmpty(identity.sessionId);
  const turnPart = nonEmpty(identity.generationId) ?? nonEmpty(identity.turnId);

  const turnKey =
    sessionId !== null && turnPart !== null ? `${sessionId}:${turnPart}` : null;

  const strongKeys = [
    ...(requestId === null ? [] : [`request:${requestId}`]),
    ...(turnKey === null ? [] : [`turn:${turnKey}`]),
  ];

  const estimated =
    sourceKind === "transcript-estimate" ||
    event.fieldSemantics.some((field) => field.method === "estimated");

  return {
    aggregate:
      AGGREGATE_SOURCE_KINDS.has(sourceKind) || view.aggregate === true,
    amounts: amountsOf(event, view),
    estimated,
    event,
    evidenceId: EvidenceIdSchema.make(event.eventId),
    occurredMs: parseMs(event.occurredAt),
    rank: typed?.rank ?? sourceRank(sourceKind),
    requestKey: requestKeyOf(
      sourceKind,
      requestId,
      sessionId,
      nonEmpty(identity.generationId)
    ),
    sourceKind,
    strongKeys,
    turnKey,
  };
};

const KIND_ORDER = {
  "ai.request": 2,
  "ai.turn": 1,
  "ai.usage": 0,
} as const;

const kindOrder = (kind: string): number =>
  kind === "ai.request" || kind === "ai.turn" || kind === "ai.usage"
    ? KIND_ORDER[kind]
    : 3;

export const compareText = (a: string, b: string): number => {
  if (a === b) {
    return 0;
  }

  return a < b ? -1 : 1;
};

export const compareClaims = (a: AiClaim, b: AiClaim): number =>
  a.rank - b.rank ||
  Number(a.estimated) - Number(b.estimated) ||
  kindOrder(a.event.kind) - kindOrder(b.event.kind) ||
  compareText(a.event.eventId, b.event.eventId);
