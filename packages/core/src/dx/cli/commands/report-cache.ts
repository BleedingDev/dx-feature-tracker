// @effect-diagnostics-next-line nodeBuiltinImport:off -- The cached analyze report is a plain JSON file written next to the selected store.
import * as fs from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Report cache paths are derived from the resolved store path.
import path from "node:path";

import { Effect, Option, Schema } from "effect";

import { StoreError } from "../../contracts/error-store-error.js";
import type { AnalyzeReport } from "../../model/report.js";

export const REPORT_CACHE_DIR = "reports" as const;

export const LATEST_REPORT_POINTER = "latest.json" as const;

export const reportCacheDirFor = (storePath: string): string =>
  path.join(path.dirname(storePath), REPORT_CACHE_DIR);

const safeName = (snapshotId: string): string =>
  snapshotId.replaceAll(/[^A-Za-z0-9._-]/gu, "_");

export const reportPathFor = (storePath: string, snapshotId: string): string =>
  path.join(
    reportCacheDirFor(storePath),
    `${safeName(snapshotId)}.analyze.json`
  );

const cacheFailure = (operation: string, cause: unknown): StoreError =>
  new StoreError({
    message: cause instanceof Error ? cause.message : String(cause),
    operation,
  });

export interface CachedReportPointer {
  readonly reportPath: string;
  readonly snapshotId: string;
  readonly writtenAt: string;
}

export const writeCachedReport = (
  storePath: string,
  report: AnalyzeReport,
  writtenAt: string
): Effect.Effect<string, StoreError> =>
  Effect.try({
    catch: (cause) => cacheFailure("report-cache.write", cause),
    try: () => {
      const dir = reportCacheDirFor(storePath);
      fs.mkdirSync(dir, { recursive: true });
      const target = reportPathFor(storePath, report.snapshot.snapshotId);
      const temporary = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`);
      fs.renameSync(temporary, target);

      const pointer: CachedReportPointer = {
        reportPath: target,
        snapshotId: report.snapshot.snapshotId,
        writtenAt,
      };

      const pointerPath = path.join(dir, LATEST_REPORT_POINTER);
      const pointerTemp = `${pointerPath}.${process.pid}.tmp`;
      fs.writeFileSync(pointerTemp, `${JSON.stringify(pointer, null, 2)}\n`);
      fs.renameSync(pointerTemp, pointerPath);

      return target;
    },
  });

const decodePointer = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      reportPath: Schema.String,
      snapshotId: Schema.String,
      writtenAt: Schema.String,
    })
  )
);

export const readLatestReportPointer = (
  storePath: string
): Effect.Effect<CachedReportPointer | null> =>
  Effect.sync(() => {
    const pointerPath = path.join(
      reportCacheDirFor(storePath),
      LATEST_REPORT_POINTER
    );

    if (!fs.existsSync(pointerPath)) {
      return null;
    }

    const pointer = decodePointer(fs.readFileSync(pointerPath, "utf-8"));

    return Option.isSome(pointer) && fs.existsSync(pointer.value.reportPath)
      ? pointer.value
      : null;
  });
