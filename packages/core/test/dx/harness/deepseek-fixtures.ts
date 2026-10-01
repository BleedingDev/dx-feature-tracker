// @effect-diagnostics nodeBuiltinImport:off -- DeepSeek fixtures are compressed with node:zlib and written into an owned temp DSH_HOME, like the tool does.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";

import { Layer, Option } from "effect";

import {
  decodeHeaderLine,
  projectKey,
} from "../../../src/dx/harness/deepseek/format.js";
import { DeepseekHarness } from "../../../src/dx/harness/deepseek/harness.js";
import { DeepseekStore } from "../../../src/dx/harness/deepseek/store.js";
import type { MemoryFile } from "../../../src/dx/harness/file-store.js";

export const FIXTURE_DIR = path.join(
  import.meta.dirname,
  "..",
  "fixtures",
  "harness",
  "deepseek"
);

export const FIXTURE_CWD = {
  norepo: "/home/user/work/norepo",
  repo: "/home/user/work/repo",
  worktree: "/home/user/work/wt-two",
} as const;

export const FIXTURES = [
  "main",
  "resume-branch-switch",
  "worktree",
  "orchestrator",
  "subagent",
  "non-repo",
  "errors-model-change",
  "fork",
] as const;

export type FixtureName = (typeof FIXTURES)[number];

export interface FixtureSession {
  readonly cwd: string;
  readonly id: string;
  readonly lines: readonly string[];
}

const encoder = new TextEncoder();

const identityOf = (line: string) => {
  const header = Option.getOrThrow(decodeHeaderLine(line));

  return { cwd: header.cwd ?? "", id: header.id };
};

export const fixtureSession = (name: FixtureName): FixtureSession => {
  const lines = readFileSync(path.join(FIXTURE_DIR, `${name}.jsonl`), "utf-8")
    .split("\n")
    .filter((line) => line.trim() !== "");

  return { ...identityOf(lines[0] ?? "{}"), lines };
};

const TURN_START = '"type":"turn/start"';

export const batchesOf = (lines: readonly string[]): readonly string[][] => {
  const [header = "", ...rows] = lines;
  const batches: string[][] = [[header]];
  let current: string[] = [];

  for (const row of rows) {
    if (row.includes(TURN_START) && current.length > 0) {
      batches.push(current);
      current = [];
    }

    current.push(row);
  }

  if (current.length > 0) {
    batches.push(current);
  }

  return batches;
};

export const zstdLog = (
  batches: readonly (readonly string[])[]
): Uint8Array => {
  const frames = batches.map((batch) =>
    zstdCompressSync(encoder.encode(`${batch.join("\n")}\n`))
  );

  const total = frames.reduce((size, frame) => size + frame.byteLength, 0);
  const bytes = new Uint8Array(total);
  let at = 0;

  for (const frame of frames) {
    bytes.set(frame, at);
    at += frame.byteLength;
  }

  return bytes;
};

export const rawLog = (lines: readonly string[]): Uint8Array =>
  encoder.encode(`${lines.join("\n")}\n`);

export const sessionFilePath = (
  sessionsRoot: string,
  session: Pick<FixtureSession, "cwd" | "id">,
  file = "session.v4.jsonl.zstd"
): string => path.join(sessionsRoot, projectKey(session.cwd), session.id, file);

export const writeFixtureHome = (
  dshHome: string,
  names: readonly FixtureName[]
): readonly string[] =>
  names.map((name) => {
    const session = fixtureSession(name);
    const file = sessionFilePath(path.join(dshHome, "sessions"), session);

    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, zstdLog(batchesOf(session.lines)));

    return file;
  });

export const SESSIONS_ROOT = "/dsh/sessions";

export const memoryFile = (
  session: Pick<FixtureSession, "cwd" | "id">,
  bytes: Uint8Array,
  file = "session.v4.jsonl.zstd",
  mtimeMs = 1
): MemoryFile => ({
  bytes,
  mtimeMs,
  path: sessionFilePath(SESSIONS_ROOT, session, file),
});

export const memoryHarness = (files: readonly MemoryFile[]) =>
  Layer.fresh(DeepseekHarness.layer).pipe(
    Layer.provide(DeepseekStore.memory({ files, roots: [SESSIONS_ROOT] }))
  );
