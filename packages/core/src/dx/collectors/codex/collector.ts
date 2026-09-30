import { DateTime, Effect, FileSystem } from "effect";

import { InvalidInput } from "../../contracts/error-invalid-input.js";
import { SourceUnavailable } from "../../contracts/error-source-unavailable.js";
import type { CollectInput, DxCollector } from "../../contracts/services.js";
import { CONTRACT_VERSION } from "../../contracts/version.js";
import type { ModuleDescriptor } from "../../model/descriptor.js";
import { DescriptorIdSchema } from "../../model/ids.js";
import {
  CODEX_ADAPTER_ID,
  CODEX_ADAPTER_VERSION,
  parseCodexSession,
} from "./parse.js";

export const codexSessionDescriptor: ModuleDescriptor = {
  contractVersion: CONTRACT_VERSION,
  fixtureIds: ["b12-codex-rollout-v2", "b12-codex-rollout-legacy"],
  gaps: [
    {
      code: "cost-unavailable",
      message:
        "Codex rollouts report tokens only; charge and list price stay unavailable.",
    },
    {
      code: "branch-allocation-provisional",
      message:
        "Codex records no branch per turn; usage is allocated by working directory and is at most provisional.",
    },
    {
      code: "explicit-file-only",
      message:
        "Imports one explicitly selected rollout .jsonl; never scans ~/.codex/sessions.",
    },
  ],
  id: DescriptorIdSchema.make("collector/codex-session"),
  kind: "collector",
  owner: "B12",
  readiness: "degraded",
  requiredInputs: ["codex rollout .jsonl path (--input)"],
  supportedFields: [
    "ai.session.sessionId",
    "ai.session.cliVersion",
    "ai.session.branchAtStart",
    "ai.turn.model",
    "ai.turn.durationMs",
    "ai.turn.status",
    "ai.turn.toolCalls",
    "ai.turn.toolNames",
    "ai.usage.tokens.input",
    "ai.usage.tokens.cachedInput",
    "ai.usage.tokens.cacheWrite",
    "ai.usage.tokens.output",
    "ai.usage.tokens.reasoning",
    "ai.usage.tokens.total",
    "ai.usage.requestKey",
    "allocation",
  ],
  version: CODEX_ADAPTER_VERSION,
};

const baseName = (path: string): string => path.split("/").at(-1) ?? path;

const collect = Effect.fn("CodexSessionCollector.collect")(function* collect(
  input: CollectInput
) {
  const path = input.selectedInput;

  if (path === null || path === "") {
    return yield* new InvalidInput({
      field: "input",
      message: "Select one Codex rollout .jsonl file with --input.",
    });
  }

  if (!path.endsWith(".jsonl")) {
    return yield* new InvalidInput({
      field: "input",
      message: "Codex input must be a rollout .jsonl file.",
    });
  }

  const fileSystem = yield* FileSystem.FileSystem;

  const text = yield* fileSystem.readFileString(path).pipe(
    Effect.mapError(
      (error) =>
        new SourceUnavailable({
          adapterId: CODEX_ADAPTER_ID,
          message: `Cannot read the selected Codex rollout: ${error.reason._tag}`,
        })
    )
  );

  const result = parseCodexSession(text, {
    context: input.context,
    evidenceName: baseName(path),
    observedAt: DateTime.formatIso(yield* DateTime.now),
    origin: input.origin,
  });

  if (result.recognizedLines === 0) {
    return yield* new InvalidInput({
      field: "input",
      message:
        "The selected file contains no recognizable Codex rollout records.",
    });
  }

  return result.batch;
});

export const codexSessionCollector: DxCollector<FileSystem.FileSystem> = {
  collect,
  descriptor: codexSessionDescriptor,
};
