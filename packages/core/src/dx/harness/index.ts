export {
  BranchSourceSchema,
  ChannelSchema,
  EffortSourceSchema,
  HARNESS_IDS,
  HarnessIdSchema,
  ModelProviderSchema,
} from "./ids.js";

export type {
  BranchSource,
  Channel,
  EffortSource,
  HarnessId,
  ModelProvider,
} from "./ids.js";

export {
  KNOWN_GATEWAYS,
  inferProvider,
  inferVia,
  normalizeModel,
  providerFor,
  viaFor,
} from "./provider.js";

export {
  FileCursorSchema,
  everywhere,
  fileCursorOf,
  readFileCursor,
  unchangedSince,
} from "./contract.js";

export type {
  Discovery,
  FileCursor,
  Harness,
  HarnessCapabilities,
  HarnessScope,
  HarnessStore,
  ReadError,
  ReadInput,
  SessionRef,
  StoredSession,
} from "./contract.js";

export { HARNESS_HOME_ENV_VARS, HarnessHome, harnessDirs } from "./home.js";

export type {
  HarnessDirs,
  HarnessHomeOverrides,
  HarnessLocations,
} from "./home.js";

export { LocalSqlite } from "./local-sqlite.js";

export type {
  LocalSqliteReader,
  MemoryTables,
  SqlValue,
} from "./local-sqlite.js";

export { GitRunner, memoryGitAt, notARepo } from "./git.js";

export type { GitAt, GitQueries, GitWorktree, MemoryRepo } from "./git.js";

export { liveFileStore, memoryFileStore } from "./file-store.js";

export type {
  FileStoreSpec,
  MemoryFile,
  MemoryStoreInput,
} from "./file-store.js";

export {
  emptyHarnessBatch,
  harnessAdapterId,
  pendingHarness,
} from "./pending.js";

export type { HarnessSpec } from "./pending.js";

export { HARNESS_META, channelRank, evidenceRank } from "./precedence.js";

export type { EvidenceOrigin, HarnessMeta } from "./precedence.js";

export { AI_SOURCES_BY_RANK, aiSourceRank } from "./source-kinds.js";

export {
  COLLECTOR_ORIGINS,
  collectorBlocks,
  withCollectorBlocks,
} from "./collector-blocks.js";

export type {
  CollectorOrigin,
  EventWithoutBlocks,
} from "./collector-blocks.js";

export {
  HarnessRegistry,
  HarnessRegistryLive,
  harnessCatalog,
  harnessKitLayer,
  liveHarnessLayers,
  mockCursorHarness,
  mockHarnessLayers,
  registryWith,
} from "./registry.js";

export type { HarnessCatalog, LocateFailure, Located } from "./registry.js";

export {
  HARNESS_COLLECTOR_IDS,
  harnessCollectors,
  harnessDescriptor,
  refForPath,
  toCollector,
} from "./collector.js";

export {
  HOOK_OBSERVATION_SCHEMA,
  HookFieldsSchema,
  HookGitSchema,
  HookObservationSchema,
  boundedField,
  hookEventNameOf,
  hookToolOf,
  noHookFields,
  standardHookDecoder,
  standardHookFields,
} from "./hook-observation.js";

export type {
  HookDecoder,
  HookFields,
  HookGit,
  HookObservation,
} from "./hook-observation.js";

export {
  HOOK_SPOOL_ROOT,
  hookSpoolDir,
  hookSpoolFile,
  observeHook,
  readHookObservations,
  recordHook,
} from "./hook-spool.js";

export type { HookRun, HookRunOutcome, HookRunResult } from "./hook-spool.js";

export { HOOK_DECODERS } from "./hook-decoders.js";
