import type { Crypto } from "effect";
import { DateTime, Effect, FileSystem, Option } from "effect";

import { InvalidInput } from "../../contracts/error-invalid-input.js";
import { SourceUnavailable } from "../../contracts/error-source-unavailable.js";
import { UnsupportedSource } from "../../contracts/error-unsupported-source.js";
import type { DxCollector } from "../../contracts/services.js";
import { emptyFlightContext } from "../../model/event.js";
import type { ProbeReceipt } from "../../model/probe.js";
import { cursorUsageExportDescriptor } from "./descriptor.js";
import {
  CURSOR_USAGE_EXPORT_ADAPTER_ID,
  parseCursorUsageCsv,
  UnrecognizedLayout,
} from "./parse.js";

const basename = (path: string): string =>
  path.split(/[\\/]/u).findLast((part) => part !== "") ?? path;

const requirePath = (selectedInput: string | null) =>
  selectedInput === null || selectedInput.trim() === ""
    ? Effect.fail(
        new InvalidInput({
          field: "selectedInput",
          message:
            "cursor-usage-export needs an explicitly selected usage .csv file; nothing is scanned by default",
        })
      )
    : Effect.succeed(selectedInput);

const readSelected = (path: string) =>
  Effect.gen(function* readSelectedFile() {
    const fileSystem = yield* FileSystem.FileSystem;

    return yield* fileSystem.readFileString(path).pipe(
      Effect.mapError(
        (error) =>
          new SourceUnavailable({
            adapterId: CURSOR_USAGE_EXPORT_ADAPTER_ID,
            message: `cannot read selected Cursor usage CSV: ${error.message}`,
          })
      )
    );
  });

const toCollectError = (
  error: UnrecognizedLayout | { readonly message: string }
) =>
  error instanceof UnrecognizedLayout
    ? new UnsupportedSource({
        adapterId: CURSOR_USAGE_EXPORT_ADAPTER_ID,
        message: `not a recognized Cursor usage export: ${error.message}`,
        sourceVersion: null,
      })
    : new SourceUnavailable({
        adapterId: CURSOR_USAGE_EXPORT_ADAPTER_ID,
        message: `cannot hash Cursor usage CSV evidence: ${error.message}`,
      });

export const cursorUsageExportCollector: DxCollector<
  FileSystem.FileSystem | Crypto.Crypto
> = {
  collect: (input) =>
    Effect.gen(function* collectCursorUsageExport() {
      const path = yield* requirePath(input.selectedInput);
      const text = yield* readSelected(path);
      const now = yield* DateTime.now;

      const result = yield* parseCursorUsageCsv(text, {
        context: input.context,
        observedAt: DateTime.formatIso(now),
        origin: input.origin,
        sourceName: basename(path),
      }).pipe(Effect.mapError(toCollectError));

      return {
        coverage: result.coverage,
        cursor: null,
        events: result.events,
      };
    }),
  descriptor: cursorUsageExportDescriptor,
};

export const probeCursorUsageExport = (path: string) =>
  Effect.gen(function* probeCursorUsageExportFile() {
    const probedAt = DateTime.formatIso(yield* DateTime.now);

    const base = {
      adapterId: CURSOR_USAGE_EXPORT_ADAPTER_ID,
      probeId: `probe:${CURSOR_USAGE_EXPORT_ADAPTER_ID}:${basename(path)}`,
      probedAt,
      sourceKind: "usage-csv",
    };

    const text = yield* readSelected(path).pipe(Effect.option);

    if (Option.isNone(text)) {
      return {
        ...base,
        itemCount: null,
        layout: null,
        notes: ["selected file not readable"],
        present: false,
        readable: false,
        version: null,
      } satisfies ProbeReceipt;
    }

    const result = yield* parseCursorUsageCsv(text.value, {
      context: emptyFlightContext,
      observedAt: probedAt,
      origin: "imported",
      sourceName: basename(path),
    }).pipe(Effect.option);

    if (Option.isNone(result)) {
      return {
        ...base,
        itemCount: null,
        layout: null,
        notes: ["header not recognized as a Cursor usage export"],
        present: true,
        readable: true,
        version: null,
      } satisfies ProbeReceipt;
    }

    return {
      ...base,
      itemCount: result.value.events.length,
      layout: result.value.layout,
      notes: [
        `rows=${String(result.value.dataRows)}`,
        `rejected=${String(result.value.rejected.length)}`,
        `coverage=${result.value.coverage.state}`,
      ],
      present: true,
      readable: true,
      version: null,
    } satisfies ProbeReceipt;
  });
