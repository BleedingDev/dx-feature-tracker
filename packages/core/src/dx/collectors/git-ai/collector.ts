// @effect-diagnostics-next-line nodeBuiltinImport:off -- Event IDs are the contract's synchronous sha256 over adapter, upstream key and kind.
import { createHash } from "node:crypto";

import { DateTime, Effect, FileSystem, Path } from "effect";

import { InvalidInput } from "../../contracts/error-invalid-input.js";
import { SourceUnavailable } from "../../contracts/error-source-unavailable.js";
import type { CollectInput, DxCollector } from "../../contracts/services.js";
import { CONTRACT_VERSION } from "../../contracts/version.js";
import type { SourceGap } from "../../model/coverage.js";
import type { ModuleDescriptor } from "../../model/descriptor.js";
import type {
  DxEventEnvelope,
  EventBatch,
  FieldSemantics,
} from "../../model/event.js";
import { EVENT_SCHEMA_VERSION, emptyEventIdentity } from "../../model/event.js";
import { DescriptorIdSchema, EventIdSchema } from "../../model/ids.js";
import type { ParsedAuthorshipNote, ParsedCommitStats } from "./parse.js";
import {
  MAX_FILES_PER_EVENT,
  MAX_PROMPTS_PER_EVENT,
  commitShaFromFileName,
  parseAuthorshipNote,
  parseCommitStats,
} from "./parse.js";

export const GIT_AI_ADAPTER_ID = "git-ai";

export const GIT_AI_ADAPTER_VERSION = "0.1.0";

export const GIT_AI_FIXTURE_ID = "b45-git-ai-export";

export const GIT_AI_NOTE_SUFFIX = ".note";

export const GIT_AI_STATS_SUFFIX = ".stats.json";

const SOURCE_GAPS: readonly SourceGap[] = [
  {
    code: "producer-not-installed",
    message:
      "git-ai is not installed on this host (no `git ai`, no refs/notes/ai); only a user-selected export directory of <sha>.note and <sha>.stats.json files is read. The recorder never runs git-ai install/init and never fetches or pushes notes refs.",
  },
  {
    code: "stats-ratio-not-retention",
    message:
      "aiAdditionShareAtCommit is the commit-time share of added lines git-ai attested to AI; it is not code retention, survival or ownership over time.",
  },
  {
    code: "unattested-additions-unknown",
    message:
      "Lines without an AI attestation are not proven human. git-ai human_additions is kept as a source-reported label; the recorder reports unattributedAdditions only when source categories reconcile, otherwise null.",
  },
  {
    code: "no-tokens-or-cost",
    message:
      "git-ai notes and stats carry no token counts, charges or waiting time; those stay unavailable from this adapter.",
  },
  {
    code: "prompt-content-omitted",
    message:
      "Prompt messages and human_author fields are never imported; only counts, tool and model labels.",
  },
];

export const gitAiDescriptor: ModuleDescriptor = {
  contractVersion: CONTRACT_VERSION,
  fixtureIds: [GIT_AI_FIXTURE_ID],
  gaps: SOURCE_GAPS,
  id: DescriptorIdSchema.make("collector/git-ai"),
  kind: "collector",
  owner: "B45",
  readiness: "disabled",
  requiredInputs: [
    "user-selected directory (or single file) containing `git notes --ref=ai show <sha>` output saved as <sha>.note and/or `git-ai stats <sha> --json` output saved as <sha>.stats.json",
  ],
  supportedFields: [
    "identity.commitSha",
    "payload.record",
    "payload.schemaVersion",
    "payload.gitAiVersion",
    "payload.files",
    "payload.attestedAiLines",
    "payload.prompts",
    "payload.aiAdditions",
    "payload.sourceHumanAdditions",
    "payload.mixedAdditions",
    "payload.diffAddedLines",
    "payload.diffDeletedLines",
    "payload.unattributedAdditions",
    "payload.aiAdditionShareAtCommit",
  ],
  version: GIT_AI_ADAPTER_VERSION,
};

const NOTE_SEMANTICS: readonly FieldSemantics[] = [
  {
    field: "payload.attestedAiLines",
    method: "derived",
    note: "sum of line ranges in the git-ai authorship attestation section; lines not listed are unknown, not human",
    rawName: "attestations",
    unit: "lines",
  },
  {
    field: "payload.prompts",
    method: "source-reported",
    note: "per-prompt counters from authorship metadata; messages and human_author omitted",
    rawName: "prompts",
    unit: "lines",
  },
];

const STATS_SEMANTICS: readonly FieldSemantics[] = [
  {
    field: "payload.aiAdditions",
    method: "source-reported",
    note: null,
    rawName: "ai_additions",
    unit: "lines",
  },
  {
    field: "payload.sourceHumanAdditions",
    method: "source-reported",
    note: "git-ai labels non-attested additions human; not verified human ownership",
    rawName: "human_additions",
    unit: "lines",
  },
  {
    field: "payload.unattributedAdditions",
    method: "derived",
    note: "git_diff_added_lines - ai - human - mixed; null when categories do not reconcile",
    rawName: null,
    unit: "lines",
  },
  {
    field: "payload.aiAdditionShareAtCommit",
    method: "derived",
    note: "ai_additions / git_diff_added_lines at commit time; NOT retention",
    rawName: null,
    unit: "ratio",
  },
];

const hashOf = (text: string): string =>
  `sha256:${createHash("sha256").update(text).digest("hex")}`;

const eventIdOf = (upstreamKey: string): string =>
  hashOf(
    `${GIT_AI_ADAPTER_ID}\u0000${upstreamKey}\u0000provenance.attestation`
  );

export interface GitAiSourceFile {
  readonly name: string;
  readonly ref: string;
  readonly text: string;
}

const baseEnvelope = (
  sha: string,
  record: "authorship-note" | "stats",
  file: GitAiSourceFile,
  input: CollectInput,
  observedAt: string
) => {
  const upstreamKey = `${record}:${sha}`;

  return {
    acquisition: "file-import" as const,
    adapterId: GIT_AI_ADAPTER_ID,
    adapterVersion: GIT_AI_ADAPTER_VERSION,
    context: input.context,
    eventId: EventIdSchema.make(eventIdOf(upstreamKey)),
    evidence: { bounded: true, hash: hashOf(file.text), ref: file.ref },
    identity: { ...emptyEventIdentity, commitSha: sha },
    kind: "provenance.attestation" as const,
    observedAt,
    occurredAt: null,
    occurredAtPrecision: "unknown" as const,
    origin: input.origin,
    schemaVersion: EVENT_SCHEMA_VERSION,
    upstreamKey,
  };
};

const noteEnvelope = (
  sha: string,
  note: ParsedAuthorshipNote,
  file: GitAiSourceFile,
  input: CollectInput,
  observedAt: string
): DxEventEnvelope => ({
  ...baseEnvelope(sha, "authorship-note", file, input, observedAt),
  fieldSemantics: NOTE_SEMANTICS,
  payload: {
    attestedAiLines: note.files.reduce((sum, entry) => sum + entry.aiLines, 0),
    baseCommitSha: note.baseCommitSha,
    files: note.files.slice(0, MAX_FILES_PER_EVENT),
    filesTruncated: note.files.length > MAX_FILES_PER_EVENT,
    gitAiVersion: note.gitAiVersion,
    prompts: note.prompts.slice(0, MAX_PROMPTS_PER_EVENT),
    promptsTruncated: note.prompts.length > MAX_PROMPTS_PER_EVENT,
    record: "authorship-note",
    schemaVersion: note.schemaVersion,
    unattestedAdditions: null,
    unattestedAdditionsReason:
      "authorship note lists AI-attested ranges only; diff totals are not in the note",
  },
  sourceVersion: note.gitAiVersion ?? note.schemaVersion,
});

const statsEnvelope = (
  sha: string,
  stats: ParsedCommitStats,
  file: GitAiSourceFile,
  input: CollectInput,
  observedAt: string
): DxEventEnvelope => ({
  ...baseEnvelope(sha, "stats", file, input, observedAt),
  fieldSemantics: STATS_SEMANTICS,
  payload: {
    aiAcceptedLines: stats.aiAcceptedLines,
    aiAdditionShareAtCommit: stats.aiAdditionShareAtCommit,
    aiAdditionShareReason:
      stats.aiAdditionShareAtCommit === null
        ? "git_diff_added_lines is 0"
        : null,
    aiAdditions: stats.aiAdditions,
    diffAddedLines: stats.diffAddedLines,
    diffDeletedLines: stats.diffDeletedLines,
    mixedAdditions: stats.mixedAdditions,
    record: "stats",
    retention: null,
    retentionReason:
      "commit-time stats are not retention; no survival analysis performed",
    sourceHumanAdditions: stats.sourceHumanAdditions,
    totalAiAdditions: stats.totalAiAdditions,
    totalAiDeletions: stats.totalAiDeletions,
    unattributedAdditions: stats.unattributedAdditions,
    unattributedReason: stats.unattributedReason,
  },
  sourceVersion: null,
});

export const parseGitAiExport = (
  files: readonly GitAiSourceFile[],
  input: CollectInput,
  observedAt: string
): EventBatch => {
  const events = new Map<string, DxEventEnvelope>();
  const gaps: SourceGap[] = [...SOURCE_GAPS];
  let considered = 0;
  const ordered = files.toSorted((a, b) => a.name.localeCompare(b.name));

  for (const file of ordered) {
    const isStats = file.name.endsWith(GIT_AI_STATS_SUFFIX);
    const isNote = file.name.endsWith(GIT_AI_NOTE_SUFFIX);

    if (isStats || isNote) {
      considered += 1;
      const sha = commitShaFromFileName(file.name);

      if (sha === null) {
        gaps.push({
          code: "missing-commit-sha",
          message: `${file.name}: file name must start with the full commit SHA`,
        });
      } else if (isStats) {
        const stats = parseCommitStats(file.text);

        if (stats === null) {
          gaps.push({
            code: "rejected-stats",
            message: `${file.name}: not a recognised git-ai stats JSON object`,
          });
        } else {
          const envelope = statsEnvelope(sha, stats, file, input, observedAt);
          events.set(envelope.eventId, envelope);
        }
      } else {
        const result = parseAuthorshipNote(file.text);

        if (result.note === null) {
          gaps.push({
            code:
              result.status === "unsupported"
                ? "unsupported-schema-version"
                : "rejected-note",
            message: `${file.name}: ${result.problem ?? "unreadable note"}`,
          });
        } else {
          const envelope = noteEnvelope(
            sha,
            result.note,
            file,
            input,
            observedAt
          );

          events.set(envelope.eventId, envelope);
        }
      }
    }
  }

  const accepted = [...events.values()];

  return {
    coverage: {
      adapterId: GIT_AI_ADAPTER_ID,
      expectedItems: considered,
      gaps,
      observedItems: accepted.length,
      state: accepted.length === 0 ? "none" : "partial",
      watermark: null,
      windowFrom: null,
      windowTo: null,
    },
    cursor: null,
    events: accepted,
  };
};

const readSelected = Effect.fn("GitAi.readSelected")(function* readSelected(
  selected: string
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const info = yield* fileSystem.stat(selected);

  if (info.type !== "Directory") {
    const text = yield* fileSystem.readFileString(selected);

    return [{ name: path.basename(selected), ref: selected, text }];
  }

  const entries = yield* fileSystem.readDirectory(selected);

  const names = entries.filter(
    (name) =>
      name.endsWith(GIT_AI_NOTE_SUFFIX) || name.endsWith(GIT_AI_STATS_SUFFIX)
  );

  return yield* Effect.all(
    names.map((name) => {
      const ref = path.join(selected, name);

      return Effect.map(
        fileSystem.readFileString(ref),
        (text): GitAiSourceFile => ({ name, ref, text })
      );
    })
  );
});

export const gitAiCollector: DxCollector<FileSystem.FileSystem | Path.Path> = {
  collect: (input) =>
    Effect.gen(function* collectGitAi() {
      const selected = input.selectedInput;

      if (selected === null || selected.length === 0) {
        return yield* new InvalidInput({
          field: "input",
          message:
            "git-ai reads only an explicitly selected export directory or file (--input); it never runs git-ai or reads notes refs itself",
        });
      }

      const files = yield* readSelected(selected).pipe(
        Effect.mapError(
          () =>
            new SourceUnavailable({
              adapterId: GIT_AI_ADAPTER_ID,
              message: "selected git-ai export is not readable",
            })
        )
      );

      const now = yield* DateTime.now;

      return parseGitAiExport(files, input, DateTime.formatIso(now));
    }),
  descriptor: gitAiDescriptor,
};
