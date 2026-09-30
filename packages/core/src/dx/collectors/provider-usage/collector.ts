import { DateTime, Effect, FileSystem, Result } from "effect";

import { InvalidInput } from "../../contracts/error-invalid-input.js";
import { SourceUnavailable } from "../../contracts/error-source-unavailable.js";
import { UnsupportedSource } from "../../contracts/error-unsupported-source.js";
import type { CollectInput, DxCollector } from "../../contracts/services.js";
import {
  PROVIDER_USAGE_ADAPTER_ID,
  providerUsageDescriptor,
} from "./descriptor.js";
import { parseProviderUsage } from "./parse.js";

const MAX_FILE_BYTES = 16 * 1024 * 1024;

const baseName = (filePath: string): string =>
  filePath.split(/[\\/]/u).findLast((part) => part !== "") ?? "input";

const collect = Effect.fn("providerUsage.collect")(function* collect(
  input: CollectInput
) {
  const selected = input.selectedInput;

  if (selected === null || selected.trim() === "") {
    return yield* new InvalidInput({
      field: "input",
      message:
        "provider-usage imports only an explicitly supplied file; pass --input <path>",
    });
  }

  const fs = yield* FileSystem.FileSystem;

  const unavailable = new SourceUnavailable({
    adapterId: PROVIDER_USAGE_ADAPTER_ID,
    message: "Selected provider usage file is missing or unreadable",
  });

  const info = yield* fs
    .stat(selected)
    .pipe(Effect.mapError(() => unavailable));

  if (info.type !== "File") {
    return yield* unavailable;
  }

  if (Number(info.size) > MAX_FILE_BYTES) {
    return yield* new InvalidInput({
      field: "input",
      message: "Provider usage file exceeds the 16 MiB import bound",
    });
  }

  const content = yield* fs
    .readFileString(selected)
    .pipe(Effect.mapError(() => unavailable));

  const now = yield* DateTime.now;

  const outcome = parseProviderUsage(content, {
    context: input.context,
    fileLabel: baseName(selected),
    observedAt: DateTime.formatIso(now),
    origin: input.origin,
  });

  if (Result.isFailure(outcome)) {
    return yield* new UnsupportedSource({
      adapterId: PROVIDER_USAGE_ADAPTER_ID,
      message: outcome.failure,
      sourceVersion: null,
    });
  }

  return outcome.success;
});

export const providerUsageCollector: DxCollector<FileSystem.FileSystem> = {
  collect,
  descriptor: providerUsageDescriptor,
};
