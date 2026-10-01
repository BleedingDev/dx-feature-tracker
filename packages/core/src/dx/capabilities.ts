import { implement } from "@rat-stack/capability/define";
import { DateTime, Effect } from "effect";

import * as DxChats from "./chats/capability.js";
import { runCollect } from "./cli/commands/collect.js";
import {
  MANUAL_ADAPTER_ID,
  buildMarkerEvent,
} from "./collectors/manual/marker.js";
import { dxCollectContract, dxMarkContract } from "./contracts/capabilities.js";
import { SourceUnavailable } from "./contracts/error-source-unavailable.js";
import { EventStore } from "./contracts/event-store.js";
import * as DxHistory from "./history/capability.js";
import * as DxQueryHandlers from "./mcp/handlers/capabilities.js";
import type { SelectorResolver } from "./mcp/handlers/deps.js";
import { isolateStdout } from "./mcp/handlers/stdio.js";
import type { CostOptions } from "./metrics/cost/metric.js";
import type { EventBatch } from "./model/event.js";
import type { DxRegistry, RegisteredCollector } from "./registry/registry.js";
import {
  contextForRepo,
  gitSelectorResolver,
  hookSpoolDirFor,
} from "./registry/runtime.js";
import * as DxUsage from "./usage/capability.js";

export interface DxSelectorOverrides {
  readonly allRepos?: boolean;
  readonly branch?: string | null;
  readonly from?: string | null;
}

export interface DxCapabilityDeps {
  readonly registry: DxRegistry;
  readonly collectors: readonly RegisteredCollector[];
  readonly costOptions?: CostOptions;
  readonly defaultRepo: string;
  readonly selector?: DxSelectorOverrides;
  readonly storePath: string;
}

const nonEmptyOrNull = (value: string | null | undefined): string | null =>
  value === null || value === undefined || value.trim() === ""
    ? null
    : value.trim();

export const withSelectorOverrides = (
  base: SelectorResolver,
  overrides: DxSelectorOverrides = {}
): SelectorResolver => {
  const branch = nonEmptyOrNull(overrides.branch);
  const from = nonEmptyOrNull(overrides.from);

  return (input) =>
    Effect.map(base(input), (selector) => ({
      ...selector,
      branch: overrides.allRepos === true ? null : (branch ?? selector.branch),
      from: from ?? selector.from,
      repoCommonDir:
        overrides.allRepos === true ? null : selector.repoCommonDir,
    }));
};

const CURSOR_HOOKS_SOURCE = "collector.cursor-hooks";

export const canonicalSource = (
  collectors: readonly RegisteredCollector[],
  source: string
): string => {
  const trimmed = source.trim();
  const ids = new Set<string>(collectors.map((c) => c.descriptor.id));

  const alias = [trimmed, `collector.${trimmed}`, `collector/${trimmed}`].find(
    (candidate) => ids.has(candidate)
  );

  return alias ?? trimmed;
};

export const defaultInputFor = (
  source: string,
  worktreePath: string | null
): string | null =>
  source === CURSOR_HOOKS_SOURCE && worktreePath !== null
    ? hookSpoolDirFor(worktreePath)
    : null;

export const makeDxCapabilities = (deps: DxCapabilityDeps) => {
  const resolveSelector = withSelectorOverrides(
    gitSelectorResolver(deps.defaultRepo),
    deps.selector
  );

  const query = DxQueryHandlers.makeDxQueryCapabilities({
    descriptors: deps.registry.descriptors,
    metrics: deps.registry.metrics,
    resolveSelector,
  });

  const history = DxHistory.makeDxHistoryCapability(
    deps.costOptions === undefined
      ? { defaultRepo: deps.defaultRepo }
      : { costOptions: deps.costOptions, defaultRepo: deps.defaultRepo }
  );

  const chats = DxChats.makeDxChatsCapability(
    deps.costOptions === undefined
      ? { resolveSelector }
      : { costOptions: deps.costOptions, resolveSelector }
  );

  const usage = DxUsage.makeDxUsageCapability(
    deps.costOptions === undefined ? {} : { costOptions: deps.costOptions }
  );

  const collect = implement(dxCollectContract, (input) =>
    isolateStdout(
      Effect.gen(function* dxCollect() {
        const store = yield* EventStore;

        const context = contextForRepo(
          input.repo ?? deps.defaultRepo,
          input.flight ?? null
        );

        const source = canonicalSource(deps.collectors, input.source);

        const result = yield* runCollect(
          { store, storePath: deps.storePath },
          deps.collectors,
          {
            context,
            input: input.input ?? defaultInputFor(source, context.worktreePath),
            source,
          }
        ).pipe(
          Effect.catchTag("GitHubApiError", (error) =>
            Effect.fail(
              new SourceUnavailable({
                adapterId: input.source,
                message: `GitHub is out of scope: ${error.message}`,
              })
            )
          )
        );

        return {
          adapterId: result.adapterId,
          coverage: result.coverage,
          duplicates: result.duplicates,
          inserted: result.inserted,
        };
      })
    )
  );

  const mark = implement(dxMarkContract, (input) =>
    isolateStdout(
      Effect.gen(function* dxMark() {
        const store = yield* EventStore;
        const context = contextForRepo(input.repo ?? deps.defaultRepo);
        const now = DateTime.formatIso(yield* DateTime.now);

        const event = yield* buildMarkerEvent(
          {
            flight: input.flight,
            kind: input.kind,
            label: input.label,
            note: input.note,
            occurredAt: now,
          },
          { acquisition: "manual", context, observedAt: now, origin: "live" }
        );

        const batch: EventBatch = {
          coverage: {
            adapterId: MANUAL_ADAPTER_ID,
            expectedItems: 1,
            gaps: [],
            observedItems: 1,
            state: "complete",
            watermark: null,
            windowFrom: event.occurredAt,
            windowTo: event.occurredAt,
          },
          cursor: null,
          events: [event],
        };

        yield* store.append(batch);

        return {
          eventId: event.eventId,
          flightId: event.context.flightId ?? "",
        };
      })
    )
  );

  return [...query, collect, mark, history, chats, usage] as const;
};
