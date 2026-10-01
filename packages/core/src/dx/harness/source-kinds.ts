import { AiSourceKindSchema } from "../model/ai.js";
import type { AiSourceKind } from "../model/ai.js";
import type { Channel, HarnessId } from "./ids.js";
import { channelRank } from "./precedence.js";

const CHANNEL_WEIGHT = 10;

const SECONDARY_SCALE = 1000;

const HARNESS_BANDS: Readonly<Record<HarnessId, number | null>> = {
  "claude-code": 32,
  codex: 33,
  cursor: null,
  deepseek: 37,
  omp: 36,
  opencode: 34,
  pi: 35,
};

interface HarnessSource {
  readonly channel: Channel;
  readonly harness: HarnessId;
  readonly within: number;
}

const HARNESS_SOURCES: Readonly<Partial<Record<AiSourceKind, HarnessSource>>> =
  {
    "claude-jsonl": {
      channel: "session-file",
      harness: "claude-code",
      within: 0,
    },
    "codex-session": { channel: "session-file", harness: "codex", within: 0 },
    "cursor-cli": { channel: "cli-stream", harness: "cursor", within: 1 },
    "dashboard-json": { channel: "usage-api", harness: "cursor", within: 1 },
    "deepseek-session": {
      channel: "session-file",
      harness: "deepseek",
      within: 0,
    },
    "hooks-stop": { channel: "hooks", harness: "cursor", within: 0 },
    "local-db": { channel: "local-db", harness: "cursor", within: 0 },
    opencode: { channel: "session-file", harness: "opencode", within: 0 },
    "pi-session": { channel: "session-file", harness: "pi", within: 0 },
    sdk: { channel: "cli-stream", harness: "cursor", within: 0 },
    "transcript-estimate": {
      channel: "transcript",
      harness: "cursor",
      within: 0,
    },
    "usage-csv": { channel: "usage-api", harness: "cursor", within: 0 },
  };

const UNATTRIBUTED_RANKS: Readonly<Partial<Record<AiSourceKind, number>>> = {
  entire: 45,
  "provider-receipt": 15,
};

const UNKNOWN_RANK = 10_000;

export const harnessChannelRank = (
  harness: HarnessId,
  channel: Channel,
  within = 0
): number => {
  const local = channelRank(harness, channel) * CHANNEL_WEIGHT + within;
  const band = HARNESS_BANDS[harness];

  return band === null ? local : band + local / SECONDARY_SCALE;
};

export const aiSourceRank = (kind: AiSourceKind): number => {
  const source = HARNESS_SOURCES[kind];

  return source === undefined
    ? (UNATTRIBUTED_RANKS[kind] ?? UNKNOWN_RANK)
    : harnessChannelRank(source.harness, source.channel, source.within);
};

export const AI_SOURCES_BY_RANK: readonly AiSourceKind[] =
  AiSourceKindSchema.literals.toSorted(
    (a, b) => aiSourceRank(a) - aiSourceRank(b)
  );

export const UNKNOWN_SOURCE_RANK = UNKNOWN_RANK;
