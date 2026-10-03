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

export type {
  AutoSyncOptions,
  PlannedSource,
  SyncReport,
  SyncStep,
} from "./registry/sync.js";

export { makeDxHistoryCapability } from "./history/capability.js";

export { dxHistoryContract } from "./history/contract.js";

export type { FlightHistoryRow, HistoryMeasure } from "./history/contract.js";

export { makeDxChatsCapability, resolveSince } from "./chats/capability.js";

export { makeDxUsageCapability, runUsageQuery } from "./usage/capability.js";

export type { DxUsageDeps } from "./usage/capability.js";

export {
  DxUsageInput,
  DxUsageOutput,
  dxUsageContract,
} from "./usage/contract.js";

export type { DxUsageInputType, DxUsageOutputType } from "./usage/contract.js";

export { NO_REPO } from "./usage/fact.js";

export { EventIdSchema } from "./model/ids.js";

export type { DxEventEnvelope } from "./model/event.js";

export { rebuildUsageFacts, usageFacts } from "./usage/load.js";

export {
  FILTER_DIMENSIONS,
  USAGE_DIMENSIONS,
  USAGE_METRICS,
} from "./usage/query.js";

export type {
  FilterDimension,
  UsageDimension,
  UsageMetric,
} from "./usage/query.js";

export { UsageFactStore } from "./usage/store.js";

export { dxChatsContract } from "./chats/contract.js";

export {
  defaultCostOptions,
  defaultPriceTables,
  loadUserPriceTable,
  selectPriceTable,
} from "./metrics/cost/price-tables/defaults.js";

export type { UserPriceTableLoad } from "./metrics/cost/price-tables/defaults.js";

export {
  cachedPriceProvider,
  defaultPriceProvider,
  priceCatalogEnabled,
} from "./metrics/cost/price-catalog/provider.js";

export type { PriceProvider } from "./metrics/cost/price-catalog/provider.js";

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

export {
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  appendPrivateFile,
  copyPrivateFile,
  ensurePrivateDir,
  tightenPrivateDir,
  writePrivateFile,
} from "./storage/private-files.js";

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
  makeAdministrationBackend,
  startLiveEngine,
  USAGE_INPUT,
  USAGE_SOURCE,
} from "./live/engine.js";

export type {
  AdministrationBackend,
  LiveChange,
  LiveChangeReason,
  LiveEngine,
  LiveEngineOptions,
  LiveAcquisitionEnvironment,
  LiveAcquisitionExecutor,
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

export {
  HarnessHome,
  harnessAdapterId,
  harnessRegistryFor,
  normalizeModel,
  providerFor,
  viaFor,
} from "./harness/index.js";

export {
  OMP_EXTENSION_FILE,
  OMP_EXTENSION_MARKER,
  ompExtensionSource,
} from "./harness/omp/index.js";

export {
  OPENCODE_PLUGIN_FILE,
  opencodePluginSource,
} from "./harness/opencode/index.js";

export {
  PI_EXTENSION_FILE_NAME,
  PI_EXTENSION_MARKER,
  piExtensionSource,
} from "./harness/pi/index.js";

export {
  DxEventEnvelopeSchema,
  EVENT_SCHEMA_VERSION,
  emptyEventIdentity,
  emptyFlightContext,
} from "./model/event.js";

export type { EventBatch } from "./model/event.js";

export { AgentStore } from "./contracts/agent-store.js";

export { makeFakeAgentStore } from "./contracts/fake-agent-store.js";

export type {
  AgentBasisMetadataRead,
  AgentResultMetadataRead,
  AgentStoreService,
  AgentStoreFailure,
} from "./contracts/agent-store.js";

export {
  AGENT_PROFILE_VERSION,
  AgentRequestSchema,
  AgentBudgetSchema,
  AgentRefSchema,
} from "./model/agent-common.js";

export type {
  AgentRequest,
  AgentBudget,
  AgentRef,
  AgentScope,
} from "./model/agent-common.js";

export {
  AgentQueryInputSchema,
  AgentQueryOutputSchema,
  AgentResponseContextSchema,
} from "./model/agent-query.js";

export type {
  AgentQueryInput,
  AgentQueryOutput,
  AgentResponseContext,
} from "./model/agent-query.js";

export { AgentError } from "./contracts/error-agent.js";

export { InvalidInput } from "./contracts/error-invalid-input.js";

export { dxOperationContract, dxLearningContract } from "./contracts/agent.js";

export {
  OperationService,
  makeOperationService,
  runOperation,
} from "./operations/service.js";

export type { OperationServiceApi } from "./operations/service.js";

export { operationStep } from "./operations/ports.js";

export type {
  OperationAdapter,
  OperationPlanInput,
  OperationApplyInput,
  OperationPreparation,
  OperationEffectResult,
  OperationProbe,
  OperationExecutionContext,
  OperationWorkContext,
} from "./operations/ports.js";

export type {
  OperationWorkBudget,
  OperationWorkUsage,
  OperationWorkReservation,
} from "./operations/budget.js";

export { createOperationWorkBudget } from "./operations/budget.js";

export { BoundedEventReplacement } from "./storage/agent-append-bounds.js";

export type {
  BoundedAppendLimits,
  BoundedAppendResult,
  BoundedReplacementProof,
} from "./storage/agent-append-bounds.js";

export {
  makeBoundedGitOperationAdapter,
  makeBoundedGitCommitChecker,
  makeBoundedGitWorktreeLister,
  makeBoundedGitTargetResolver,
  BOUNDED_GIT_OPERATION_VERSION,
  BOUNDED_GIT_SOURCES,
} from "./operations/git.js";

export type { BoundedGitOperationOptions } from "./operations/git.js";

export {
  makeBoundedAccountOperationAdapter,
  makeBoundedAccountReplacement,
  ACCOUNT_OPERATION_SOURCE,
  ACCOUNT_OPERATION_VERSION,
  ACCOUNT_OPERATION_BOUNDS,
  accountOperationArguments,
  accountOperationScope,
} from "./operations/account.js";

export type { BoundedAccountOperationOptions } from "./operations/account.js";

export { HarnessCursors } from "./storage/harness-cursors.js";

export type { HarnessCursorsApi } from "./storage/harness-cursors.js";

export { operationDigest, operationScopeDigest } from "./operations/digest.js";

export { makeLiveAdministrationAdapters } from "./operations/live.js";

export type {
  LiveAdministrationTarget,
  LiveAdministrationTargetResolver,
  LiveAdministrationBackend,
} from "./operations/live.js";

export {
  makePlannedSourceOperationAdapter,
  nativeBoundedSnapshotHarness,
} from "./operations/collector.js";

export { makeExplicitSelectedSourceCatalog } from "./operations/collector.js";

export type {
  PlannedSourceOperationAdapterOptions,
  PlannedSourceSelection,
  SelectedSourceRequest,
  ExplicitSourceMapping,
  CollectionEnrollmentRequest,
  SelectedSourceSnapshot,
  SnapshotHarness,
} from "./operations/collector.js";

export {
  composeCollectionOperationAdapters,
  makeLiveOperationAcquisitionExecutor,
  makeLiveSelectedSourceCatalog,
} from "./operations/live-acquisition.js";

export type {
  CollectionOperationRoute,
  LiveOperationAcquisitionOptions,
  LiveSelectedSourceCatalog,
  LiveSelectedSourceCatalogOptions,
} from "./operations/live-acquisition.js";

export {
  BOUNDED_HOOK_PARSER_VERSION,
  boundedHookSnapshotHarness,
} from "./operations/hooks.js";

export {
  boundedCompressedSnapshotHarness,
  operationSnapshotEncoding,
} from "./operations/decompression.js";

export {
  BOUNDED_OPENCODE_OPERATION_VERSION,
  makeBoundedOpencodeOperationAdapter,
} from "./operations/opencode.js";

export type { BoundedOpencodeOperationOptions } from "./operations/opencode.js";

export {
  BOUNDED_CURSOR_OPERATION_SOURCES,
  BOUNDED_CURSOR_OPERATION_VERSION,
  makeBoundedCursorOperationAdapter,
} from "./operations/cursor.js";

export type { BoundedCursorOperationOptions } from "./operations/cursor.js";

export {
  BOUNDED_CURSOR_HOOK_OPERATION_VERSION,
  CURSOR_HOOK_OPERATION_SOURCE,
  makeBoundedCursorHookOperationAdapter,
  makeBoundedCursorHookIdentityProbe,
} from "./operations/cursor-hooks.js";

export type {
  BoundedCursorHookIdentityOptions,
  BoundedCursorHookOperationOptions,
} from "./operations/cursor-hooks.js";

export { cursorStateDbPath } from "./collectors/cursor-usage-api/session.js";

export {
  OperationInputSchema,
  OperationPlanSchema,
  OperationOutputSchema,
  OperationDescriptorSchema,
} from "./model/agent-operation.js";

export type {
  OperationInput,
  OperationOutput,
  OperationPlan,
  OperationReceipt,
  OperationStep,
  OperationBounds,
  OperationArguments,
  OperationDescriptor,
} from "./model/agent-operation.js";

export {
  LearningService,
  makeLearningService,
  runLearning,
  learningRecordRef,
} from "./learning/service.js";

export type { LearningServiceOptions } from "./learning/service.js";

export type {
  LearningServiceApi,
  LearningContext,
} from "./learning/service.js";

export {
  LearningInputSchema,
  LearningOutputSchema,
} from "./model/agent-learning.js";

export type { LearningInput, LearningOutput } from "./model/agent-learning.js";

export type { AnalysisBasisMetadata } from "./model/agent-query.js";

export { AgentHandleSchema, AgentScopeSchema } from "./model/agent-common.js";

export type { AgentHandle, StoreIdentity } from "./model/agent-common.js";

export { configurationContentDigest } from "./live/store-admin.js";

export type {
  LiveAdministrationPreview,
  LiveAdministrationRequest,
} from "./live/store-admin.js";

export {
  AGENT_CONTRACT_DIGEST,
  AGENT_CONTRACT_VERSION,
} from "./contracts/agent-version.js";
