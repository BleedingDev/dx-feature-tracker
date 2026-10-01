// @effect-diagnostics-next-line nodeBuiltinImport:off -- Spool file names carry a random suffix so concurrent hook processes never collide.
import { randomUUID } from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Hook processes spool batches with atomic rename; drain moves files between spool folders.
import * as fs from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Spool paths are joined under the selected spool directory.
import path from "node:path";

import { DateTime, Effect, Exit, Schema } from "effect";

import { StoreError } from "../contracts/error-store-error.js";
import type { EventStoreService, StoreFailure } from "../contracts/services.js";
import type { EventBatch } from "../model/event.js";
import { ensurePrivateDir, writePrivateFile } from "./private-files.js";
import { StoredBatchSchema, toCurrentBatch } from "./upgrade-v1.js";

export interface SpoolDrainResult {
  readonly duplicates: number;
  readonly files: number;
  readonly inserted: number;
  readonly rejected: readonly string[];
}

const decodeBatch = Schema.decodeUnknownExit(
  Schema.fromJsonString(StoredBatchSchema)
);

const PENDING_SUFFIX = ".batch.json";

const spoolFailure = (operation: string, cause: unknown): StoreError =>
  new StoreError({
    message: cause instanceof Error ? cause.message : String(cause),
    operation,
  });

export const writeSpoolBatch = (
  spoolDir: string,
  batch: EventBatch
): Effect.Effect<string, StoreError> =>
  DateTime.now.pipe(
    Effect.flatMap((now) =>
      Effect.try({
        catch: (cause) => spoolFailure("spool.write", cause),
        try: () => {
          ensurePrivateDir(spoolDir);
          const name = `${DateTime.formatIso(now).replaceAll(":", "-")}-${randomUUID()}${PENDING_SUFFIX}`;
          const temporary = path.join(spoolDir, `.${name}.tmp`);
          const target = path.join(spoolDir, name);

          writePrivateFile(temporary, JSON.stringify(batch), "wx");
          fs.renameSync(temporary, target);

          return target;
        },
      })
    )
  );

const pendingFiles = (spoolDir: string): readonly string[] => {
  try {
    return fs
      .readdirSync(spoolDir)
      .filter((name) => name.endsWith(PENDING_SUFFIX))
      .toSorted();
  } catch {
    return [];
  }
};

const moveTo = (spoolDir: string, folder: string, name: string): void => {
  ensurePrivateDir(path.join(spoolDir, folder));
  fs.renameSync(path.join(spoolDir, name), path.join(spoolDir, folder, name));
};

export const drainSpool = (
  store: EventStoreService,
  spoolDir: string
): Effect.Effect<SpoolDrainResult, StoreFailure> =>
  Effect.gen(function* drainSpoolFiles() {
    const names = pendingFiles(spoolDir);
    let inserted = 0;
    let duplicates = 0;
    const rejected: string[] = [];

    for (const name of names) {
      const text = yield* Effect.try({
        catch: (cause) => spoolFailure("spool.read", cause),
        try: () => fs.readFileSync(path.join(spoolDir, name), "utf-8"),
      });

      const decoded = decodeBatch(text);

      if (Exit.isFailure(decoded)) {
        rejected.push(name);
        yield* Effect.try({
          catch: (cause) => spoolFailure("spool.reject", cause),
          try: () => {
            moveTo(spoolDir, "rejected", name);
          },
        });
      } else {
        const result = yield* store.append(toCurrentBatch(decoded.value));
        inserted += result.inserted;
        duplicates += result.duplicates;
        yield* Effect.try({
          catch: (cause) => spoolFailure("spool.done", cause),
          try: () => {
            moveTo(spoolDir, "done", name);
          },
        });
      }
    }

    return { duplicates, files: names.length, inserted, rejected };
  });
