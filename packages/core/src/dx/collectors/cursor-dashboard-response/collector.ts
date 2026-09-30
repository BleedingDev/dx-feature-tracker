import type { Crypto } from "effect";
import { DateTime, Effect, FileSystem } from "effect";

import { InvalidInput } from "../../contracts/error-invalid-input.js";
import { SourceUnavailable } from "../../contracts/error-source-unavailable.js";
import { UnsupportedSource } from "../../contracts/error-unsupported-source.js";
import type { DxCollector } from "../../contracts/services.js";
import { cursorDashboardResponseDescriptor } from "./descriptor.js";
import {
  CURSOR_DASHBOARD_RESPONSE_ADAPTER_ID,
  parseCursorDashboardResponse,
  RefusedInput,
} from "./parse.js";

const basename = (path: string): string =>
  path.split(/[\\/]/u).findLast((part) => part !== "") ?? path;

const requirePath = (selectedInput: string | null) =>
  selectedInput === null || selectedInput.trim() === ""
    ? Effect.fail(
        new InvalidInput({
          field: "selectedInput",
          message:
            "cursor-dashboard-response needs an explicitly selected response JSON file; nothing is scanned or fetched",
        })
      )
    : Effect.succeed(selectedInput);

const toCollectError = (error: RefusedInput | { readonly message: string }) =>
  error instanceof RefusedInput
    ? new UnsupportedSource({
        adapterId: CURSOR_DASHBOARD_RESPONSE_ADAPTER_ID,
        message: `${error.reason}: ${error.message}`,
        sourceVersion: null,
      })
    : new SourceUnavailable({
        adapterId: CURSOR_DASHBOARD_RESPONSE_ADAPTER_ID,
        message: `cannot hash dashboard response evidence: ${error.message}`,
      });

export const cursorDashboardResponseCollector: DxCollector<
  FileSystem.FileSystem | Crypto.Crypto
> = {
  collect: (input) =>
    Effect.gen(function* collectCursorDashboardResponse() {
      const path = yield* requirePath(input.selectedInput);
      const fileSystem = yield* FileSystem.FileSystem;

      const text = yield* fileSystem.readFileString(path).pipe(
        Effect.mapError(
          (error) =>
            new SourceUnavailable({
              adapterId: CURSOR_DASHBOARD_RESPONSE_ADAPTER_ID,
              message: `cannot read selected dashboard response: ${error.message}`,
            })
        )
      );

      const now = yield* DateTime.now;

      const result = yield* parseCursorDashboardResponse(text, {
        context: input.context,
        observedAt: DateTime.formatIso(now),
        origin: input.origin,
        sourceName: basename(path),
      }).pipe(Effect.mapError(toCollectError));

      return { coverage: result.coverage, cursor: null, events: result.events };
    }),
  descriptor: cursorDashboardResponseDescriptor,
};
