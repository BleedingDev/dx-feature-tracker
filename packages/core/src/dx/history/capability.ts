import { implement } from "@rat-stack/capability/define";
import { DateTime, Effect } from "effect";

import { InvalidInput } from "../contracts/error-invalid-input.js";
import { EventStore } from "../contracts/event-store.js";
import type { CostOptions } from "../metrics/cost/metric.js";
import { NO_COST_OPTIONS } from "../metrics/cost/metric.js";
import type { FlightContext } from "../model/event.js";
import { contextForRepo } from "../registry/runtime.js";
import { computeHistory, isoOf, parseSince } from "./compute.js";
import type { BranchStatusResolver } from "./compute.js";
import { HISTORY_CONTRACT_VERSION, dxHistoryContract } from "./contract.js";
import { gitBranchStatus } from "./git-status.js";

export interface DxHistoryDeps {
  readonly costOptions?: CostOptions;
  readonly defaultRepo: string;
  readonly resolveContext?: (repo: string) => FlightContext;
  readonly resolveStatus?: BranchStatusResolver;
}

export const makeDxHistoryCapability = (deps: DxHistoryDeps) =>
  implement(dxHistoryContract, (input) =>
    Effect.gen(function* dxHistory() {
      const store = yield* EventStore;
      const now = yield* DateTime.now;
      const nowMs = DateTime.toEpochMillis(now);
      const asOf = DateTime.formatIso(now);
      const allRepos = input.allRepos === true;
      const resolveContext = deps.resolveContext ?? contextForRepo;
      const context = resolveContext(input.repo ?? deps.defaultRepo);

      if (!allRepos && context.repoCommonDir === null) {
        return yield* new InvalidInput({
          field: "repo",
          message: `${input.repo ?? deps.defaultRepo} is not inside a git repository; pass a repo path or allRepos`,
        });
      }

      const since =
        input.since === undefined ? null : parseSince(input.since, nowMs);

      if (since !== null && !since.ok) {
        return yield* new InvalidInput({
          field: "since",
          message: since.message,
        });
      }

      const snapshot = yield* store.snapshot({
        branch: null,
        flightId: null,
        from: null,
        repoCommonDir: allRepos ? null : context.repoCommonDir,
        to: null,
      });

      const result = computeHistory(snapshot, {
        allRepos,
        asOf,
        costOptions: deps.costOptions ?? NO_COST_OPTIONS,
        repoCommonDir: context.repoCommonDir,
        resolveStatus: deps.resolveStatus ?? gitBranchStatus,
        sinceMs: since === null ? null : since.ms,
      });

      return {
        allRepos,
        asOf,
        contractVersion: HISTORY_CONTRACT_VERSION,
        notes: result.notes,
        repoCommonDir: allRepos ? null : context.repoCommonDir,
        rows: result.rows,
        since: since === null ? null : isoOf(since.ms),
      };
    })
  );
