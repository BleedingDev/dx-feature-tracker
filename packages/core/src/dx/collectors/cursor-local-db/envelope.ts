// @effect-diagnostics-next-line nodeBuiltinImport:off -- Event IDs are the contract's synchronous sha256 over adapter, upstream key and kind.
import { createHash } from "node:crypto";

import { DateTime, Option } from "effect";

import { withCollectorBlocks } from "../../harness/collector-blocks.js";
import type { Origin } from "../../model/common.js";
import type {
  DxEventEnvelope,
  EventIdentity,
  EventKind,
  FieldSemantics,
  FlightContext,
} from "../../model/event.js";
import { EVENT_SCHEMA_VERSION, emptyEventIdentity } from "../../model/event.js";
import { EventIdSchema } from "../../model/ids.js";
import {
  CURSOR_LOCAL_DB_ADAPTER_ID,
  CURSOR_LOCAL_DB_ADAPTER_VERSION,
} from "./descriptor.js";

export const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export const toIso = (value: number | string | null | undefined) =>
  value === null || value === undefined || value === "" || value === 0
    ? null
    : Option.match(DateTime.make(value), {
        onNone: () => null,
        onSome: DateTime.formatIso,
      });

export interface EnvelopeInput {
  readonly kind: EventKind;
  readonly upstreamKey: string;
  readonly occurredAt: string | null;
  readonly observedAt: string;
  readonly origin: Origin;
  readonly context: FlightContext;
  readonly identity: Partial<EventIdentity>;
  readonly payload: DxEventEnvelope["payload"];
  readonly fieldSemantics: readonly FieldSemantics[];
  readonly sourceVersion: string;
  readonly sourceHash: string;
}

export const buildEnvelope = (input: EnvelopeInput): DxEventEnvelope =>
  withCollectorBlocks({
    acquisition: "db-snapshot",
    adapterId: CURSOR_LOCAL_DB_ADAPTER_ID,
    adapterVersion: CURSOR_LOCAL_DB_ADAPTER_VERSION,
    context: input.context,
    eventId: EventIdSchema.make(
      sha256(
        `${CURSOR_LOCAL_DB_ADAPTER_ID}\n${input.upstreamKey}\n${input.kind}`
      )
    ),
    evidence: {
      bounded: true,
      hash: input.sourceHash,
      ref: `${CURSOR_LOCAL_DB_ADAPTER_ID}:${input.upstreamKey}`,
    },
    fieldSemantics: input.fieldSemantics,
    identity: { ...emptyEventIdentity, ...input.identity },
    kind: input.kind,
    observedAt: input.observedAt,
    occurredAt: input.occurredAt,
    occurredAtPrecision: input.occurredAt === null ? "unknown" : "exact",
    origin: input.origin,
    payload: input.payload,
    schemaVersion: EVENT_SCHEMA_VERSION,
    sourceVersion: input.sourceVersion,
    upstreamKey: input.upstreamKey,
  });

export const reported = (
  field: string,
  rawName: string,
  unit: string | null,
  note: string | null = null
): FieldSemantics => ({
  field,
  method: "source-reported",
  note,
  rawName,
  unit,
});
