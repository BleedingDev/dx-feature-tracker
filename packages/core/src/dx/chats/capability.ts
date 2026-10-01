import { implement } from "@rat-stack/capability/define";
import { DateTime, Effect, Option } from "effect";

import { InvalidInput } from "../contracts/error-invalid-input.js";
import { EventStore } from "../contracts/event-store.js";
import {
  accountAwareEvents,
  narrowToBranch,
  reattributeIfPossible,
} from "../correlation/branch-at-time/snapshot.js";
import type { SelectorResolver } from "../mcp/handlers/deps.js";
import { literalSelectorResolver } from "../mcp/handlers/selector.js";
import { isolateStdout } from "../mcp/handlers/stdio.js";
import type { CostOptions } from "../metrics/cost/metric.js";
import { estimateLabel, factEstimator } from "../usage/estimate.js";
import { dxChatsContract } from "./contract.js";
import { buildChatTree } from "./tree.js";

export interface DxChatsDeps {
  readonly costOptions?: CostOptions;
  readonly resolveSelector?: SelectorResolver;
}

const unitMs = (unit: string): number => {
  switch (unit) {
    case "w": {
      return 604_800_000;
    }

    case "d": {
      return 86_400_000;
    }

    case "h": {
      return 3_600_000;
    }

    default: {
      return 60_000;
    }
  }
};

const RELATIVE = /^(?<amount>\d{1,5})(?<unit>[mhdw])$/u;

const ISO = /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:\d{2})?)?$/u;

const isoAt = (value: number | string): string | null =>
  Option.match(DateTime.make(value), {
    onNone: () => null,
    onSome: (at) => DateTime.formatIso(at),
  });

export const resolveSince = (
  since: string | undefined,
  nowMs: number
): Effect.Effect<string | null, InvalidInput> => {
  if (since === undefined) {
    return Effect.succeed(null);
  }

  const trimmed = since.trim();
  const relative = RELATIVE.exec(trimmed);

  if (relative !== null) {
    const amount = Number(relative.groups?.amount ?? "0");

    return Effect.succeed(
      isoAt(nowMs - amount * unitMs(relative.groups?.unit ?? "m"))
    );
  }

  const parsed = ISO.test(trimmed) ? isoAt(trimmed) : null;

  if (parsed !== null) {
    return Effect.succeed(parsed);
  }

  return Effect.fail(
    new InvalidInput({
      field: "since",
      message: "since must look like 7d, 12h, 30m, 2w or an ISO-8601 timestamp",
    })
  );
};

const cleanBranch = (branch: string | undefined) => {
  const trimmed = branch?.trim() ?? "";

  return trimmed === "" ? null : trimmed;
};

export const makeDxChatsCapability = (deps: DxChatsDeps = {}) => {
  const costOptions = deps.costOptions ?? null;
  const estimate = factEstimator(costOptions);
  const label = estimateLabel(costOptions);

  return implement(dxChatsContract, (input) =>
    isolateStdout(
      Effect.gen(function* dxChats() {
        const store = yield* EventStore;
        const resolve = deps.resolveSelector ?? literalSelectorResolver;

        const now = yield* DateTime.now;

        const since = yield* resolveSince(
          input.since,
          DateTime.toEpochMillis(now)
        );

        const resolved = yield* resolve({
          flight: null,
          repo: input.repo?.trim() ?? null,
        });

        const selector = {
          ...resolved,
          branch:
            input.allBranches === true
              ? null
              : (cleanBranch(input.branch) ?? resolved.branch),
          from: since ?? resolved.from,
        };

        const { events, wide } = yield* accountAwareEvents(store, selector);
        const retro = yield* reattributeIfPossible(events);
        const snapshot = narrowToBranch(wide, selector, retro.events);

        return buildChatTree(
          snapshot.events,
          {
            branch: selector.branch,
            repoCommonDir: selector.repoCommonDir,
            since,
          },
          retro.events,
          {
            estimate,
            estimateLabel: label,
            filters: {
              effort: input.effort,
              model: input.model,
              provider: input.provider,
              tool: input.tool,
              via: input.via,
            },
          }
        );
      })
    )
  );
};
