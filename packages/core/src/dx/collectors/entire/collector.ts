import { DateTime, Effect, FileSystem } from "effect";

import { InvalidInput } from "../../contracts/error-invalid-input.js";
import { SourceUnavailable } from "../../contracts/error-source-unavailable.js";
import type { CollectInput, DxCollector } from "../../contracts/services.js";
import { CONTRACT_VERSION } from "../../contracts/version.js";
import type { ModuleDescriptor } from "../../model/descriptor.js";
import { DescriptorIdSchema } from "../../model/ids.js";
import {
  ENTIRE_ADAPTER_ID,
  ENTIRE_ADAPTER_VERSION,
  parseEntireCheckpoints,
} from "./parse.js";
import type { EntireInputFile } from "./parse.js";

const MAX_FILES = 2000;

export const entireCheckpointsDescriptor: ModuleDescriptor = {
  contractVersion: CONTRACT_VERSION,
  fixtureIds: ["b46-entire-delta-windows", "b46-entire-cumulative-unverified"],
  gaps: [
    {
      code: "source-absent-on-host",
      message:
        "No entire binary, ~/.entire or entire/* branch on the build host; verified against fixtures only.",
    },
    {
      code: "layout-unverified",
      message:
        "Checkpoint layout follows the documented entire/checkpoints/v1 shape; not checked against a live Entire release.",
    },
    {
      code: "cost-unavailable",
      message:
        "Entire checkpoints report tokens only; charge and list price stay unavailable.",
    },
    {
      code: "attribution-source-heuristic",
      message:
        "Branch and line attribution are Entire's heuristic; allocation is provisional.",
    },
    {
      code: "explicit-directory-only",
      message:
        "Imports one operator-extracted checkpoint directory; never initializes Entire, reads refs, or pushes.",
    },
  ],
  id: DescriptorIdSchema.make("collector/entire-checkpoints"),
  kind: "collector",
  owner: "B46",
  readiness: "degraded",
  requiredInputs: [
    "directory extracted from the entire/checkpoints/v1 branch (--input)",
  ],
  supportedFields: [
    "checkpoint.id",
    "checkpoint.rootTokenUsage (alternative ledger, not summed)",
    "ai.session.sessionId",
    "ai.session.agent",
    "ai.session.model",
    "ai.turn.transcriptWindow.toolCalls",
    "ai.turn.transcriptWindow.toolNames",
    "ai.usage.tokens.input",
    "ai.usage.tokens.cachedInput",
    "ai.usage.tokens.cacheWrite",
    "ai.usage.tokens.output",
    "ai.usage.apiCallCount",
    "ai.usage.subagentTokens",
    "ai.usage.requestKey",
    "ai.usage.attribution (provisional)",
    "allocation",
  ],
  version: ENTIRE_ADAPTER_VERSION,
};

const baseName = (path: string): string =>
  path.replace(/\/+$/u, "").split("/").at(-1) ?? path;

const isRelevant = (relPath: string): boolean =>
  relPath.endsWith("metadata.json") || relPath.endsWith("full.jsonl");

const unavailable = (reason: string) =>
  new SourceUnavailable({
    adapterId: ENTIRE_ADAPTER_ID,
    message: `Cannot read the selected Entire checkpoint directory: ${reason}`,
  });

const collect = Effect.fn("EntireCheckpointsCollector.collect")(
  function* collect(input: CollectInput) {
    const root = input.selectedInput;

    if (root === null || root === "") {
      return yield* new InvalidInput({
        field: "input",
        message:
          "Select one directory extracted from the entire/checkpoints/v1 branch with --input.",
      });
    }

    const fileSystem = yield* FileSystem.FileSystem;

    const entries = yield* fileSystem
      .readDirectory(root, { recursive: true })
      .pipe(Effect.mapError((error) => unavailable(error.reason._tag)));

    const relevant = entries
      .map((entry) => entry.split("\\").join("/"))
      .filter(isRelevant)
      .toSorted();

    if (relevant.length > MAX_FILES) {
      return yield* new InvalidInput({
        field: "input",
        message: `The selected directory holds more than ${String(MAX_FILES)} checkpoint files; select a narrower extract.`,
      });
    }

    const files: EntireInputFile[] = [];

    for (const relPath of relevant) {
      const text = yield* fileSystem
        .readFileString(`${root.replace(/\/+$/u, "")}/${relPath}`)
        .pipe(Effect.mapError((error) => unavailable(error.reason._tag)));

      files.push({ relPath, text });
    }

    const now = yield* DateTime.now;

    const result = parseEntireCheckpoints(files, {
      context: input.context,
      evidenceName: baseName(root),
      observedAt: DateTime.formatIso(now),
      origin: input.origin,
    });

    if (result.recognizedFiles === 0) {
      return yield* new InvalidInput({
        field: "input",
        message:
          "The selected directory contains no recognizable Entire checkpoint metadata.",
      });
    }

    return result.batch;
  }
);

export const entireCheckpointsCollector: DxCollector<FileSystem.FileSystem> = {
  collect,
  descriptor: entireCheckpointsDescriptor,
};
