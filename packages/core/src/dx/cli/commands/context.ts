import type { EventStoreService } from "../../contracts/services.js";
import type { FlightContext } from "../../model/event.js";
import type { SnapshotSelector } from "../../model/snapshot.js";

export interface DxCommandEnv {
  readonly store: EventStoreService;
  readonly storePath: string;
}

export const selectorFromContext = (
  context: FlightContext,
  window: { readonly from?: string | null; readonly to?: string | null } = {}
): SnapshotSelector => ({
  branch: context.branch,
  flightId: context.flightId,
  from: window.from ?? null,
  repoCommonDir: context.repoCommonDir,
  to: window.to ?? null,
});
