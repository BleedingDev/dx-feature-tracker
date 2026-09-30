import type { EvidenceId } from "../../model/ids.js";
import { EvidenceIdSchema } from "../../model/ids.js";
import { alignUnique } from "./alignment.js";
import type {
  CheckpointEvidence,
  EditActor,
  EditEvidence,
  Located,
} from "./evidence.js";

export type UnresolvedReason =
  | "missing-preimage"
  | "concurrent-edits"
  | "unknown-change"
  | "ambiguous-repeated-lines"
  | "tool-retry"
  | "rename"
  | "formatting"
  | "missing-checkpoint";

export type LineOrigin = EditActor | "baseline";

export interface LineInstance {
  readonly hash: string;
  readonly instanceId: string;
  readonly origin: LineOrigin;
}

export interface FileSurvival {
  readonly aiIntroduced: number;
  readonly aiRemovedByHuman: number;
  readonly aiRemovedByUnknown: number;
  readonly aiSurviving: number;
  readonly evidenceIds: readonly EvidenceId[];
  readonly filePath: string;
  readonly unresolved: UnresolvedReason | null;
}

const idOf = (located: Located<unknown>): EvidenceId =>
  EvidenceIdSchema.make(located.event.eventId);

const unresolvedFile = (
  filePath: string,
  reason: UnresolvedReason,
  evidenceIds: readonly EvidenceId[]
): FileSurvival => ({
  aiIntroduced: 0,
  aiRemovedByHuman: 0,
  aiRemovedByUnknown: 0,
  aiSurviving: 0,
  evidenceIds,
  filePath,
  unresolved: reason,
});

const sameHashes = (
  lines: readonly LineInstance[],
  hashes: readonly string[]
): boolean =>
  lines.length === hashes.length &&
  lines.every((line, index) => line.hash === hashes[index]);

const flagOf = (edit: EditEvidence): UnresolvedReason | null => {
  if (edit.beforeLineHashes === null) {
    return "missing-preimage";
  }

  if (edit.retryOf !== undefined && edit.retryOf !== null) {
    return "tool-retry";
  }

  if (edit.renamedFrom !== undefined && edit.renamedFrom !== null) {
    return "rename";
  }

  if (edit.formattingOnly === true) {
    return "formatting";
  }

  return null;
};

type EditOutcome =
  | { readonly kind: "lines"; readonly lines: readonly LineInstance[] }
  | { readonly kind: "unresolved"; readonly reason: UnresolvedReason };

interface Tally {
  aiIntroduced: number;
  aiRemovedByHuman: number;
  aiRemovedByUnknown: number;
}

const applyEdit = (
  lines: readonly LineInstance[],
  edit: EditEvidence,
  editId: string,
  tally: Tally
): EditOutcome => {
  const alignment = alignUnique(
    lines.map((line) => line.hash),
    edit.afterLineHashes
  );

  if (alignment.kind === "ambiguous") {
    return { kind: "unresolved", reason: "ambiguous-repeated-lines" };
  }

  const keptBefore = new Set(alignment.pairs.map(([b]) => b));
  const keptAfter = new Map(alignment.pairs.map(([b, a]) => [a, b]));

  for (const [index, line] of lines.entries()) {
    if (!keptBefore.has(index) && line.origin === "ai") {
      if (edit.actor === "human") {
        tally.aiRemovedByHuman += 1;
      } else if (edit.actor === "unknown") {
        tally.aiRemovedByUnknown += 1;
      }
    }
  }

  const next = edit.afterLineHashes.map((hash, index): LineInstance => {
    const beforeIndex = keptAfter.get(index);
    const kept = beforeIndex === undefined ? undefined : lines[beforeIndex];

    if (kept !== undefined) {
      return kept;
    }

    if (edit.actor === "ai") {
      tally.aiIntroduced += 1;
    }

    return { hash, instanceId: `${editId}#${index}`, origin: edit.actor };
  });

  return { kind: "lines", lines: next };
};

export const projectFileSurvival = (
  filePath: string,
  edits: readonly Located<EditEvidence>[],
  checkpoint: Located<CheckpointEvidence> | null
): FileSurvival => {
  const ordered = [...edits].toSorted(
    (a, b) => a.value.sequence - b.value.sequence
  );

  const evidenceIds = [
    ...ordered.map(idOf),
    ...(checkpoint === null ? [] : [idOf(checkpoint)]),
  ];

  const sequences = new Set(ordered.map((edit) => edit.value.sequence));

  if (sequences.size !== ordered.length) {
    return unresolvedFile(filePath, "concurrent-edits", evidenceIds);
  }

  if (checkpoint === null) {
    return unresolvedFile(filePath, "missing-checkpoint", evidenceIds);
  }

  const tally: Tally = {
    aiIntroduced: 0,
    aiRemovedByHuman: 0,
    aiRemovedByUnknown: 0,
  };

  let lines: readonly LineInstance[] | null = null;

  for (const edit of ordered) {
    const flag = flagOf(edit.value);

    if (flag !== null) {
      return unresolvedFile(filePath, flag, evidenceIds);
    }

    const before = edit.value.beforeLineHashes ?? [];

    if (lines === null) {
      lines = before.map((hash, index) => ({
        hash,
        instanceId: `baseline#${index}`,
        origin: "baseline" as const,
      }));
    } else if (!sameHashes(lines, before)) {
      return unresolvedFile(filePath, "unknown-change", evidenceIds);
    }

    const next = applyEdit(lines, edit.value, edit.event.eventId, tally);

    if (next.kind === "unresolved") {
      return unresolvedFile(filePath, next.reason, evidenceIds);
    }

    ({ lines } = next);
  }

  const finalLines = lines ?? [];

  const toCheckpoint = applyEdit(
    finalLines,
    {
      actor: "unknown",
      afterLineHashes: checkpoint.value.lineHashes,
      beforeLineHashes: finalLines.map((line) => line.hash),
      filePath,
      provenance: "dx.provenance.edit.v1",
      sequence: Number.MAX_SAFE_INTEGER,
    },
    checkpoint.event.eventId,
    tally
  );

  if (toCheckpoint.kind === "unresolved") {
    return unresolvedFile(filePath, toCheckpoint.reason, evidenceIds);
  }

  const aiSurviving = toCheckpoint.lines.filter(
    (line) => line.origin === "ai"
  ).length;

  return {
    aiIntroduced: tally.aiIntroduced,
    aiRemovedByHuman: tally.aiRemovedByHuman,
    aiRemovedByUnknown: tally.aiRemovedByUnknown,
    aiSurviving,
    evidenceIds,
    filePath,
    unresolved: null,
  };
};
