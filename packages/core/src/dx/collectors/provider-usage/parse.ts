// @effect-diagnostics-next-line nodeBuiltinImport:off -- Event IDs are synchronous sha256 digests fixed by the v1 contract; node:crypto is the only synchronous digest available to this pure parser.
import { createHash } from "node:crypto";

import { DateTime, Option, Result, Schema } from "effect";

import type { Origin, TimePrecision } from "../../model/common.js";
import type { SourceCoverage, SourceGap } from "../../model/coverage.js";
import { EVENT_SCHEMA_VERSION } from "../../model/event.js";
import type {
  DxEventEnvelope,
  EventBatch,
  FieldSemantics,
  FlightContext,
} from "../../model/event.js";
import { EventIdSchema } from "../../model/ids.js";
import {
  PROVIDER_USAGE_ADAPTER_ID,
  PROVIDER_USAGE_ADAPTER_VERSION,
} from "./descriptor.js";
import {
  AnthropicCostPageSchema,
  AnthropicUsagePageSchema,
  OpenAiCostPageSchema,
  OpenAiUsagePageSchema,
} from "./formats.js";
import type {
  AnthropicUsageResult,
  OpenAiCostResult,
  OpenAiUsageResult,
  ProviderUsageFormat,
} from "./formats.js";

export interface ParseMeta {
  readonly context: FlightContext;
  readonly fileLabel: string;
  readonly observedAt: string;
  readonly origin: Origin;
}

interface Bucket<Row> {
  readonly from: string;
  readonly results: readonly Row[];
  readonly to: string;
  readonly widthSeconds: number;
}

interface RowFacts {
  readonly charge: {
    readonly currency: string | null;
    readonly value: number;
  } | null;
  readonly dimensions: Readonly<Record<string, string | null>>;
  readonly model: string | null;
  readonly requests: number | null;
  readonly semantics: readonly FieldSemantics[];
  readonly tokens: Readonly<Record<string, number>> | null;
  readonly unavailable: readonly {
    readonly field: string;
    readonly reason: string;
  }[];
}

const sha256 = (text: string): string =>
  `sha256:${createHash("sha256").update(text).digest("hex")}`;

const eventIdFor = (upstreamKey: string) =>
  EventIdSchema.make(
    sha256(`${PROVIDER_USAGE_ADAPTER_ID}\u0000${upstreamKey}\u0000ai.usage`)
  );

const semantic = (
  field: string,
  method: FieldSemantics["method"],
  rawName: string | null,
  unit: string | null,
  note: string | null = null
): FieldSemantics => ({ field, method, note, rawName, unit });

const count = (value: number | null | undefined): number | null =>
  value ?? null;

const text = (value: string | null | undefined): string | null =>
  value === null || value === undefined || value === "" ? null : value;

const precisionFor = (widthSeconds: number): TimePrecision =>
  widthSeconds >= 86_400 ? "day" : "minute";

const openAiUsageFacts = (row: OpenAiUsageResult): RowFacts => {
  const input = count(row.input_tokens);
  const cached = count(row.input_cached_tokens);
  const output = count(row.output_tokens);
  const tokens: Record<string, number> = {};
  const semantics: FieldSemantics[] = [];
  const unavailable: { field: string; reason: string }[] = [];

  if (input === null) {
    unavailable.push({
      field: "tokens.input",
      reason: "input_tokens missing in export",
    });
  } else {
    tokens.input = input - (cached ?? 0);
    semantics.push(
      semantic(
        "tokens.input",
        cached === null ? "source-reported" : "derived",
        "input_tokens",
        "tokens",
        cached === null
          ? null
          : "input_tokens minus input_cached_tokens (OpenAI reports cached input as a subset)"
      )
    );
  }

  if (cached !== null) {
    tokens["cached-input"] = cached;
    semantics.push(
      semantic(
        "tokens.cached-input",
        "source-reported",
        "input_cached_tokens",
        "tokens"
      )
    );
  }

  if (output === null) {
    unavailable.push({
      field: "tokens.output",
      reason: "output_tokens missing in export",
    });
  } else {
    tokens.output = output;
    semantics.push(
      semantic("tokens.output", "source-reported", "output_tokens", "tokens")
    );
  }

  const requests = count(row.num_model_requests);

  if (requests !== null) {
    semantics.push(
      semantic("requests", "source-reported", "num_model_requests", "requests")
    );
  }

  unavailable.push({
    field: "charge",
    reason:
      "usage export carries no charge; import the costs export separately",
  });

  return {
    charge: null,
    dimensions: {
      apiKeyId: text(row.api_key_id),
      projectId: text(row.project_id),
    },
    model: text(row.model),
    requests,
    semantics,
    tokens,
    unavailable,
  };
};

const openAiCostFacts = (row: OpenAiCostResult): RowFacts => {
  const value = count(row.amount?.value);
  const currency = text(row.amount?.currency);

  return {
    charge:
      value === null
        ? null
        : {
            currency: currency === null ? null : currency.toUpperCase(),
            value,
          },
    dimensions: {
      lineItem: text(row.line_item),
      projectId: text(row.project_id),
    },
    model: null,
    requests: null,
    semantics:
      value === null
        ? []
        : [
            semantic(
              "charge",
              "source-reported",
              "amount.value",
              currency === null ? null : currency.toUpperCase()
            ),
          ],
    tokens: null,
    unavailable: [
      ...(value === null
        ? [{ field: "charge", reason: "amount.value missing in export" }]
        : []),
      { field: "tokens", reason: "costs export carries no token counts" },
    ],
  };
};

const anthropicUsageFacts = (row: AnthropicUsageResult): RowFacts => {
  const tokens: Record<string, number> = {};
  const semantics: FieldSemantics[] = [];
  const unavailable: { field: string; reason: string }[] = [];
  const input = count(row.uncached_input_tokens);

  if (input === null) {
    unavailable.push({
      field: "tokens.input",
      reason: "uncached_input_tokens null in export",
    });
  } else {
    tokens.input = input;
    semantics.push(
      semantic(
        "tokens.input",
        "source-reported",
        "uncached_input_tokens",
        "tokens"
      )
    );
  }

  const cacheRead = count(row.cache_read_input_tokens);

  if (cacheRead !== null) {
    tokens["cached-input"] = cacheRead;
    semantics.push(
      semantic(
        "tokens.cached-input",
        "source-reported",
        "cache_read_input_tokens",
        "tokens"
      )
    );
  }

  const write5m = count(row.cache_creation?.ephemeral_5m_input_tokens);
  const write1h = count(row.cache_creation?.ephemeral_1h_input_tokens);

  if (write5m !== null || write1h !== null) {
    tokens["cache-write"] = (write5m ?? 0) + (write1h ?? 0);
    semantics.push(
      semantic(
        "tokens.cache-write",
        "derived",
        "cache_creation",
        "tokens",
        "sum of ephemeral_5m_input_tokens and ephemeral_1h_input_tokens"
      )
    );
  }

  const output = count(row.output_tokens);

  if (output === null) {
    unavailable.push({
      field: "tokens.output",
      reason: "output_tokens missing in export",
    });
  } else {
    tokens.output = output;
    semantics.push(
      semantic("tokens.output", "source-reported", "output_tokens", "tokens")
    );
  }

  unavailable.push(
    {
      field: "charge",
      reason: "usage report carries no charge; cost report is unsupported",
    },
    { field: "requests", reason: "usage report carries no request count" }
  );

  return {
    charge: null,
    dimensions: {
      apiKeyId: text(row.api_key_id),
      workspaceId: text(row.workspace_id),
    },
    model: text(row.model),
    requests: null,
    semantics,
    tokens,
    unavailable,
  };
};

const toIso = (input: number | string): string | null => {
  const parsed = DateTime.make(input);

  return Option.isSome(parsed) ? DateTime.formatIso(parsed.value) : null;
};

const secondsBetween = (from: string, to: string): number => {
  const start = DateTime.make(from);
  const end = DateTime.make(to);

  return Option.isSome(start) && Option.isSome(end)
    ? (DateTime.toEpochMillis(end.value) -
        DateTime.toEpochMillis(start.value)) /
        1000
    : 0;
};

type Detected =
  | {
      readonly format: "openai-usage-completions";
      readonly buckets: readonly Bucket<OpenAiUsageResult>[];
      readonly hasMore: boolean;
    }
  | {
      readonly format: "openai-costs";
      readonly buckets: readonly Bucket<OpenAiCostResult>[];
      readonly hasMore: boolean;
    }
  | {
      readonly format: "anthropic-usage-messages";
      readonly buckets: readonly Bucket<AnthropicUsageResult>[];
      readonly hasMore: boolean;
    };

const decodeOpenAiUsage = Schema.decodeUnknownOption(
  Schema.fromJsonString(OpenAiUsagePageSchema)
);

const decodeOpenAiCost = Schema.decodeUnknownOption(
  Schema.fromJsonString(OpenAiCostPageSchema)
);

const decodeAnthropicUsage = Schema.decodeUnknownOption(
  Schema.fromJsonString(AnthropicUsagePageSchema)
);

const decodeAnthropicCost = Schema.decodeUnknownOption(
  Schema.fromJsonString(AnthropicCostPageSchema)
);

const openAiBuckets = <Row>(
  data: readonly {
    readonly end_time: number;
    readonly results: readonly Row[];
    readonly start_time: number;
  }[]
): Bucket<Row>[] | null => {
  const buckets: Bucket<Row>[] = [];

  for (const bucket of data) {
    const from = toIso(bucket.start_time * 1000);
    const to = toIso(bucket.end_time * 1000);

    if (from === null || to === null) {
      return null;
    }

    buckets.push({
      from,
      results: bucket.results,
      to,
      widthSeconds: bucket.end_time - bucket.start_time,
    });
  }

  return buckets;
};

const anthropicBuckets = <Row>(
  data: readonly {
    readonly ending_at: string;
    readonly results: readonly Row[];
    readonly starting_at: string;
  }[]
): Bucket<Row>[] | null => {
  const buckets: Bucket<Row>[] = [];

  for (const bucket of data) {
    const from = toIso(bucket.starting_at);
    const to = toIso(bucket.ending_at);

    if (from === null || to === null) {
      return null;
    }

    buckets.push({
      from,
      results: bucket.results,
      to,
      widthSeconds: secondsBetween(from, to),
    });
  }

  return buckets;
};

const INVALID_TIME = "Provider export has an invalid bucket start or end time";

const detect = (content: string): Result.Result<Detected, string> => {
  const openAiUsage = decodeOpenAiUsage(content);

  if (Option.isSome(openAiUsage)) {
    const buckets = openAiBuckets(openAiUsage.value.data);

    return buckets === null
      ? Result.fail(INVALID_TIME)
      : Result.succeed({
          buckets,
          format: "openai-usage-completions",
          hasMore: openAiUsage.value.has_more === true,
        });
  }

  const openAiCost = decodeOpenAiCost(content);

  if (Option.isSome(openAiCost)) {
    const buckets = openAiBuckets(openAiCost.value.data);

    return buckets === null
      ? Result.fail(INVALID_TIME)
      : Result.succeed({
          buckets,
          format: "openai-costs",
          hasMore: openAiCost.value.has_more === true,
        });
  }

  const anthropicUsage = decodeAnthropicUsage(content);

  if (Option.isSome(anthropicUsage)) {
    const buckets = anthropicBuckets(anthropicUsage.value.data);

    return buckets === null
      ? Result.fail(INVALID_TIME)
      : Result.succeed({
          buckets,
          format: "anthropic-usage-messages",
          hasMore: anthropicUsage.value.has_more === true,
        });
  }

  if (Option.isSome(decodeAnthropicCost(content))) {
    return Result.fail(
      "Anthropic cost report is unsupported: amount unit is not verified"
    );
  }

  return Result.fail(
    "Not a recognized provider usage/cost JSON page export (OpenAI completions usage, OpenAI costs or Anthropic messages usage report)"
  );
};

const providerOf = (format: ProviderUsageFormat): string =>
  format === "anthropic-usage-messages" ? "anthropic" : "openai";

const buildEvent = (
  meta: ParseMeta,
  format: ProviderUsageFormat,
  bucket: Bucket<unknown>,
  index: number,
  rowHash: string,
  facts: RowFacts
): DxEventEnvelope => {
  const dimensionKey = Object.entries(facts.dimensions)
    .map(([key, value]) => `${key}=${value ?? ""}`)
    .join(",");

  const upstreamKey = `${format}:${bucket.from}:${bucket.to}:${facts.model ?? ""}:${dimensionKey}:${String(index)}`;

  return {
    acquisition: "file-import",
    adapterId: PROVIDER_USAGE_ADAPTER_ID,
    adapterVersion: PROVIDER_USAGE_ADAPTER_VERSION,
    context: meta.context,
    eventId: eventIdFor(upstreamKey),
    evidence: {
      bounded: true,
      hash: rowHash,
      ref: `file-import://${PROVIDER_USAGE_ADAPTER_ID}/${meta.fileLabel}#${upstreamKey}`,
    },
    fieldSemantics: facts.semantics,
    identity: {
      commitSha: null,
      generationId: null,
      githubAttempt: null,
      githubRunId: null,
      prNumber: null,
      requestId: null,
      sessionId: null,
      turnId: null,
    },
    kind: "ai.usage",
    observedAt: meta.observedAt,
    occurredAt: bucket.from,
    occurredAtPrecision: precisionFor(bucket.widthSeconds),
    origin: meta.origin,
    payload: {
      charge: facts.charge,
      dimensions: facts.dimensions,
      format,
      model: facts.model,
      provider: providerOf(format),
      requests: facts.requests,
      scope: "provider-bucket",
      sourceKind: "provider-receipt",
      tokens: facts.tokens,
      unavailable: facts.unavailable,
      window: { from: bucket.from, to: bucket.to },
    },
    schemaVersion: EVENT_SCHEMA_VERSION,
    sourceVersion: format,
    upstreamKey,
  };
};

const eventsFor = <Row>(
  meta: ParseMeta,
  format: ProviderUsageFormat,
  buckets: readonly Bucket<Row>[],
  factsOf: (row: Row) => RowFacts
): DxEventEnvelope[] => {
  const events: DxEventEnvelope[] = [];

  for (const bucket of buckets) {
    for (const [index, row] of bucket.results.entries()) {
      events.push(
        buildEvent(
          meta,
          format,
          bucket,
          index,
          sha256(JSON.stringify(row)),
          factsOf(row)
        )
      );
    }
  }

  return events;
};

const eventsOf = (meta: ParseMeta, detected: Detected): DxEventEnvelope[] => {
  if (detected.format === "openai-usage-completions") {
    return eventsFor(meta, detected.format, detected.buckets, openAiUsageFacts);
  }

  if (detected.format === "openai-costs") {
    return eventsFor(meta, detected.format, detected.buckets, openAiCostFacts);
  }

  return eventsFor(
    meta,
    detected.format,
    detected.buckets,
    anthropicUsageFacts
  );
};

interface Window {
  readonly from: string | null;
  readonly to: string | null;
}

const extremes = (buckets: readonly Bucket<unknown>[]): Window => {
  let earliest: string | null = null;
  let latest: string | null = null;

  for (const { from, to } of buckets) {
    if (earliest === null || from < earliest) {
      earliest = from;
    }

    if (latest === null || to > latest) {
      latest = to;
    }
  }

  return { from: earliest, to: latest };
};

export const parseProviderUsage = (
  content: string,
  meta: ParseMeta
): Result.Result<EventBatch, string> =>
  Result.map(detect(content), (detected) => {
    const events = eventsOf(meta, detected);

    const gaps: SourceGap[] = [
      {
        code: "account-aggregate",
        message:
          "Provider buckets are account/project totals; branch attribution is not implied.",
      },
    ];

    if (detected.hasMore) {
      gaps.push({
        code: "pagination-incomplete",
        message:
          "Export reports has_more=true; only the supplied page was imported and no follow-up fetch was made.",
      });
    }

    const window = extremes(detected.buckets);
    let state: SourceCoverage["state"] = "complete";

    if (events.length === 0) {
      state = "none";
    } else if (detected.hasMore) {
      state = "partial";
    }

    return {
      coverage: {
        adapterId: PROVIDER_USAGE_ADAPTER_ID,
        expectedItems: detected.hasMore ? null : events.length,
        gaps,
        observedItems: events.length,
        state,
        watermark: window.to,
        windowFrom: window.from,
        windowTo: window.to,
      },
      cursor: null,
      events,
    };
  });
