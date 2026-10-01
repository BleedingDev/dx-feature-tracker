import { Option, Schema, Struct } from "effect";

import { collectorBlocks } from "../harness/collector-blocks.js";
import {
  DxEventEnvelopeSchema,
  EVENT_SCHEMA_VERSION,
  EventBatchSchema,
} from "../model/event.js";
import type { DxEventEnvelope, EventBatch } from "../model/event.js";

export const V1_EVENT_SCHEMA_VERSION = "dx.event.v1" as const;

export const DxEventV1Schema = DxEventEnvelopeSchema.mapFields((fields) =>
  Struct.assign(Struct.omit(fields, ["ai", "usage"]), {
    schemaVersion: Schema.Literal(V1_EVENT_SCHEMA_VERSION),
  })
);

export type DxEventV1 = typeof DxEventV1Schema.Type;

export const StoredEventSchema = Schema.Union([
  DxEventEnvelopeSchema,
  DxEventV1Schema,
]);

export type StoredEvent = typeof StoredEventSchema.Type;

export const StoredBatchSchema = EventBatchSchema.mapFields(
  Struct.assign({ events: Schema.Array(StoredEventSchema) })
);

export type StoredBatch = typeof StoredBatchSchema.Type;

export const upgradeV1Event = (event: DxEventV1): DxEventEnvelope => {
  const current = { ...event, schemaVersion: EVENT_SCHEMA_VERSION };

  return { ...current, ...collectorBlocks(current) };
};

const isV1 = Schema.is(DxEventV1Schema);

export const toCurrentEvent = (event: StoredEvent): DxEventEnvelope =>
  isV1(event) ? upgradeV1Event(event) : event;

export const toCurrentBatch = (batch: StoredBatch): EventBatch => ({
  ...batch,
  events: batch.events.map(toCurrentEvent),
});

const decodeStoredJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(StoredEventSchema)
);

export const upgradedEventJson = (body: string): string | null =>
  Option.match(decodeStoredJson(body), {
    onNone: () => null,
    onSome: (event) =>
      isV1(event) ? JSON.stringify(upgradeV1Event(event)) : null,
  });
