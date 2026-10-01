export {
  canonicalSource,
  defaultInputFor,
  makeDxCapabilities,
  withSelectorOverrides,
} from "./capabilities.js";

export type { DxCapabilityDeps, DxSelectorOverrides } from "./capabilities.js";

export {
  DFT_DB_FILE,
  DFT_HOME_ENV_VAR,
  resolveDftHome,
  resolveDftStore,
} from "./registry/runtime.js";

export type { DftStoreOptions } from "./registry/runtime.js";

export {
  autoSync,
  cursorProjectSlug,
  formatSyncLine,
  planSources,
  transcriptDirFor,
} from "./registry/sync.js";

export type { AutoSyncOptions, SyncReport, SyncStep } from "./registry/sync.js";

export { makeDxHistoryCapability } from "./history/capability.js";

export { dxHistoryContract } from "./history/contract.js";

export type { FlightHistoryRow, HistoryMeasure } from "./history/contract.js";

export { makeDxChatsCapability, resolveSince } from "./chats/capability.js";

export { dxChatsContract } from "./chats/contract.js";

export {
  defaultCostOptions,
  defaultPriceTables,
  loadUserPriceTable,
  selectPriceTable,
} from "./metrics/cost/price-tables/defaults.js";

export type { UserPriceTableLoad } from "./metrics/cost/price-tables/defaults.js";

export { defaultPriceProvider } from "./metrics/cost/price-catalog/provider.js";

export {
  contextForRepo,
  dxStoreLayer,
  gitSelectorResolver,
  defaultDftHome,
  hookSpoolDirFor,
  legacyHookSpoolDirFor,
  resolveDxStore,
  runCursorHook,
  runToolHook,
  selectorForContext,
} from "./registry/runtime.js";

export type {
  DxStoreOptions,
  ToolHookRequest,
  ToolHookResult,
} from "./registry/runtime.js";

export { autoSources, commandLogPath } from "./composition.js";

export type { AutoSource } from "./composition.js";

export {
  allCollectors,
  allMetrics,
  buildRegistry,
  metricsWithCost,
  supportDescriptors,
} from "./registry/registry.js";

export type {
  DxCollectorServices,
  DxRegistry,
  RegisteredCollector,
} from "./registry/registry.js";

export {
  admitDescriptors,
  enabledDescriptorRefs,
  snapshotCompatible,
} from "./registry/admission.js";

export { runAnalyze } from "./cli/commands/analyze.js";

export { runCollect, runImportSpool } from "./cli/commands/collect.js";

export type { DxCommandEnv } from "./cli/commands/context.js";

export { runExplain } from "./cli/commands/explain.js";

export { runStart } from "./cli/commands/start.js";

export { runStatus } from "./cli/commands/status.js";

export { handleEvidence } from "./mcp/handlers/evidence.js";

export { makeDxQueryCapabilities } from "./mcp/handlers/capabilities.js";

export {
  CapabilityNames,
  dxAnalyzeContract,
  dxCollectContract,
  dxEvidenceContract,
  dxExplainContract,
  dxMarkContract,
  dxStatusContract,
} from "./contracts/capabilities.js";

export { EventStore } from "./contracts/event-store.js";

export type {
  DxCollector,
  DxMetric,
  EventStoreService,
} from "./contracts/services.js";

export { CONTRACT_DIGEST, CONTRACT_VERSION } from "./contracts/version.js";

export {
  SqliteEventStoreLayer,
  openSqliteEventStore,
} from "./storage/sqlite-event-store.js";

export { resolveStorePath } from "./storage/store-path.js";

export { buildTimeline } from "./reports/explain/timeline.js";

export { explainTimeline } from "./reports/explain/explain.js";

export { composeAnalyzeReport } from "./reports/analyze/compose.js";

export {
  closeOpenIntervalAt,
  intervalHelpers,
} from "./metrics/intervals/intervals.js";

export {
  addRepo,
  DEFAULT_LIVE_CONFIG,
  listRepos,
  readLiveConfig,
  removeRepo,
  resolveGitRepo,
  setCursorUsageImport,
  writeLiveConfig,
} from "./live/config.js";

export type {
  GitRepo,
  LiveConfig,
  TrackResult,
  UntrackResult,
} from "./live/config.js";

export {
  LIVE_DEFAULTS,
  startLiveEngine,
  USAGE_INPUT,
  USAGE_SOURCE,
} from "./live/engine.js";

export type {
  LiveChange,
  LiveChangeReason,
  LiveEngine,
  LiveEngineOptions,
  LiveListener,
  LiveRepoStatus,
  LiveSignal,
  LiveStatus,
  LiveUsageStatus,
} from "./live/engine.js";

export {
  backupsDir,
  configPath,
  isInsideHome,
  LiveActionError,
  liveHome,
  spoolRoot,
} from "./live/home.js";

export type { LiveActionReason, LiveHome } from "./live/home.js";

export {
  deleteRepoData,
  listBackups,
  planDeleteRepoData,
  planResetStore,
  RESET_CONFIRM_TEXT,
  resetStore,
  restoreBackup,
} from "./live/store-admin.js";

export type {
  BackupInfo,
  BackupReason,
  BranchRemoval,
  DeleteRepoResult,
  RemovalTotals,
  RepoDataPlan,
  RepoEventCount,
  ResetPlan,
  ResetResult,
  RestoreResult,
} from "./live/store-admin.js";

export {
  AI_TOKEN_FIELDS,
  AiAttributionSchema,
  AiTokensSchema,
  AiUsageSchema,
  ToolFigureKindSchema,
  ToolFigureSchema,
  hasKnownTokens,
  unknownTokens,
} from "./model/attribution.js";

export type {
  AiAttribution,
  AiTokens,
  AiUsage,
  ToolFigure,
  ToolFigureKind,
} from "./model/attribution.js";

export {
  ChannelSchema,
  HARNESS_IDS,
  HarnessIdSchema,
  HarnessRegistry,
  HarnessRegistryLive,
  ModelProviderSchema,
  readHookObservations,
} from "./harness/index.js";

export type {
  Channel,
  Discovery,
  Harness,
  HarnessId,
  HookObservation,
  ModelProvider,
  SessionRef,
} from "./harness/index.js";
