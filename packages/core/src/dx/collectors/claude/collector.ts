import type { Crypto } from "effect";
import { DateTime, Effect, FileSystem, Option } from "effect";

import { InvalidInput } from "../../contracts/error-invalid-input.js";
import { SourceUnavailable } from "../../contracts/error-source-unavailable.js";
import type { DxCollector } from "../../contracts/services.js";
import { CONTRACT_VERSION } from "../../contracts/version.js";
import type { ModuleDescriptor } from "../../model/descriptor.js";
import { DescriptorIdSchema } from "../../model/ids.js";
import type { ProbeReceipt } from "../../model/probe.js";
import {
  CLAUDE_JSONL_ADAPTER_ID,
  CLAUDE_JSONL_ADAPTER_VERSION,
  parseClaudeJsonl,
} from "./parse.js";

export const CLAUDE_JSONL_FIXTURE_IDS = [
  "b11-claude-session",
  "b11-claude-degraded",
] as const;

export const claudeJsonlDescriptor: ModuleDescriptor = {
  contractVersion: CONTRACT_VERSION,
  fixtureIds: [...CLAUDE_JSONL_FIXTURE_IDS],
  gaps: [
    {
      code: "format-undocumented",
      message:
        "Claude Code session JSONL is an undocumented local format; verified against redacted fixtures only, not a live host file",
    },
    {
      code: "charge-unavailable",
      message:
        "No billed charge in the source; money requires a separate billing import",
    },
    {
      code: "explicit-file-only",
      message:
        "Imports only one explicitly selected .jsonl file; never scans ~/.claude or other directories",
    },
    {
      code: "no-incremental-cursor",
      message:
        "Each collect re-reads the whole file; the store deduplicates by deterministic eventId",
    },
  ],
  id: DescriptorIdSchema.make("collector.claude-jsonl"),
  kind: "collector",
  owner: "B11",
  readiness: "degraded",
  requiredInputs: ["selectedInput: path to one Claude Code session .jsonl"],
  supportedFields: [
    "identity.sessionId",
    "identity.requestId",
    "identity.generationId",
    "context.branch",
    "occurredAt",
    "payload.model",
    "payload.tokens.input",
    "payload.tokens.cached-input",
    "payload.tokens.cache-write",
    "payload.tokens.output",
    "payload.toolCalls",
    "payload.toolNames",
    "payload.listPriceEstimateUsd",
  ],
  version: CLAUDE_JSONL_ADAPTER_VERSION,
};

const basename = (path: string): string =>
  path.split(/[\\/]/u).findLast((part) => part !== "") ?? path;

const hashFailure = (error: { readonly message: string }) =>
  new SourceUnavailable({
    adapterId: CLAUDE_JSONL_ADAPTER_ID,
    message: `cannot hash Claude JSONL evidence: ${error.message}`,
  });

const requirePath = (selectedInput: string | null) =>
  selectedInput === null || selectedInput.trim() === ""
    ? Effect.fail(
        new InvalidInput({
          field: "selectedInput",
          message:
            "claude-jsonl needs an explicitly selected .jsonl file; nothing is scanned by default",
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
            adapterId: CLAUDE_JSONL_ADAPTER_ID,
            message: `cannot read selected Claude JSONL: ${error.message}`,
          })
      )
    );
  });

export const claudeJsonlCollector: DxCollector<
  FileSystem.FileSystem | Crypto.Crypto
> = {
  collect: (input) =>
    Effect.gen(function* collectClaudeJsonl() {
      const path = yield* requirePath(input.selectedInput);
      const text = yield* readSelected(path);
      const now = yield* DateTime.now;

      const result = yield* parseClaudeJsonl(text, {
        context: input.context,
        observedAt: DateTime.formatIso(now),
        origin: input.origin,
        sourceName: basename(path),
      }).pipe(Effect.mapError(hashFailure));

      return {
        coverage: result.coverage,
        cursor: null,
        events: result.events,
      };
    }),
  descriptor: claudeJsonlDescriptor,
};

export const probeClaudeJsonl = (path: string) =>
  Effect.gen(function* probeClaudeJsonlFile() {
    const probedAt = DateTime.formatIso(yield* DateTime.now);

    const base = {
      adapterId: CLAUDE_JSONL_ADAPTER_ID,
      probeId: `probe:${CLAUDE_JSONL_ADAPTER_ID}:${basename(path)}`,
      probedAt,
      sourceKind: "claude-jsonl",
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

    const result = yield* parseClaudeJsonl(text.value, {
      context: {
        branch: null,
        flightId: null,
        headSha: null,
        repoCommonDir: null,
        worktreePath: null,
      },
      observedAt: probedAt,
      origin: "imported",
      sourceName: basename(path),
    }).pipe(Effect.mapError(hashFailure));

    return {
      ...base,
      itemCount: result.events.length,
      layout: "claude-code-session-jsonl",
      notes: [
        `lines=${String(result.lineCount)}`,
        `coverage=${result.coverage.state}`,
      ],
      present: true,
      readable: true,
      version: result.sourceVersion,
    } satisfies ProbeReceipt;
  });
