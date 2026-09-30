import type {
  DxMetric,
  MetricOutput,
  StoreSnapshot,
} from "../../contracts/services.js";
import { CONTRACT_VERSION } from "../../contracts/version.js";
import type { ModuleDescriptor } from "../../model/descriptor.js";
import type { DxEventEnvelope } from "../../model/event.js";
import type { EvidenceId } from "../../model/ids.js";
import {
  DescriptorIdSchema,
  EvidenceIdSchema,
  MetricIdSchema,
} from "../../model/ids.js";
import type { MetricDefinitionRef, MetricResult } from "../../model/metric.js";
import { aiUsageDefinitions, computeAiUsage } from "../ai-usage/metric.js";
import {
  chargeDefinition,
  computeCost,
  meteredDefinition,
  priceTableEstimateDefinition,
  sourceEstimateDefinition,
} from "../cost/metric.js";
import { agentDefinition, computeFlightTime } from "../flight-time/metric.js";

export const EPISODES_METRIC_VERSION = "1.0.0" as const;

export const DEFAULT_EPISODE_IDLE_GAP_MS = 8 * 60 * 60 * 1000;

export const CURRENT_EPISODE_WINDOW_MS = 24 * 60 * 60 * 1000;

const MAX_EVIDENCE = 200;

export interface EpisodeOptions {
  readonly currentWindowMs: number;
  readonly idleGapMs: number;
}

export const DEFAULT_EPISODE_OPTIONS: EpisodeOptions = {
  currentWindowMs: CURRENT_EPISODE_WINDOW_MS,
  idleGapMs: DEFAULT_EPISODE_IDLE_GAP_MS,
};

export interface Episode {
  readonly current: boolean;
  readonly endMs: number;
  readonly events: readonly DxEventEnvelope[];
  readonly index: number;
  readonly startMs: number;
}

const own = (
  id: string,
  unit: string,
  description: string
): MetricDefinitionRef => ({
  description,
  id: MetricIdSchema.make(id),
  unit,
  version: EPISODES_METRIC_VERSION,
});

export const episodeStartDefinition = own(
  "dx.episode.start",
  "epoch-ms",
  "First timestamped event of the episode."
);

export const episodeEndDefinition = own(
  "dx.episode.end",
  "epoch-ms",
  "Last timestamped event of the episode."
);

export const episodeCommitsDefinition = own(
  "dx.episode.commits",
  "commits",
  "Distinct commits whose commit time falls in the episode."
);

export const episodeCurrentDefinition = own(
  "dx.episode.current",
  "flag",
  "1 when the episode touches the last 24 hours before the snapshot as-of time, else 0."
);

const REUSED: readonly MetricDefinitionRef[] = [
  agentDefinition,
  ...aiUsageDefinitions,
  chargeDefinition,
  meteredDefinition,
  sourceEstimateDefinition,
  priceTableEstimateDefinition,
];

const episodeIdOf = (id: string): string =>
  `dx.episode.${id.replace(/^dx\./u, "")}`;

const reusedIds = new Set<string>(REUSED.map((d) => d.id));

const reusedDefinitions: readonly MetricDefinitionRef[] = REUSED.map((d) => ({
  ...d,
  description: `Per episode: ${d.description}`,
  id: MetricIdSchema.make(episodeIdOf(d.id)),
  version: EPISODES_METRIC_VERSION,
}));

export const episodeDefinitions: readonly MetricDefinitionRef[] = [
  episodeStartDefinition,
  episodeEndDefinition,
  episodeCommitsDefinition,
  episodeCurrentDefinition,
  ...reusedDefinitions,
];

const timeOf = (event: DxEventEnvelope): number | null => {
  if (event.occurredAt === null) {
    return null;
  }

  const ms = Date.parse(event.occurredAt);

  return Number.isNaN(ms) ? null : ms;
};

const branchEvents = (snapshot: StoreSnapshot): readonly DxEventEnvelope[] => {
  const { branch } = snapshot.manifest.selector;

  return branch === null
    ? snapshot.events
    : snapshot.events.filter((e) => e.context.branch === branch);
};

export const splitEpisodes = (
  events: readonly DxEventEnvelope[],
  asOfMs: number,
  options: EpisodeOptions = DEFAULT_EPISODE_OPTIONS
): readonly Episode[] => {
  const timed = events
    .flatMap((event) => {
      const at = timeOf(event);

      return at === null ? [] : [{ at, event }];
    })
    .toSorted((a, b) => a.at - b.at);

  const groups: { at: number; event: DxEventEnvelope }[][] = [];

  for (const item of timed) {
    const group = groups.at(-1);
    const last = group?.at(-1);

    if (
      group === undefined ||
      last === undefined ||
      item.at - last.at > options.idleGapMs
    ) {
      groups.push([item]);
    } else {
      group.push(item);
    }
  }

  return groups.map((group, index) => {
    const startMs = group[0]?.at ?? 0;
    const endMs = group.at(-1)?.at ?? startMs;

    return {
      current:
        index === groups.length - 1 &&
        endMs >= asOfMs - options.currentWindowMs,
      endMs,
      events: group.map((g) => g.event),
      index: index + 1,
      startMs,
    };
  });
};

const checkpointOf = (episode: Episode): string =>
  `episode:${episode.index}${episode.current ? ":current" : ""}`;

const plain = (
  snapshot: StoreSnapshot,
  episode: Episode,
  def: MetricDefinitionRef,
  value: number,
  evidenceIds: readonly EvidenceId[],
  reason: string | null
): MetricResult => ({
  asOf: snapshot.manifest.createdAt,
  attribution: "provisional",
  checkpoint: checkpointOf(episode),
  coverage: snapshot.coverage,
  definition: def,
  denominator: null,
  evidenceIds: evidenceIds.slice(0, MAX_EVIDENCE),
  measurement: "measured",
  method: "derived",
  metricId: def.id,
  numerator: null,
  reason,
  unit: def.unit,
  value,
});

const relabel = (
  episode: Episode,
  result: MetricResult
): MetricResult | null => {
  if (!reusedIds.has(result.metricId)) {
    return null;
  }

  const id = MetricIdSchema.make(episodeIdOf(result.metricId));

  return {
    ...result,
    checkpoint: checkpointOf(episode),
    definition: {
      ...result.definition,
      id,
      version: EPISODES_METRIC_VERSION,
    },
    metricId: id,
  };
};

const commitsIn = (episode: Episode) => {
  const shas = new Map<string, EvidenceId>();

  for (const event of episode.events) {
    if (event.kind === "git.commit") {
      shas.set(
        event.identity.commitSha ?? event.eventId,
        EvidenceIdSchema.make(event.eventId)
      );
    }
  }

  return [...shas.values()];
};

const episodeResults = (
  snapshot: StoreSnapshot,
  episode: Episode,
  options: EpisodeOptions
): readonly MetricResult[] => {
  const sub: StoreSnapshot = { ...snapshot, events: episode.events };
  const commits = commitsIn(episode);
  const evidence = episode.events.map((e) => EvidenceIdSchema.make(e.eventId));

  const reused = [
    ...computeFlightTime(sub).results,
    ...computeAiUsage(sub).results,
    ...computeCost(sub).results,
  ].flatMap((r) => {
    const relabelled = relabel(episode, r);

    return relabelled === null ? [] : [relabelled];
  });

  const span = `${episode.events.length} event(s); idle gap ${options.idleGapMs / 3_600_000}h`;

  return [
    plain(
      snapshot,
      episode,
      episodeStartDefinition,
      episode.startMs,
      evidence.slice(0, 1),
      span
    ),
    plain(
      snapshot,
      episode,
      episodeEndDefinition,
      episode.endMs,
      evidence.slice(-1),
      span
    ),
    plain(
      snapshot,
      episode,
      episodeCommitsDefinition,
      commits.length,
      commits,
      null
    ),
    plain(
      snapshot,
      episode,
      episodeCurrentDefinition,
      episode.current ? 1 : 0,
      [],
      episode.current
        ? "latest episode touches the last 24h"
        : "not the current episode"
    ),
    ...reused,
  ];
};

export const computeEpisodes = (
  snapshot: StoreSnapshot,
  options: EpisodeOptions = DEFAULT_EPISODE_OPTIONS
): MetricOutput => {
  const asOfMs = Date.parse(snapshot.manifest.createdAt);

  const episodes = splitEpisodes(
    branchEvents(snapshot),
    Number.isNaN(asOfMs) ? 0 : asOfMs,
    options
  );

  return {
    findings: [],
    results: episodes.flatMap((episode) =>
      episodeResults(snapshot, episode, options)
    ),
  };
};

export const episodesDescriptor: ModuleDescriptor = {
  contractVersion: CONTRACT_VERSION,
  fixtureIds: ["episodes/month-apart"],
  gaps: [
    {
      code: "idle-gap-heuristic",
      message:
        "Episodes split at idle gaps over 8 hours by default; a long pause inside one piece of work starts a new episode.",
    },
    {
      code: "branch-from-attribution",
      message:
        "Episodes cover events whose branch is the selected branch; past AI events need the branch-at-time correlation step first.",
    },
  ],
  id: DescriptorIdSchema.make("dx.metric.episodes"),
  kind: "metric",
  owner: "backfill",
  readiness: "degraded",
  requiredInputs: [],
  supportedFields: episodeDefinitions.map((d) => d.id),
  version: EPISODES_METRIC_VERSION,
};

export const makeEpisodesMetric = (options: EpisodeOptions): DxMetric => ({
  compute: (snapshot) => computeEpisodes(snapshot, options),
  definitions: episodeDefinitions,
  descriptor: episodesDescriptor,
});

export const episodesMetric: DxMetric = makeEpisodesMetric(
  DEFAULT_EPISODE_OPTIONS
);
