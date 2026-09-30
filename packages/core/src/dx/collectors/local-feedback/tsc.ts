import type { FeedbackAdapter, FeedbackRecord } from "./registry.js";
import { linesOf } from "./registry.js";

export const MAX_DIAGNOSTICS = 50;

const MAX_MESSAGE_CHARS = 200;

const PLAIN_PATTERN =
  /^(?<file>.+?)\((?<line>\d+),(?<col>\d+)\): (?<severity>error|warning) (?<code>TS\d+): (?<message>.*)$/u;

const PRETTY_PATTERN =
  /^(?<file>.+?):(?<line>\d+):(?<col>\d+) - (?<severity>error|warning) (?<code>TS\d+): (?<message>.*)$/u;

const FOUND_PATTERN = /^Found (?<count>\d+) errors?\b/u;

export interface TscDiagnostic {
  readonly code: string;
  readonly column: number;
  readonly file: string;
  readonly line: number;
  readonly message: string;
  readonly severity: "error" | "warning";
}

export interface TscSummary {
  readonly codeCounts: Readonly<Record<string, number>>;
  readonly diagnostics: readonly TscDiagnostic[];
  readonly errorCount: number;
  readonly fileCount: number;
  readonly reportedErrorCount: number | null;
  readonly warningCount: number;
}

const toDiagnostic = (line: string): TscDiagnostic | null => {
  const groups = (PLAIN_PATTERN.exec(line) ?? PRETTY_PATTERN.exec(line))
    ?.groups;

  if (groups === undefined) {
    return null;
  }

  return {
    code: groups.code ?? "",
    column: Number(groups.col),
    file: groups.file ?? "",
    line: Number(groups.line),
    message: (groups.message ?? "").slice(0, MAX_MESSAGE_CHARS),
    severity: groups.severity === "warning" ? "warning" : "error",
  };
};

export const parseTscOutput = (content: string): TscSummary => {
  const diagnostics: TscDiagnostic[] = [];
  let reportedErrorCount: number | null = null;

  for (const line of linesOf(content)) {
    const diagnostic = toDiagnostic(line.trim());

    if (diagnostic !== null) {
      diagnostics.push(diagnostic);
      continue;
    }

    const found = FOUND_PATTERN.exec(line.trim())?.groups?.count;

    if (found !== undefined) {
      reportedErrorCount = Number(found);
    }
  }

  const codeCounts: Record<string, number> = {};

  for (const diagnostic of diagnostics) {
    codeCounts[diagnostic.code] = (codeCounts[diagnostic.code] ?? 0) + 1;
  }

  return {
    codeCounts,
    diagnostics,
    errorCount: diagnostics.filter((item) => item.severity === "error").length,
    fileCount: new Set(diagnostics.map((item) => item.file)).size,
    reportedErrorCount,
    warningCount: diagnostics.filter((item) => item.severity === "warning")
      .length,
  };
};

const detect = (_name: string, content: string): boolean =>
  linesOf(content).some(
    (line) =>
      PLAIN_PATTERN.test(line.trim()) ||
      PRETTY_PATTERN.test(line.trim()) ||
      FOUND_PATTERN.test(line.trim())
  );

const parse = (name: string, content: string): FeedbackRecord[] => {
  const summary = parseTscOutput(content);
  const shown = summary.diagnostics.slice(0, MAX_DIAGNOSTICS);

  return [
    {
      fieldSemantics: [
        {
          field: "errorCount",
          method: "observed",
          note: "count of parsed error diagnostic lines",
          rawName: null,
          unit: "count",
        },
        {
          field: "reportedErrorCount",
          method: "source-reported",
          note: "null when the compiler printed no 'Found N errors' line",
          rawName: "Found N errors",
          unit: "count",
        },
      ],
      occurredAt: null,
      occurredAtPrecision: "unknown",
      payload: {
        codeCounts: summary.codeCounts,
        diagnostics: shown.map((item) => ({ ...item })),
        diagnosticsTruncated: summary.diagnostics.length > shown.length,
        errorCount: summary.errorCount,
        fileCount: summary.fileCount,
        occurredAtMethod: "unavailable: compiler output carries no timestamp",
        reportName: name,
        reportedErrorCount: summary.reportedErrorCount,
        status: summary.errorCount > 0 ? "failed" : "passed",
        subroute: "compiler",
        tool: "tsc",
        warningCount: summary.warningCount,
      },
      sourceVersion: null,
    },
  ];
};

export const tscAdapter: FeedbackAdapter = {
  detect,
  id: "tsc-text",
  parse,
  subroute: "compiler",
  version: "1.0.0",
};
