import { Schema } from "effect";

export const EventIdSchema = Schema.String.pipe(Schema.brand("dx/EventId"));

export type EventId = typeof EventIdSchema.Type;

export const FlightIdSchema = Schema.String.pipe(Schema.brand("dx/FlightId"));

export type FlightId = typeof FlightIdSchema.Type;

export const SnapshotIdSchema = Schema.String.pipe(
  Schema.brand("dx/SnapshotId")
);

export type SnapshotId = typeof SnapshotIdSchema.Type;

export const EvidenceIdSchema = Schema.String.pipe(
  Schema.brand("dx/EvidenceId")
);

export type EvidenceId = typeof EvidenceIdSchema.Type;

export const DescriptorIdSchema = Schema.String.pipe(
  Schema.brand("dx/DescriptorId")
);

export type DescriptorId = typeof DescriptorIdSchema.Type;

export const MetricIdSchema = Schema.String.pipe(Schema.brand("dx/MetricId"));

export type MetricId = typeof MetricIdSchema.Type;

export const RequestKeySchema = Schema.String.pipe(
  Schema.brand("dx/RequestKey")
);

export type RequestKey = typeof RequestKeySchema.Type;

export const TurnKeySchema = Schema.String.pipe(Schema.brand("dx/TurnKey"));

export type TurnKey = typeof TurnKeySchema.Type;

export const OverlapGroupIdSchema = Schema.String.pipe(
  Schema.brand("dx/OverlapGroupId")
);

export type OverlapGroupId = typeof OverlapGroupIdSchema.Type;
