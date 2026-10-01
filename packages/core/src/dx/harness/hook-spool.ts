// @effect-diagnostics nodeBuiltinImport:off -- Hook processes must answer in milliseconds, so the observation spool is appended and read with synchronous node:fs calls at the process boundary.
import { appendFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { Option, Schema } from "effect";

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
import type { HarnessId } from "./ids.js";

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

export const readHookObservations = (
  dftHome: string,
  tool: HarnessId
): readonly HookObservation[] => {
  const dir = hookSpoolDir(dftHome, tool);

  return spoolFiles(dir).flatMap((name) =>
    readFileSync(path.join(dir, name), "utf-8")
      .split("\n")
      .flatMap((line) =>
        line.trim() === "" ? [] : Option.toArray(decodeLine(line))
      )
  );
};
