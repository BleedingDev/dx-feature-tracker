import { Option, Schema } from "effect";

export const SUPPORTED_AUTHORSHIP_PREFIX = "authorship/3.";

export const MAX_FILES_PER_EVENT = 200;

export const MAX_PROMPTS_PER_EVENT = 50;

const SHA_PREFIX = /^(?<sha>[0-9a-f]{64}|[0-9a-f]{40})/u;

export const commitShaFromFileName = (name: string): string | null =>
  SHA_PREFIX.exec(name.toLowerCase())?.groups?.sha ?? null;

export interface AttestedFile {
  readonly aiLines: number;
  readonly path: string;
  readonly promptIds: readonly string[];
}

export interface AttestedPrompt {
  readonly acceptedLines: number | null;
  readonly model: string | null;
  readonly overriddenLines: number | null;
  readonly promptId: string;
  readonly tool: string | null;
  readonly totalAdditions: number | null;
  readonly totalDeletions: number | null;
}

export interface ParsedAuthorshipNote {
  readonly baseCommitSha: string | null;
  readonly files: readonly AttestedFile[];
  readonly gitAiVersion: string | null;
  readonly prompts: readonly AttestedPrompt[];
  readonly schemaVersion: string;
}

export interface NoteParseResult {
  readonly note: ParsedAuthorshipNote | null;
  readonly problem: string | null;
  readonly status: "ok" | "unsupported" | "invalid";
}

const NullableCount = Schema.optional(Schema.NullOr(Schema.Finite));

const PromptRecordSchema = Schema.Struct({
  accepted_lines: NullableCount,
  agent_id: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        model: Schema.optional(Schema.NullOr(Schema.String)),
        tool: Schema.optional(Schema.NullOr(Schema.String)),
      })
    )
  ),
  overriden_lines: NullableCount,
  total_additions: NullableCount,
  total_deletions: NullableCount,
});

const MetadataSchema = Schema.Struct({
  base_commit_sha: Schema.optional(Schema.NullOr(Schema.String)),
  git_ai_version: Schema.optional(Schema.NullOr(Schema.String)),
  prompts: Schema.optional(Schema.Record(Schema.String, PromptRecordSchema)),
  schema_version: Schema.String,
});

const decodeMetadata = Schema.decodeUnknownOption(
  Schema.fromJsonString(MetadataSchema)
);

const countOf = (value: number | null | undefined): number | null => {
  if (value === null || value === undefined) {
    return null;
  }

  return Number.isInteger(value) && value >= 0 ? value : null;
};

export const countRangeLines = (ranges: string): number | null => {
  let total = 0;

  for (const part of ranges.split(",")) {
    const match = /^(?<start>\d+)(?:-(?<end>\d+))?$/u.exec(part.trim());

    if (match === null) {
      return null;
    }

    const start = Number(match.groups?.start);
    const endRaw = match.groups?.end;
    const end = endRaw === undefined ? start : Number(endRaw);

    if (end < start) {
      return null;
    }

    total += end - start + 1;
  }

  return total;
};

const unquotePath = (raw: string): string => {
  const trimmed = raw.trim();

  return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1)
    : trimmed;
};

interface MutableAttestedFile {
  aiLines: number;
  readonly path: string;
  readonly promptIds: string[];
}

interface AttestationParse {
  readonly files: readonly AttestedFile[];
  readonly problem: string | null;
}

const parseAttestations = (section: string): AttestationParse => {
  const files: MutableAttestedFile[] = [];

  for (const line of section.split("\n")) {
    const current = files.at(-1);

    if (line.trim().length === 0) {
      continue;
    }

    if (!/^\s/u.test(line)) {
      files.push({ aiLines: 0, path: unquotePath(line), promptIds: [] });
      continue;
    }

    if (current === undefined) {
      return { files: [], problem: "attestation entry before any file path" };
    }

    const [promptId, ...rest] = line.trim().split(/\s+/u);
    const lines = countRangeLines(rest.join(""));

    if (promptId === undefined || lines === null) {
      return {
        files: [],
        problem: `malformed attestation line for ${current.path}`,
      };
    }

    current.aiLines += lines;

    if (!current.promptIds.includes(promptId)) {
      current.promptIds.push(promptId);
    }
  }

  return { files, problem: null };
};

const invalid = (problem: string): NoteParseResult => ({
  note: null,
  problem,
  status: "invalid",
});

export const parseAuthorshipNote = (text: string): NoteParseResult => {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const dividerIndex = lines.findIndex((line) => line.trim() === "---");

  if (dividerIndex === -1) {
    return invalid("missing '---' divider");
  }

  const metadata = decodeMetadata(lines.slice(dividerIndex + 1).join("\n"));

  if (Option.isNone(metadata)) {
    return invalid("metadata section is not a recognised JSON object");
  }

  const meta = metadata.value;

  if (!meta.schema_version.startsWith(SUPPORTED_AUTHORSHIP_PREFIX)) {
    return {
      note: null,
      problem: `authorship schema ${meta.schema_version} is not supported (expected authorship/3.x)`,
      status: "unsupported",
    };
  }

  const attestations = parseAttestations(
    lines.slice(0, dividerIndex).join("\n")
  );

  if (attestations.problem !== null) {
    return invalid(attestations.problem);
  }

  const prompts: AttestedPrompt[] = Object.entries(meta.prompts ?? {})
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([promptId, record]) => ({
      acceptedLines: countOf(record.accepted_lines),
      model: record.agent_id?.model ?? null,
      overriddenLines: countOf(record.overriden_lines),
      promptId,
      tool: record.agent_id?.tool ?? null,
      totalAdditions: countOf(record.total_additions),
      totalDeletions: countOf(record.total_deletions),
    }));

  return {
    note: {
      baseCommitSha: meta.base_commit_sha ?? null,
      files: attestations.files,
      gitAiVersion: meta.git_ai_version ?? null,
      prompts,
      schemaVersion: meta.schema_version,
    },
    problem: null,
    status: "ok",
  };
};

const StatsSchema = Schema.Struct({
  ai_accepted: NullableCount,
  ai_additions: Schema.Finite,
  git_diff_added_lines: Schema.Finite,
  git_diff_deleted_lines: NullableCount,
  human_additions: Schema.Finite,
  mixed_additions: NullableCount,
  total_ai_additions: NullableCount,
  total_ai_deletions: NullableCount,
});

const decodeStats = Schema.decodeUnknownOption(
  Schema.fromJsonString(StatsSchema)
);

export interface ParsedCommitStats {
  readonly aiAcceptedLines: number | null;
  readonly aiAdditions: number;
  readonly aiAdditionShareAtCommit: number | null;
  readonly diffAddedLines: number;
  readonly diffDeletedLines: number | null;
  readonly mixedAdditions: number | null;
  readonly sourceHumanAdditions: number;
  readonly totalAiAdditions: number | null;
  readonly totalAiDeletions: number | null;
  readonly unattributedAdditions: number | null;
  readonly unattributedReason: string | null;
}

const unattributedReasonOf = (
  mixed: number | null,
  remainder: number
): string | null => {
  if (mixed === null) {
    return "mixed_additions missing; remainder not computable";
  }

  return remainder < 0
    ? "source categories exceed git_diff_added_lines; overlap between categories is unknown"
    : null;
};

export const parseCommitStats = (text: string): ParsedCommitStats | null => {
  const decoded = decodeStats(text);

  if (Option.isNone(decoded)) {
    return null;
  }

  const stats = decoded.value;
  const ai = countOf(stats.ai_additions);
  const human = countOf(stats.human_additions);
  const added = countOf(stats.git_diff_added_lines);

  if (ai === null || human === null || added === null) {
    return null;
  }

  const mixed = countOf(stats.mixed_additions);
  const remainder = added - ai - human - (mixed ?? 0);
  const unattributedReason = unattributedReasonOf(mixed, remainder);

  return {
    aiAcceptedLines: countOf(stats.ai_accepted),
    aiAdditionShareAtCommit: added === 0 ? null : ai / added,
    aiAdditions: ai,
    diffAddedLines: added,
    diffDeletedLines: countOf(stats.git_diff_deleted_lines),
    mixedAdditions: mixed,
    sourceHumanAdditions: human,
    totalAiAdditions: countOf(stats.total_ai_additions),
    totalAiDeletions: countOf(stats.total_ai_deletions),
    unattributedAdditions: unattributedReason === null ? remainder : null,
    unattributedReason,
  };
};
