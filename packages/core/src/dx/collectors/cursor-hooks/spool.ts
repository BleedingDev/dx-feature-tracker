// @effect-diagnostics nodeBuiltinImport:off -- The hook spool is written synchronously by the hook process with a temp-file rename for atomicity and read back by the collector.
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { Option, Schema } from "effect";

import { MAX_PAYLOAD_BYTES } from "../../model/event.js";
import type { SpoolRecord } from "./spool-record.js";
import { SpoolRecordSchema } from "./spool-record.js";

export const HOOK_SPOOL_FOLDER = "cursor-hooks" as const;

export const LEGACY_SPOOL_FOLDER = ".dx-flight-recorder" as const;

export const LEGACY_SPOOL_RELATIVE =
  `${LEGACY_SPOOL_FOLDER}/cursor-hooks-spool` as const;

const SPOOL_SUFFIX = ".json";

const decodeRecordJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(SpoolRecordSchema)
);

export const spoolFileName = (record: SpoolRecord): string =>
  `${Date.parse(record.capturedAt).toString().padStart(15, "0")}-${record.recordHash.slice(0, 24)}${SPOOL_SUFFIX}`;

export const writeSpoolRecord = (
  spoolDir: string,
  record: SpoolRecord
): string | null => {
  const body = JSON.stringify(record);

  if (Buffer.byteLength(body, "utf-8") > MAX_PAYLOAD_BYTES) {
    return null;
  }

  mkdirSync(spoolDir, { mode: 0o700, recursive: true });

  const finalPath = path.join(spoolDir, spoolFileName(record));

  const tempPath = path.join(
    spoolDir,
    `.tmp-${process.pid}-${randomBytes(6).toString("hex")}`
  );

  writeFileSync(tempPath, body, { flag: "wx", mode: 0o600 });
  renameSync(tempPath, finalPath);

  return finalPath;
};

export interface SpoolReadResult {
  readonly records: readonly SpoolRecord[];
  readonly rejected: readonly string[];
  readonly lastFile: string | null;
}

export const spoolExists = (spoolDir: string): boolean => existsSync(spoolDir);

export const readSpool = (
  spoolDir: string,
  afterFile: string | null
): SpoolReadResult => {
  const files = readdirSync(spoolDir)
    .filter((name) => name.endsWith(SPOOL_SUFFIX) && !name.startsWith("."))
    .toSorted()
    .filter((name) => afterFile === null || name > afterFile);

  const records: SpoolRecord[] = [];
  const rejected: string[] = [];

  for (const name of files) {
    const decoded = decodeRecordJson(
      readFileSync(path.join(spoolDir, name), "utf-8")
    );

    if (Option.isSome(decoded)) {
      records.push(decoded.value);
    } else {
      rejected.push(name);
    }
  }

  return { lastFile: files.at(-1) ?? null, records, rejected };
};
