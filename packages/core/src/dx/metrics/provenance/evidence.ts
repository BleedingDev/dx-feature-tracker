import { Option, Schema } from "effect";

import type { DxEventEnvelope } from "../../model/event.js";

export const EDIT_EVIDENCE_TAG = "dx.provenance.edit.v1" as const;

export const CHECKPOINT_EVIDENCE_TAG = "dx.provenance.checkpoint.v1" as const;

export const SOURCE_ATTRIBUTED_TAG =
  "dx.provenance.source-attributed.v1" as const;

export const EditActorSchema = Schema.Literals(["ai", "human", "unknown"]);

export type EditActor = typeof EditActorSchema.Type;

export const EditEvidenceSchema = Schema.Struct({
  actor: EditActorSchema,
  afterLineHashes: Schema.Array(Schema.String),
  beforeLineHashes: Schema.NullOr(Schema.Array(Schema.String)),
  filePath: Schema.String,
  formattingOnly: Schema.optional(Schema.Boolean),
  provenance: Schema.Literal(EDIT_EVIDENCE_TAG),
  renamedFrom: Schema.optional(Schema.NullOr(Schema.String)),
  retryOf: Schema.optional(Schema.NullOr(Schema.String)),
  sequence: Schema.Int,
});

export type EditEvidence = typeof EditEvidenceSchema.Type;

export const CheckpointEvidenceSchema = Schema.Struct({
  checkpoint: Schema.String,
  filePath: Schema.String,
  lineHashes: Schema.Array(Schema.String),
  provenance: Schema.Literal(CHECKPOINT_EVIDENCE_TAG),
});

export type CheckpointEvidence = typeof CheckpointEvidenceSchema.Type;

export const SourceAttributedEvidenceSchema = Schema.Struct({
  aiLines: Schema.NullOr(Schema.Int),
  provenance: Schema.Literal(SOURCE_ATTRIBUTED_TAG),
  sourceName: Schema.String,
  totalLines: Schema.NullOr(Schema.Int),
});

export type SourceAttributedEvidence =
  typeof SourceAttributedEvidenceSchema.Type;

export interface Located<A> {
  readonly event: DxEventEnvelope;
  readonly value: A;
}

const decodeEdit = Schema.decodeUnknownOption(EditEvidenceSchema);

const decodeCheckpoint = Schema.decodeUnknownOption(CheckpointEvidenceSchema);

const decodeSourceAttributed = Schema.decodeUnknownOption(
  SourceAttributedEvidenceSchema
);

export interface ProvenanceEvidence {
  readonly checkpoints: readonly Located<CheckpointEvidence>[];
  readonly edits: readonly Located<EditEvidence>[];
  readonly malformed: readonly DxEventEnvelope[];
  readonly sourceAttributed: readonly Located<SourceAttributedEvidence>[];
}

const ProvenanceTagSchema = Schema.Struct({ provenance: Schema.String });

const decodeTag = Schema.decodeUnknownOption(ProvenanceTagSchema);

const tagOf = (event: DxEventEnvelope): string | null => {
  const decoded = decodeTag(event.payload);

  return Option.isSome(decoded) ? decoded.value.provenance : null;
};

export const extractProvenanceEvidence = (
  events: readonly DxEventEnvelope[]
): ProvenanceEvidence => {
  const edits: Located<EditEvidence>[] = [];
  const checkpoints: Located<CheckpointEvidence>[] = [];
  const sourceAttributed: Located<SourceAttributedEvidence>[] = [];
  const malformed: DxEventEnvelope[] = [];

  for (const event of events) {
    const tag = tagOf(event);

    if (tag === EDIT_EVIDENCE_TAG) {
      const decoded = decodeEdit(event.payload);

      if (Option.isSome(decoded)) {
        edits.push({ event, value: decoded.value });
      } else {
        malformed.push(event);
      }
    } else if (tag === CHECKPOINT_EVIDENCE_TAG) {
      const decoded = decodeCheckpoint(event.payload);

      if (Option.isSome(decoded)) {
        checkpoints.push({ event, value: decoded.value });
      } else {
        malformed.push(event);
      }
    } else if (tag === SOURCE_ATTRIBUTED_TAG) {
      const decoded = decodeSourceAttributed(event.payload);

      if (Option.isSome(decoded)) {
        sourceAttributed.push({ event, value: decoded.value });
      } else {
        malformed.push(event);
      }
    }
  }

  return { checkpoints, edits, malformed, sourceAttributed };
};
