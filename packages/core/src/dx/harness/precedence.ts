import type { ModuleReadiness } from "../model/descriptor.js";
import {
  CLAUDE_CODE_CHANNELS,
  CLAUDE_CODE_READINESS,
} from "./claude-code/meta.js";
import { CODEX_CHANNELS, CODEX_READINESS } from "./codex/meta.js";
import { CURSOR_CHANNELS, CURSOR_READINESS } from "./cursor/meta.js";
import { DEEPSEEK_CHANNELS, DEEPSEEK_READINESS } from "./deepseek/meta.js";
import type { Channel, HarnessId } from "./ids.js";
import { OMP_CHANNELS, OMP_READINESS } from "./omp/meta.js";
import { OPENCODE_CHANNELS, OPENCODE_READINESS } from "./opencode/meta.js";
import { PI_CHANNELS, PI_READINESS } from "./pi/meta.js";

export interface HarnessMeta {
  readonly channels: readonly Channel[];
  readonly readiness: ModuleReadiness;
}

export const HARNESS_META: Readonly<Record<HarnessId, HarnessMeta>> = {
  "claude-code": {
    channels: CLAUDE_CODE_CHANNELS,
    readiness: CLAUDE_CODE_READINESS,
  },
  codex: { channels: CODEX_CHANNELS, readiness: CODEX_READINESS },
  cursor: { channels: CURSOR_CHANNELS, readiness: CURSOR_READINESS },
  deepseek: { channels: DEEPSEEK_CHANNELS, readiness: DEEPSEEK_READINESS },
  omp: { channels: OMP_CHANNELS, readiness: OMP_READINESS },
  opencode: { channels: OPENCODE_CHANNELS, readiness: OPENCODE_READINESS },
  pi: { channels: PI_CHANNELS, readiness: PI_READINESS },
};

export const UNRANKED = 1000;

export const channelRank = (harness: HarnessId, channel: Channel): number => {
  const index = HARNESS_META[harness].channels.indexOf(channel);

  return index === -1 ? UNRANKED : index;
};

export interface EvidenceOrigin {
  readonly channel: Channel;
  readonly harness: HarnessId | null;
}

export const evidenceRank = (origin: EvidenceOrigin | null): number =>
  origin === null || origin.harness === null
    ? UNRANKED
    : channelRank(origin.harness, origin.channel);
