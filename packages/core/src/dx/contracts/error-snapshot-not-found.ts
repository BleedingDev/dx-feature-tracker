import { Schema } from "effect";

export class SnapshotNotFound extends Schema.TaggedError<SnapshotNotFound>()(
  "SnapshotNotFound",
  { message: Schema.String, snapshotId: Schema.String }
) {}
