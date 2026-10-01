// @effect-diagnostics nodeBuiltinImport:off -- Hook processes must answer in milliseconds, so the observation spool is appended and read with synchronous node:fs calls at the process boundary.
import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import path from "node:path";

import { Option, Schema } from "effect";

import type { Origin } from "../model/common.js";
import { EVENT_SCHEMA_VERSION, emptyEventIdentity } from "../model/event.js";
import type { DxEventEnvelope, EventBatch } from "../model/event.js";
import { EventIdSchema } from "../model/ids.js";
import type { HarnessScope, SessionRef } from "./contract.js";
import type {
  HookDecoder,
  HookGit,
  HookObservation,
} from "./hook-observation.js";
import {
  HOOK_OBSERVATION_SCHEMA,
  HookObservationSchema,
  noHookFields,
} from "./hook-observation.js";
import type { Channel, HarnessId } from "./ids.js";
import { harnessAdapterId } from "./pending.js";
import { normalizeModel, providerFor, viaFor } from "./provider.js";

export const HOOK_SPOOL_ROOT = "hooks" as const;

export const hookSpoolDir = (dftHome: string, tool: HarnessId): string =>
  path.join(dftHome, HOOK_SPOOL_ROOT, tool);

export const hookSpoolFile = (
  dftHome: string,
  tool: HarnessId,
  observedAt: string
): string =>
  path.join(hookSpoolDir(dftHome, tool), `${observedAt.slice(0, 10)}.jsonl`);

export interface HookRun {
  readonly cwd: string;
  readonly decoder: HookDecoder;
  readonly dftHome: string;
  readonly event: string;
  readonly now: Date;
  readonly resolveGit: (cwd: string) => HookGit;
  readonly stdinText: string;
  readonly tool: HarnessId;
}

export type HookRunOutcome =
  | { readonly path: string; readonly state: "recorded" }
  | { readonly reason: string; readonly state: "skipped" };

export interface HookRunResult {
  readonly outcome: HookRunOutcome;
  readonly stdout: string;
}

export const observeHook = (run: HookRun): HookObservation => {
  const decoded = run.decoder.decode(run.stdinText, run.event);
  const fields = decoded ?? noHookFields;

  return {
    event: run.event,
    fields,
    git: run.resolveGit(fields.cwd ?? run.cwd),
    observedAt: run.now.toISOString(),
    payloadValid: decoded !== null,
    schema: HOOK_OBSERVATION_SCHEMA,
    tool: run.tool,
  };
};

export const recordHook = (run: HookRun): HookRunResult => {
  const stdout = run.decoder.respond(run.event);

  try {
    const observation = observeHook(run);

    const file = hookSpoolFile(run.dftHome, run.tool, observation.observedAt);

    mkdirSync(path.dirname(file), { mode: 0o700, recursive: true });
    appendFileSync(file, `${JSON.stringify(observation)}\n`, {
      flag: "a",
      mode: 0o600,
    });

    return { outcome: { path: file, state: "recorded" }, stdout };
  } catch (error) {
    return {
      outcome: {
        reason: error instanceof Error ? error.message : "hook spool failed",
        state: "skipped",
      },
      stdout,
    };
  }
};

const decodeLine = Schema.decodeUnknownOption(
  Schema.fromJsonString(HookObservationSchema)
);

const spoolFiles = (dir: string): readonly string[] => {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".jsonl"))
      .toSorted();
  } catch {
    return [];
  }
};

const observationsIn = (file: string): readonly HookObservation[] => {
  try {
    return readFileSync(file, "utf-8")
      .split("\n")
      .flatMap((line) =>
        line.trim() === "" ? [] : Option.toArray(decodeLine(line))
      );
  } catch {
    return [];
  }
};

export const readHookObservations = (
  dftHome: string,
  tool: HarnessId
): readonly HookObservation[] => {
  const dir = hookSpoolDir(dftHome, tool);

  return spoolFiles(dir).flatMap((name) =>
    observationsIn(path.join(dir, name))
  );
};

const dayOf = (iso: string): string => iso.slice(0, 10);

interface FileStamp {
  readonly mtimeMs: number | null;
  readonly size: number | null;
}

const stampOf = (file: string): FileStamp => {
  try {
    const stats = statSync(file);

    return { mtimeMs: stats.mtimeMs, size: stats.size };
  } catch {
    return { mtimeMs: null, size: null };
  }
};

export const hookSpoolRefs = (
  scope: HarnessScope,
  tool: HarnessId,
  channel: Channel = "hooks"
): readonly SessionRef[] => {
  if (scope.dftHome === null) {
    return [];
  }

  const dir = hookSpoolDir(scope.dftHome, tool);
  const since = scope.since === null ? null : dayOf(scope.since);

  const worktrees: readonly (string | null)[] =
    scope.worktrees.length === 0 ? [null] : scope.worktrees;

  return spoolFiles(dir)
    .filter((name) => since === null || dayOf(name) >= since)
    .flatMap((name) => {
      const file = path.join(dir, name);
      const stamp = stampOf(file);

      return worktrees.map((worktree): SessionRef => ({
        channel,
        harness: tool,
        id: worktree === null ? file : `${file}#${worktree}`,
        mtimeMs: stamp.mtimeMs,
        path: file,
        sessionId: null,
        size: stamp.size,
        source: harnessAdapterId(tool),
        worktree,
      }));
    });
};

const trimmed = (dir: string): string => dir.replace(/\/+$/u, "");

const inside = (child: string | null, parent: string): boolean =>
  child !== null &&
  (trimmed(child) === trimmed(parent) ||
    trimmed(child).startsWith(`${trimmed(parent)}/`));

const belongsTo = (
  observation: HookObservation,
  worktree: string | null
): boolean =>
  worktree === null ||
  inside(observation.git.worktreePath, worktree) ||
  (observation.git.worktreePath === null &&
    inside(observation.fields.cwd, worktree));

const sha256Hex = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

export interface HookEventOptions {
  readonly channel: Channel;
  readonly kind: DxEventEnvelope["kind"];
  readonly origin: Origin;
}

export const hookObservationEvent = (
  observation: HookObservation,
  options: HookEventOptions
): DxEventEnvelope => {
  const { fields, git, tool } = observation;
  const adapterId = harnessAdapterId(tool);
  const upstreamKey = `${fields.sessionId ?? "-"}:${observation.event}:${observation.observedAt}`;

  return {
    acquisition: "hook",
    adapterId,
    adapterVersion: HOOK_OBSERVATION_SCHEMA,
    ai: {
      agentId: fields.agentId,
      agentType: fields.agentType,
      branchSource: git.branch === null ? "unassigned" : "hook",
      channel: options.channel,
      cwd: fields.cwd,
      effort: fields.effort,
      effortSource: fields.effort === null ? null : "harness-recorded",
      harness: tool,
      harnessVersion: null,
      model: normalizeModel(fields.model),
      modelRaw: fields.model,
      parentSessionId: fields.parentSessionId,
      provider: providerFor(fields.model, null),
      sessionId: fields.sessionId,
      via: viaFor(fields.model, null),
    },
    context: {
      branch: git.branch,
      flightId: null,
      headSha: git.headSha,
      repoCommonDir: git.repoCommonDir,
      worktreePath: git.worktreePath,
    },
    eventId: EventIdSchema.make(
      `sha256:${sha256Hex(`${adapterId}\n${JSON.stringify(observation)}`)}`
    ),
    evidence: { bounded: true, hash: null, ref: `${adapterId}:${upstreamKey}` },
    fieldSemantics: [],
    identity: {
      ...emptyEventIdentity,
      sessionId: fields.sessionId,
      turnId: fields.turnId,
    },
    kind: options.kind,
    observedAt: observation.observedAt,
    occurredAt: observation.observedAt,
    occurredAtPrecision: "exact",
    origin: options.origin,
    payload: {
      hookEvent: observation.event,
      payloadValid: observation.payloadValid,
    },
    schemaVersion: EVENT_SCHEMA_VERSION,
    sourceVersion: null,
    upstreamKey,
    usage: null,
  };
};

export const readHookSpool = (
  ref: SessionRef,
  decoder: HookDecoder,
  origin: Origin
): EventBatch => {
  const events = observationsIn(ref.path)
    .filter(
      (observation) =>
        observation.tool === ref.harness && belongsTo(observation, ref.worktree)
    )
    .map((observation) =>
      hookObservationEvent(observation, {
        channel: ref.channel,
        kind: decoder.kind(observation.event),
        origin,
      })
    );

  return {
    coverage: {
      adapterId: harnessAdapterId(ref.harness),
      expectedItems: null,
      gaps: [],
      observedItems: events.length,
      state: "complete",
      watermark: null,
      windowFrom: null,
      windowTo: null,
    },
    cursor: null,
    events,
  };
};
