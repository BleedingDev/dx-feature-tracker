import type { NodeServices } from "@effect/platform-node";

import { cliCommandsDescriptor } from "../cli/commands/descriptor.js";
import { claudeJsonlCollector } from "../collectors/claude/collector.js";
import { codexSessionCollector } from "../collectors/codex/collector.js";
import { cursorCliCollector } from "../collectors/cursor-cli/collector.js";
import { cursorDashboardResponseCollector } from "../collectors/cursor-dashboard-response/collector.js";
import { cursorExtensionCollector } from "../collectors/cursor-extension/collector.js";
import { cursorHooksCollector } from "../collectors/cursor-hooks/collector.js";
import { cursorLocalDbCollector } from "../collectors/cursor-local-db/collector.js";
import { cursorSdkCollector } from "../collectors/cursor-sdk/collector.js";
import { cursorTranscriptCollector } from "../collectors/cursor-transcripts/collector.js";
import { cursorUsageApiCollector } from "../collectors/cursor-usage-api/collector.js";
import { cursorUsageExportCollector } from "../collectors/cursor-usage-export/collector.js";
import { entireCheckpointsCollector } from "../collectors/entire/collector.js";
import { gitAiCollector } from "../collectors/git-ai/collector.js";
import { gitHistoryCollector } from "../collectors/git-history/git-history.js";
import { gitIdentityCollector } from "../collectors/git-identity/collector.js";
import { gitObservationCollector } from "../collectors/git-observation/collector.js";
import { localFeedbackCollector } from "../collectors/local-feedback/collector.js";
import { localTestCollector } from "../collectors/local-test/collector.js";
import { manualCollector } from "../collectors/manual/collector.js";
import { opencodeCollector } from "../collectors/opencode/collector.js";
import { providerUsageCollector } from "../collectors/provider-usage/collector.js";
import { shellCommandCollector } from "../collectors/shell-command/collector.js";
import type { DxCollector, DxMetric } from "../contracts/services.js";
import { aiCorrelationDescriptor } from "../correlation/ai/descriptor.js";
import { flightCorrelationDescriptor } from "../correlation/flight/correlator.js";
import { repoCorrelationDescriptor } from "../correlation/repo/descriptor.js";
import { mcpQueryHandlersDescriptor } from "../mcp/handlers/descriptor.js";
import { aiUsageMetric } from "../metrics/ai-usage/metric.js";
import * as CostMetric from "../metrics/cost/metric.js";
import { flightTimeMetric } from "../metrics/flight-time/metric.js";
import { frictionMetric } from "../metrics/friction/metric.js";
import { gitChurnMetric } from "../metrics/git/metric.js";
import { intervalsDescriptor } from "../metrics/intervals/intervals.js";
import { provenanceMetric } from "../metrics/provenance/metric.js";
import type { ModuleDescriptor } from "../model/descriptor.js";
import { analyzeReportDescriptor } from "../reports/analyze/layer.js";
import { evidenceReportDescriptor } from "../reports/evidence/descriptor.js";
import { explainReportDescriptor } from "../reports/explain/explain.js";
import { eventStoreDescriptor } from "../storage/descriptor.js";
import { admitDescriptors } from "./admission.js";
import type { AdmissionResult } from "./admission.js";

export type DxCollectorServices = NodeServices.NodeServices;

export type RegisteredCollector = DxCollector<DxCollectorServices>;

export const allCollectors: readonly RegisteredCollector[] = [
  gitIdentityCollector,
  gitHistoryCollector,
  gitObservationCollector,
  manualCollector,
  cursorHooksCollector,
  cursorLocalDbCollector,
  cursorCliCollector,
  cursorTranscriptCollector,
  cursorUsageExportCollector,
  cursorUsageApiCollector,
  cursorDashboardResponseCollector,
  cursorExtensionCollector,
  cursorSdkCollector,
  localTestCollector,
  shellCommandCollector,
  localFeedbackCollector,
  claudeJsonlCollector,
  codexSessionCollector,
  opencodeCollector,
  providerUsageCollector,
  gitAiCollector,
  entireCheckpointsCollector,
];

export const allMetrics: readonly DxMetric[] = [
  aiUsageMetric,
  CostMetric.costMetric,
  gitChurnMetric,
  frictionMetric,
  provenanceMetric,
  flightTimeMetric,
];

export const metricsWithCost = (
  options: CostMetric.CostOptions,
  metrics: readonly DxMetric[] = allMetrics
): readonly DxMetric[] =>
  metrics.map((metric) =>
    metric === CostMetric.costMetric
      ? CostMetric.makeCostMetric(options)
      : metric
  );

export const supportDescriptors: readonly ModuleDescriptor[] = [
  eventStoreDescriptor,
  repoCorrelationDescriptor,
  flightCorrelationDescriptor,
  aiCorrelationDescriptor,
  intervalsDescriptor,
  analyzeReportDescriptor,
  explainReportDescriptor,
  evidenceReportDescriptor,
  cliCommandsDescriptor,
  mcpQueryHandlersDescriptor,
];

export interface DxRegistry {
  readonly admission: AdmissionResult;
  readonly collectors: readonly RegisteredCollector[];
  readonly descriptors: readonly ModuleDescriptor[];
  readonly metrics: readonly DxMetric[];
}

export const buildRegistry = (
  collectors: readonly RegisteredCollector[] = allCollectors,
  metrics: readonly DxMetric[] = allMetrics,
  support: readonly ModuleDescriptor[] = supportDescriptors
): DxRegistry => {
  const admission = admitDescriptors([
    ...collectors.map((c) => c.descriptor),
    ...metrics.map((m) => m.descriptor),
    ...support,
  ]);

  const admitted = new Set(admission.admitted.map((d) => d.id));

  return {
    admission,
    collectors: collectors.filter((c) => admitted.has(c.descriptor.id)),
    descriptors: admission.listed,
    metrics: metrics.filter((m) => admitted.has(m.descriptor.id)),
  };
};
