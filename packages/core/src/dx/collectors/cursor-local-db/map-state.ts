import { Option } from "effect";

import type { Origin } from "../../model/common.js";
import type { DxEventEnvelope, FlightContext } from "../../model/event.js";
import { buildEnvelope, reported, toIso } from "./envelope.js";
import {
  decodeBubbleJson,
  decodeComposerJson,
  decodeLegacyIndex,
} from "./schemas.js";
import type { BubbleJson, ComposerJson, HeaderRow } from "./schemas.js";
import type { StateDbRows } from "./snapshot.js";

export interface MapContext {
  readonly context: FlightContext;
  readonly observedAt: string;
  readonly origin: Origin;
  readonly sourceHash: string;
}

export interface MapResult {
  readonly events: readonly DxEventEnvelope[];
  readonly excluded: number;
  readonly unreadable: number;
  readonly watermark: string | null;
}

interface ComposerRecord {
  readonly composerId: string;
  readonly header: ComposerJson | null;
  readonly headerRow: HeaderRow | null;
  readonly data: ComposerJson | null;
}

interface BubbleRecord {
  readonly composerId: string;
  readonly bubbleId: string;
  readonly value: BubbleJson;
}

export const scopeNeedles = (context: FlightContext): readonly string[] =>
  [context.worktreePath, context.repoCommonDir?.replace(/\/\.git\/?$/u, "")]
    .filter((value) => value !== null && value !== undefined)
    .filter((value) => value.length > 1);

export const maxIso = (values: readonly (string | null)[]) => {
  let best: string | null = null;

  for (const value of values) {
    if (value !== null && (best === null || value > best)) {
      best = value;
    }
  }

  return best;
};

const emptyRecord = (composerId: string): ComposerRecord => ({
  composerId,
  data: null,
  header: null,
  headerRow: null,
});

const collectComposers = (rows: StateDbRows) => {
  const composers = new Map<string, ComposerRecord>();

  const upsert = (composerId: string, patch: Partial<ComposerRecord>) => {
    composers.set(composerId, {
      ...(composers.get(composerId) ?? emptyRecord(composerId)),
      ...patch,
    });
  };

  const bubbles: BubbleRecord[] = [];
  let unreadable = 0;

  for (const row of rows.headers) {
    upsert(row.composerId, {
      header: Option.getOrNull(decodeComposerJson(row.value)),
      headerRow: row,
    });
  }

  for (const row of rows.items) {
    const index = Option.getOrNull(decodeLegacyIndex(row.value));

    for (const header of index?.allComposers ?? []) {
      const composerId = header.composerId ?? null;

      if (composerId !== null && !composers.has(composerId)) {
        upsert(composerId, { header });
      }
    }
  }

  for (const row of rows.kv) {
    const [prefix, composerId, bubbleId] = row.key.split(":");

    if (prefix === "composerData" && composerId !== undefined) {
      const data = Option.getOrNull(decodeComposerJson(row.value));

      if (data === null) {
        unreadable += 1;
      } else {
        upsert(composerId, { data });
      }
    } else if (composerId !== undefined && bubbleId !== undefined) {
      const value = Option.getOrNull(decodeBubbleJson(row.value));

      if (value === null) {
        unreadable += 1;
      } else {
        bubbles.push({ bubbleId, composerId, value });
      }
    }
  }

  return { bubbles, composers, unreadable };
};

const field = <K extends keyof ComposerJson>(
  record: ComposerRecord,
  key: K
): ComposerJson[K] | null => record.data?.[key] ?? record.header?.[key] ?? null;

const inScope = (needles: readonly string[], record: ComposerRecord) => {
  const evidence = JSON.stringify([
    field(record, "trackedGitRepos"),
    field(record, "workspaceIdentifier"),
  ]);

  return (
    needles.length === 0 || needles.some((needle) => evidence.includes(needle))
  );
};

const sessionEvent = (
  record: ComposerRecord,
  ctx: MapContext,
  version: string
) =>
  buildEnvelope({
    context: ctx.context,
    fieldSemantics: [
      reported("linesAdded", "totalLinesAdded", "lines"),
      reported("linesRemoved", "totalLinesRemoved", "lines"),
      reported("filesAdded", "addedFiles", "files"),
      reported("filesRemoved", "removedFiles", "files"),
      reported(
        "contextMeter.tokensUsed",
        "contextTokensUsed",
        "tokens",
        "Context window occupancy meter; not token spend and not billed"
      ),
    ],
    identity: { sessionId: record.composerId },
    kind: "ai.session",
    observedAt: ctx.observedAt,
    occurredAt: toIso(field(record, "createdAt")),
    origin: ctx.origin,
    payload: {
      contextMeter: {
        limitTokens: record.data?.contextTokenLimit ?? null,
        notSpend: true,
        tokensUsed: record.data?.contextTokensUsed ?? null,
        usagePercent: record.data?.contextUsagePercent ?? null,
      },
      createdAt: toIso(field(record, "createdAt")),
      filesAdded: field(record, "addedFiles"),
      filesRemoved: field(record, "removedFiles"),
      isAgentic: record.data?.isAgentic ?? null,
      isSubagent: record.headerRow?.isSubagent === 1,
      lastUpdatedAt: toIso(field(record, "lastUpdatedAt")),
      linesAdded: field(record, "totalLinesAdded"),
      linesRemoved: field(record, "totalLinesRemoved"),
      maxMode: record.data?.modelConfig?.maxMode ?? null,
      mode: field(record, "unifiedMode"),
      model: record.data?.modelConfig?.modelName ?? null,
      sourceKind: "local-db",
      status: record.data?.status ?? null,
      workspaceId: record.headerRow?.workspaceId ?? null,
    },
    sourceHash: ctx.sourceHash,
    sourceVersion: version,
    upstreamKey: `composer:${record.composerId}`,
  });

const usageEvents = (
  record: ComposerRecord,
  ctx: MapContext,
  version: string
) =>
  Object.entries(record.data?.usageData ?? {}).flatMap(([model, entry]) => {
    const cents = entry.costInCents ?? null;
    const requests = entry.amount ?? null;

    if (cents === null && requests === null) {
      return [];
    }

    return [
      buildEnvelope({
        context: ctx.context,
        fieldSemantics: [
          reported(
            "measurements.metered",
            "usageData.costInCents",
            "usd-cents",
            "Local IDE metered value; not a billed charge"
          ),
          reported("requests", "usageData.amount", "requests"),
        ],
        identity: { sessionId: record.composerId },
        kind: "ai.usage",
        observedAt: ctx.observedAt,
        occurredAt: toIso(field(record, "lastUpdatedAt")),
        origin: ctx.origin,
        payload: {
          measurements:
            cents === null
              ? []
              : [
                  {
                    category: "other",
                    cumulativeVerified: false,
                    currency: "USD",
                    ledger: "metered",
                    method: "source-reported",
                    rawCategory: "usageData.costInCents",
                    unit: "usd-cents",
                    value: cents,
                  },
                ],
          model,
          requests,
          sourceKind: "local-db",
        },
        sourceHash: ctx.sourceHash,
        sourceVersion: version,
        upstreamKey: `composer:${record.composerId}:usage:${model}`,
      }),
    ];
  });

const ZERO_TOKENS_REASON =
  "Cursor stored zero token counts; treated as not recorded rather than a measured zero";

const tokenMeasurements = (value: BubbleJson) => {
  const input = value.tokenCount?.inputTokens ?? null;
  const output = value.tokenCount?.outputTokens ?? null;

  if (input === null && output === null) {
    return { measurements: [], reason: "tokenCount absent" };
  }

  if ((input ?? 0) === 0 && (output ?? 0) === 0) {
    return { measurements: [], reason: ZERO_TOKENS_REASON };
  }

  const measurements = [
    { category: "input", raw: "tokenCount.inputTokens", value: input },
    { category: "output", raw: "tokenCount.outputTokens", value: output },
  ].flatMap((entry) =>
    entry.value === null
      ? []
      : [
          {
            category: entry.category,
            cumulativeVerified: false,
            currency: null,
            ledger: "tokens",
            method: "source-reported",
            rawCategory: entry.raw,
            unit: "tokens",
            value: entry.value,
          },
        ]
  );

  return { measurements, reason: null };
};

const roleOf = (type: number | null | undefined) => {
  if (type === 1) {
    return "user";
  }

  return type === 2 ? "assistant" : null;
};

const turnEvent = (bubble: BubbleRecord, ctx: MapContext, version: string) => {
  const tokens = tokenMeasurements(bubble.value);

  return buildEnvelope({
    context: ctx.context,
    fieldSemantics: [
      reported("measurements.input", "tokenCount.inputTokens", "tokens"),
      reported("measurements.output", "tokenCount.outputTokens", "tokens"),
      reported("toolName", "toolFormerData.name", null),
    ],
    identity: {
      generationId: bubble.bubbleId,
      requestId: bubble.value.requestId ?? null,
      sessionId: bubble.composerId,
      turnId: `${bubble.composerId}:${bubble.bubbleId}`,
    },
    kind: "ai.turn",
    observedAt: ctx.observedAt,
    occurredAt: toIso(bubble.value.createdAt),
    origin: ctx.origin,
    payload: {
      measurements: tokens.measurements,
      model: bubble.value.modelInfo?.modelName ?? null,
      role: roleOf(bubble.value.type),
      sourceKind: "local-db",
      tokensUnavailableReason: tokens.reason,
      toolName: bubble.value.toolFormerData?.name ?? null,
      toolStatus: bubble.value.toolFormerData?.status ?? null,
    },
    sourceHash: ctx.sourceHash,
    sourceVersion: version,
    upstreamKey: `bubble:${bubble.composerId}:${bubble.bubbleId}`,
  });
};

export const mapStateDb = (rows: StateDbRows, ctx: MapContext): MapResult => {
  const { bubbles, composers, unreadable } = collectComposers(rows);
  const needles = scopeNeedles(ctx.context);

  const kept = [...composers.values()].filter((record) =>
    inScope(needles, record)
  );

  const keptIds = new Set(kept.map((record) => record.composerId));

  const keptBubbles = bubbles.filter((bubble) =>
    keptIds.has(bubble.composerId)
  );

  const events = [
    ...kept.flatMap((record) => [
      sessionEvent(record, ctx, rows.layout),
      ...usageEvents(record, ctx, rows.layout),
    ]),
    ...keptBubbles.map((bubble) => turnEvent(bubble, ctx, rows.layout)),
  ];

  return {
    events,
    excluded:
      composers.size - kept.length + bubbles.length - keptBubbles.length,
    unreadable,
    watermark: maxIso(
      kept.map((record) => toIso(field(record, "lastUpdatedAt")))
    ),
  };
};
