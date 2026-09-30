import type { FeedbackAdapter, FeedbackRecord } from "./registry.js";
import { linesOf } from "./registry.js";

const READY_PATTERN =
  /VITE v(?<version>\d+\.\d+\.\d+\S*)\s+ready in (?<ms>\d+) ms/u;

const EVENT_PATTERN =
  /^(?<clock>\d{1,2}:\d{2}:\d{2}(?: [AP]M)?) \[vite\](?: \((?<env>[a-z]+)\))? (?<action>hmr update|hmr invalidate|page reload) (?<module>.+)$/u;

const REPEAT_PATTERN = / \(x(?<count>\d+)\)$/u;

export interface ViteLogSummary {
  readonly firstClock: string | null;
  readonly hmrInvalidations: number;
  readonly hmrUpdates: number;
  readonly lastClock: string | null;
  readonly moduleCount: number;
  readonly pageReloads: number;
  readonly readyInMs: number | null;
  readonly viteVersion: string | null;
}

export const parseViteLog = (content: string): ViteLogSummary => {
  let firstClock: string | null = null;
  let lastClock: string | null = null;
  let hmrInvalidations = 0;
  let hmrUpdates = 0;
  let pageReloads = 0;
  let readyInMs: number | null = null;
  let viteVersion: string | null = null;
  const modules = new Set<string>();

  for (const raw of linesOf(content)) {
    const line = raw.trim();
    const ready = READY_PATTERN.exec(line)?.groups;

    if (ready?.ms !== undefined) {
      readyInMs = Number(ready.ms);
      viteVersion = ready.version ?? null;
      continue;
    }

    const event = EVENT_PATTERN.exec(line)?.groups;

    if (event === undefined) {
      continue;
    }

    firstClock ??= event.clock ?? null;
    lastClock = event.clock ?? lastClock;
    const module = event.module ?? "";
    const repeat = Number(REPEAT_PATTERN.exec(module)?.groups?.count ?? "1");
    modules.add(module.replace(REPEAT_PATTERN, "").split(" ")[0] ?? module);

    if (event.action === "hmr update") {
      hmrUpdates += repeat;
    } else if (event.action === "page reload") {
      pageReloads += repeat;
    } else {
      hmrInvalidations += repeat;
    }
  }

  return {
    firstClock,
    hmrInvalidations,
    hmrUpdates,
    lastClock,
    moduleCount: modules.size,
    pageReloads,
    readyInMs,
    viteVersion,
  };
};

const detect = (_name: string, content: string): boolean =>
  content.includes("[vite]") || READY_PATTERN.test(content);

const parse = (name: string, content: string): FeedbackRecord[] => {
  const summary = parseViteLog(content);

  return [
    {
      fieldSemantics: [
        {
          field: "readyInMs",
          method: "source-reported",
          note: "dev server startup time printed by Vite",
          rawName: "ready in",
          unit: "ms",
        },
        {
          field: "hmrUpdates",
          method: "observed",
          note: "count of '[vite] hmr update' log lines, expanding Vite's (xN) repeat suffix",
          rawName: "hmr update",
          unit: "count",
        },
      ],
      occurredAt: null,
      occurredAtPrecision: "unknown",
      payload: {
        ...summary,
        hmrLatencyMs: null,
        hmrLatencyReason:
          "Vite logs do not report per-update HMR latency; not estimated",
        occurredAtMethod: "unavailable: Vite log clock has no date or timezone",
        reportName: name,
        subroute: "vite-hmr",
        tool: "vite",
      },
      sourceVersion:
        summary.viteVersion === null ? null : `vite@${summary.viteVersion}`,
    },
  ];
};

export const viteLogAdapter: FeedbackAdapter = {
  detect,
  id: "vite-dev-log",
  parse,
  subroute: "vite-hmr",
  version: "1.0.0",
};
