import {
  DxUsageInput,
  FILTER_DIMENSIONS,
  NO_REPO,
  USAGE_DIMENSIONS,
} from "@rat-stack/core/dx";
import type {
  DxUsageInputType,
  DxUsageOutputType,
  FilterDimension,
  UsageDimension,
  UsageMetric,
} from "@rat-stack/core/dx";
import { DateTime, Option, Schema } from "effect";
import type { Effect } from "effect";

import { baseName, repoName } from "./dft-dashboard.js";
import { formatCount, formatUsd, table } from "./dft-render.js";

export const USAGE_BY_CHOICES = USAGE_DIMENSIONS.filter(
  (dimension) =>
    dimension !== "scope" &&
    dimension !== "attribution" &&
    dimension !== "channel"
);

const METRIC_HEADERS: Readonly<Record<UsageMetric, string>> = {
  billed: "BILLED",
  cacheRead: "CACHE READ",
  cacheWrite: "CACHE WRITE",
  estimate: "ESTIMATE",
  input: "INPUT",
  output: "OUTPUT",
  reasoning: "REASONING",
  requests: "REQUESTS",
  sessions: "SESSIONS",
  tokens: "TOKENS",
  toolFigure: "TOOL'S FIGURE",
};

const MONEY: ReadonlySet<UsageMetric> = new Set([
  "billed",
  "estimate",
  "toolFigure",
]);

const DIMENSION_HEADERS: Readonly<Record<UsageDimension, string>> = {
  agent: "AGENT",
  attribution: "FOUND BY",
  branch: "BRANCH",
  channel: "CHANNEL",
  day: "DAY",
  effort: "EFFORT",
  model: "MODEL",
  month: "MONTH",
  parentSession: "PARENT SESSION",
  provider: "PROVIDER",
  repo: "REPO",
  scope: "SCOPE",
  session: "SESSION",
  tool: "TOOL",
  via: "VIA",
  week: "WEEK OF",
  worktree: "WORKTREE",
};

const DASH = "-";

const cell = (metric: UsageMetric, value: number | null | undefined) => {
  if (value === null || value === undefined) {
    return DASH;
  }

  return MONEY.has(metric) ? formatUsd(value) : formatCount(value);
};

const keyLabel = (dimension: UsageDimension | null, key: string): string => {
  if (dimension === "repo") {
    return key === NO_REPO ? key : repoName(key);
  }

  return dimension === "worktree" ? baseName(key) : key;
};

const pathTail = (key: string): string =>
  key
    .replace(/[/\\]\.git$/u, "")
    .split(/[/\\]/u)
    .filter((part) => part !== "")
    .slice(-2)
    .join("/");

const groupLabels = (
  dimension: UsageDimension | null,
  keys: readonly string[]
): readonly string[] => {
  const short = keys.map((key) => keyLabel(dimension, key));

  return short.map((label, index) =>
    short.indexOf(label) === short.lastIndexOf(label) || keys[index] === NO_REPO
      ? label
      : pathTail(keys[index] ?? label)
  );
};

interface RowLike {
  readonly facts: number;
  readonly key: string;
  readonly values: Readonly<Record<string, number | null>>;
}

const rowCells = (
  label: string,
  row: RowLike,
  metrics: readonly UsageMetric[]
): readonly string[] => [
  label,
  ...metrics.map((metric) => cell(metric, row.values[metric])),
];

const localDate = (
  iso: string | null,
  tz: string,
  shiftMs: number
): string | null =>
  iso === null
    ? null
    : Option.getOrNull(
        Option.map(
          DateTime.makeZoned(Date.parse(iso) + shiftMs, { timeZone: tz }),
          DateTime.formatIsoDate
        )
      );

const windowLabel = (output: DxUsageOutputType): string => {
  const { since, tz, until } = output.window;
  const from = localDate(since, tz, 0);
  const to = localDate(until, tz, -1);

  if (from === null && to === null) {
    return `all time (${tz})`;
  }

  return from !== null && from === to
    ? `${from} (${tz})`
    : `${from ?? "start"} to ${to ?? "now"} (${tz})`;
};

const disagreementLine = (output: DxUsageOutputType): string | null => {
  const byTool = new Map<string, number>();

  for (const entry of output.coverage.disagreements) {
    const tool = entry.tool ?? "unknown tool";
    byTool.set(tool, (byTool.get(tool) ?? 0) + entry.count);
  }

  return byTool.size === 0
    ? null
    : `Sources disagreed on ${[...byTool]
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([tool, count]) => `${tool} ${formatCount(count)}`)
        .join(", ")} field(s); the most precise source was used.`;
};

export const usageText = (
  output: DxUsageOutputType,
  options: { readonly verbose: boolean }
): string => {
  const { groupBy, metrics } = output;
  const by = groupBy === null ? "" : `, by ${groupBy}`;
  const heading = `AI usage, ${windowLabel(output)}${by}`;

  if (output.total.facts === 0) {
    return [
      heading,
      "",
      "No AI requests in this window. Run dft sync, or widen --since.",
    ].join("\n");
  }

  const labels = groupLabels(
    groupBy,
    output.groups.map((group) => group.key)
  );

  const rows = [
    ...output.groups.map((group, index) =>
      rowCells(labels[index] ?? group.key, group, metrics)
    ),
    ...(output.other === null
      ? []
      : [
          rowCells(
            `Other (${String(output.other.groups)})`,
            output.other,
            metrics
          ),
        ]),
    ...(output.unattributed === null
      ? []
      : [rowCells("(unattributed)", output.unattributed, metrics)]),
    rowCells("Total", output.total, metrics),
  ];

  const lines = table(
    [
      groupBy === null ? "" : DIMENSION_HEADERS[groupBy],
      ...metrics.map((m) => METRIC_HEADERS[m]),
    ],
    rows,
    new Set(metrics.map((_, index) => index + 1))
  );

  const notes = options.verbose ? output.notes : output.notes.slice(0, 1);
  const disagreements = disagreementLine(output);

  const hint =
    !options.verbose && output.notes.length > 1
      ? ["Add --verbose for what was left out and why."]
      : [];

  return [
    heading,
    "",
    ...lines,
    "",
    ...notes,
    ...(options.verbose && disagreements !== null ? [disagreements] : []),
    ...hint,
  ].join("\n");
};

const splitList = (values: readonly string[]): readonly string[] =>
  values.flatMap((value) =>
    value.split(",").flatMap((part) => {
      const trimmed = part.trim();

      return trimmed === "" ? [] : [trimmed];
    })
  );

export interface UsageFlagValues {
  readonly by: UsageDimension | undefined;
  readonly filters: Partial<Record<FilterDimension, readonly string[]>>;
  readonly limit: number | undefined;
  readonly metrics: readonly string[];
  readonly since: string | undefined;
  readonly tz: string | undefined;
  readonly until: string | undefined;
}

const decodeInput = Schema.decodeUnknownEffect(DxUsageInput);

const optional = <V>(key: string, value: V | undefined) =>
  value === undefined ? {} : { [key]: value };

export const usageInputOf = (flags: UsageFlagValues) => {
  const filters = Object.fromEntries(
    FILTER_DIMENSIONS.flatMap((dimension) => {
      const values = splitList(flags.filters[dimension] ?? []);

      return values.length === 0 ? [] : [[dimension, values] as const];
    })
  );

  const metrics = splitList(flags.metrics);

  return decodeInput({
    ...filters,
    ...optional("groupBy", flags.by),
    ...optional("limit", flags.limit),
    ...optional("metrics", metrics.length === 0 ? undefined : metrics),
    ...optional("since", flags.since),
    ...optional("tz", flags.tz),
    ...optional("until", flags.until),
  });
};

const QUERY_SINGLES = [
  "bucket",
  "groupBy",
  "since",
  "sortBy",
  "stackBy",
  "tz",
  "until",
] as const;

export const usageInputFromQuery = (
  params: URLSearchParams
): Effect.Effect<DxUsageInputType, Schema.SchemaError> => {
  const lists = Object.fromEntries(
    [...FILTER_DIMENSIONS, "metrics" as const].flatMap((name) => {
      const values = splitList(params.getAll(name));

      return values.length === 0 ? [] : [[name, values] as const];
    })
  );

  const singles = Object.fromEntries(
    QUERY_SINGLES.flatMap((name) => {
      const value = params.get(name);

      return value === null || value.trim() === ""
        ? []
        : [[name, value.trim()] as const];
    })
  );

  const limit = params.get("limit");

  return decodeInput({
    ...lists,
    ...singles,
    ...optional(
      "limit",
      limit === null || limit.trim() === "" ? undefined : Number(limit)
    ),
  });
};
