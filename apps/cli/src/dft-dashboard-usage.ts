import type { DxUsageOutputType } from "@rat-stack/core/dx";

import { formatCount, formatUsd } from "./dft-render.js";

export interface StaticUsage {
  readonly models: DxUsageOutputType;
  readonly series: DxUsageOutputType;
  readonly tools: DxUsageOutputType;
}

type Row = DxUsageOutputType["groups"][number];

const ESCAPES = new Map([
  ['"', "&quot;"],
  ["&", "&amp;"],
  ["'", "&#39;"],
  ["<", "&lt;"],
  [">", "&gt;"],
]);

const escape = (value: string): string =>
  value.replaceAll(/[&<>"']/gu, (char) => ESCAPES.get(char) ?? char);

export const STATIC_TOOL_LABELS: ReadonlyMap<string, string> = new Map([
  ["claude-code", "Claude Code"],
  ["codex", "Codex"],
  ["opencode", "OpenCode"],
  ["pi", "Pi"],
  ["omp", "OMP"],
  ["deepseek", "DeepSeek Harness"],
  ["cursor", "Cursor"],
]);

const TOOL_ORDER = [...STATIC_TOOL_LABELS.keys()];

const LEDGERS = [
  ["estimate", "Estimate", "no priced tokens"],
  ["toolFigure", "Tool's figure", "no tool reported a figure"],
  ["billed", "Billed", "no bills imported"],
  ["tokens", "Tokens", ""],
  ["requests", "Requests", ""],
] as const;

const MONEY = new Set(["billed", "estimate", "toolFigure"]);

const DASH = "-";

const valueText = (metric: string, value: number | null | undefined) => {
  if (value === null || value === undefined) {
    return DASH;
  }

  return MONEY.has(metric) ? formatUsd(value) : formatCount(value);
};

export const toolLabel = (key: string): string => {
  if (key === "(other)") {
    return "Other";
  }

  return STATIC_TOOL_LABELS.get(key) ?? key;
};

const toolColor = (key: string): string => {
  const index = TOOL_ORDER.indexOf(key);

  if (key === "(unattributed)") {
    return "var(--s-none)";
  }

  return index === -1 ? "var(--s-other)" : `var(--s${String(index + 1)})`;
};

const rowsOf = (output: DxUsageOutputType): readonly Row[] => [
  ...output.groups,
  ...(output.other === null ? [] : [output.other]),
];

export const ledgerTiles = (tools: DxUsageOutputType): string =>
  LEDGERS.map(([metric, label, none]) => {
    const from = rowsOf(tools).flatMap((row) =>
      (row.values[metric] ?? 0) > 0 ? [toolLabel(row.key)] : []
    );

    const unpriced =
      metric === "estimate" && tools.coverage.unpriced > 0
        ? [`${String(tools.coverage.unpriced)} requests have no price`]
        : [];

    const fallback = none === "" ? [] : [none];
    const source = from.length === 0 ? fallback : [`from ${from.join(", ")}`];
    const note = [...source, ...unpriced].join(". ");

    return `<div class="tile"><dt>${escape(label)}</dt><dd>${escape(valueText(metric, tools.total.values[metric]))}${note === "" ? "" : `<small>${escape(note)}</small>`}</dd></div>`;
  }).join("");

const shareCell = (value: number | null, total: number, color: string) => {
  if (value === null || total <= 0) {
    return "<td></td>";
  }

  const share = value / total;
  const percent = Math.max(1, Math.round(share * 100));

  const text =
    share > 0 && share < 0.01 ? "<1" : String(Math.round(share * 100));

  return `<td class="share"><span class="share-bar"><i style="width:${String(percent)}%;background:${color}"></i><span>${text}%</span></span></td>`;
};

const COLUMNS = [
  ["tokens", "Tokens"],
  ["requests", "Requests"],
  ["estimate", "Estimate"],
  ["toolFigure", "Tool's figure"],
  ["billed", "Billed"],
] as const;

export const usageTable = (
  heading: string,
  output: DxUsageOutputType,
  label: (key: string) => string,
  colored: boolean
): string => {
  const total = output.total.values.estimate ?? 0;

  const row = (item: Row, name: string, pinned: boolean) => {
    const color = colored ? toolColor(item.key) : "var(--accent)";

    const swatch = colored
      ? `<i class="sw" style="background:${color}"></i>`
      : "";

    return `<tr${pinned ? ' class="pinned"' : ""}><td>${swatch}${escape(name)}</td>${shareCell(item.values.estimate ?? null, total, color)}${COLUMNS.map(([metric]) => `<td class="num">${escape(valueText(metric, item.values[metric]))}</td>`).join("")}</tr>`;
  };

  const body = [
    ...output.groups.map((item) => row(item, label(item.key), false)),
    ...(output.other === null
      ? []
      : [row(output.other, `Other (${String(output.other.groups)})`, true)]),
    ...(output.unattributed === null
      ? []
      : [row(output.unattributed, "(unattributed)", true)]),
  ];

  const head = COLUMNS.map(
    ([, name]) => `<th scope="col" class="num">${escape(name)}</th>`
  ).join("");

  const foot = `<tr><td>Total</td><td></td>${COLUMNS.map(([metric]) => `<td class="num">${escape(valueText(metric, output.total.values[metric]))}</td>`).join("")}</tr>`;

  return `<div class="scroll"><table class="usage"><thead><tr><th scope="col">${escape(heading)}</th><th scope="col">Share of estimate</th>${head}</tr></thead><tbody>${body.join("")}</tbody><tfoot>${foot}</tfoot></table></div>`;
};

const niceStep = (value: number): number => {
  if (value <= 0) {
    return 1;
  }

  const power = 10 ** Math.floor(Math.log10(value));
  const scaled = value / power;

  if (scaled <= 1) {
    return power;
  }

  if (scaled <= 2) {
    return 2 * power;
  }

  return scaled <= 5 ? 5 * power : 10 * power;
};

const axisText = (value: number): string =>
  Number.isInteger(value) ? `$${formatCount(value)}` : `$${value.toFixed(2)}`;

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const bucketText = (bucket: string): string => {
  const match = /^\d{4}-(?<m>\d{2})-(?<d>\d{2})$/u.exec(bucket);

  return match?.groups === undefined
    ? bucket
    : `${MONTHS[Number(match.groups.m) - 1] ?? ""} ${String(Number(match.groups.d))}`;
};

const WIDTH = 960;

const HEIGHT = 220;

const LEFT = 52;

const RIGHT = 8;

const TOP = 10;

const BOTTOM = 24;

const stackValue = (stack: Row): number => stack.values.estimate ?? 0;

export const usageChart = (series: DxUsageOutputType): string => {
  if (series.series.length === 0) {
    return `<p class="empty">No AI requests in this window.</p>`;
  }

  const plotWidth = WIDTH - LEFT - RIGHT;
  const plotHeight = HEIGHT - TOP - BOTTOM;

  const sums = series.series.map((point) =>
    point.stacks.reduce((sum, stack) => sum + stackValue(stack), 0)
  );

  const top = Math.max(0, ...sums);
  const step = niceStep(top / 4);
  const ticks = Math.max(1, Math.ceil(top / step));
  const max = step * ticks;
  const band = plotWidth / series.series.length;
  const bar = Math.max(2, Math.min(32, band * 0.7));
  const every = Math.max(1, Math.ceil(series.series.length / 12));

  const grid = Array.from({ length: ticks + 1 }, (_, index) => {
    const y = TOP + plotHeight - (plotHeight * index) / ticks;

    return `<line class="${index === 0 ? "base" : "grid"}" x1="${String(LEFT)}" x2="${String(WIDTH - RIGHT)}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"></line><text x="${String(LEFT - 6)}" y="${(y + 4).toFixed(1)}" text-anchor="end">${escape(axisText(step * index))}</text>`;
  });

  const bars = series.series.map((point, index) => {
    const x = LEFT + band * index + (band - bar) / 2;
    let y = TOP + plotHeight;

    const segments = point.stacks.flatMap((stack) => {
      const value = stackValue(stack);

      if (value <= 0) {
        return [];
      }

      const height = (plotHeight * value) / max;

      y -= height;

      return [
        `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bar.toFixed(1)}" height="${Math.max(0.5, height).toFixed(1)}" rx="2" style="fill:${toolColor(stack.key)}"><title>${escape(`${bucketText(point.bucket)}, ${toolLabel(stack.key)}: ${formatUsd(value)}`)}</title></rect>`,
      ];
    });

    const label =
      index % every === 0
        ? `<text x="${(LEFT + band * index + band / 2).toFixed(1)}" y="${String(HEIGHT - 6)}" text-anchor="middle">${escape(bucketText(point.bucket))}</text>`
        : "";

    return segments.join("") + label;
  });

  const keys = [
    ...new Set(
      series.series.flatMap((point) => point.stacks.map((stack) => stack.key))
    ),
  ];

  const legend = keys
    .map(
      (key) =>
        `<span><i class="sw" style="background:${toolColor(key)}"></i>${escape(toolLabel(key))}</span>`
    )
    .join("");

  return `<svg class="chart" viewBox="0 0 ${String(WIDTH)} ${String(HEIGHT)}" role="img" aria-label="Estimate per ${escape(series.bucket)}, by tool">${grid.join("")}${bars.join("")}</svg><div class="ulegend">${legend}</div>`;
};

export const USAGE_STYLE = `
:root{--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--s4:#eda100;--s5:#e87ba4;--s6:#008300;--s7:#4a3aa7;--s-other:#a3a29b;--s-none:#d3d2cb;--grid:#e6e5e0}
@media (prefers-color-scheme:dark){:root{--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;--s5:#d55181;--s6:#008300;--s7:#9085e9;--s-other:#6b6b72;--s-none:#3a3a40;--grid:#2d2d2a}}
h2{font-size:12px;font-weight:600;color:var(--muted);margin:22px 0 8px;text-transform:uppercase;letter-spacing:.05em}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin-bottom:12px}
svg.chart{display:block;width:100%;height:auto}
svg.chart text{fill:var(--muted);font:11px system-ui,sans-serif}
svg.chart .grid{stroke:var(--grid)}
svg.chart .base{stroke:var(--muted)}
svg.chart rect{stroke:var(--panel);stroke-width:1.5}
.ulegend{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:6px;font-size:12px;color:var(--muted)}
.ulegend span{display:inline-flex;gap:6px;align-items:center}
.sw{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:8px;vertical-align:-1px}
.ulegend .sw{margin-right:0}
td.share{min-width:110px;width:20%}
.share-bar{display:flex;align-items:center;gap:8px}
.share-bar i{display:block;height:6px;border-radius:3px;min-width:2px}
.share-bar span{color:var(--muted);font-size:12px}
tfoot td{border-top:1px solid var(--line);font-weight:600}
tr.pinned td{color:var(--muted)}
.cols{display:grid;grid-template-columns:minmax(0,1fr);gap:12px}
@media (min-width:1000px){.cols{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}}
.cols h2{margin-top:10px}
`;

export const usageSection = (usage: StaticUsage): string =>
  [
    `<dl class="totals">${ledgerTiles(usage.tools)}</dl>`,
    `<div class="panel"><h2 style="margin-top:0">Estimate per ${escape(usage.series.bucket)}, by tool</h2>${usageChart(usage.series)}</div>`,
    `<div class="cols"><div><h2>By tool</h2>${usageTable("Tool", usage.tools, toolLabel, true)}</div><div><h2>By model</h2>${usageTable("Model", usage.models, (key) => key, false)}</div></div>`,
    `<h2>Branches</h2>`,
  ].join("\n");
