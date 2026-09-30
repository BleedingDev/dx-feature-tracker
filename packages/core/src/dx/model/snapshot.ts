import { Schema } from "effect";

import { IsoTimestampSchema, OriginSchema } from "./common.js";
import { FlightIdSchema, SnapshotIdSchema } from "./ids.js";

export const SnapshotSelectorSchema = Schema.Struct({
  branch: Schema.NullOr(Schema.String),
  flightId: Schema.NullOr(FlightIdSchema),
  from: Schema.NullOr(IsoTimestampSchema),
  repoCommonDir: Schema.NullOr(Schema.String),
  to: Schema.NullOr(IsoTimestampSchema),
});

export type SnapshotSelector = typeof SnapshotSelectorSchema.Type;

export const VersionedIdSchema = Schema.Struct({
  id: Schema.String,
  version: Schema.String,
});

export type VersionedId = typeof VersionedIdSchema.Type;

export const OriginCountSchema = Schema.Struct({
  count: Schema.Int,
  origin: OriginSchema,
});

export type OriginCount = typeof OriginCountSchema.Type;

export const SnapshotManifestSchema = Schema.Struct({
  contractDigest: Schema.String,
  contractVersion: Schema.String,
  createdAt: IsoTimestampSchema,
  enabledDescriptors: Schema.Array(VersionedIdSchema),
  eventWatermark: Schema.String,
  metricDefinitions: Schema.Array(VersionedIdSchema),
  originMix: Schema.Array(OriginCountSchema),
  selector: SnapshotSelectorSchema,
  snapshotId: SnapshotIdSchema,
});

export type SnapshotManifest = typeof SnapshotManifestSchema.Type;
