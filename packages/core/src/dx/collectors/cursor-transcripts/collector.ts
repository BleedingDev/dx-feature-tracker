import type { Crypto } from "effect";
import { DateTime, Effect, FileSystem, Option } from "effect";

import { InvalidInput } from "../../contracts/error-invalid-input.js";
import { SourceUnavailable } from "../../contracts/error-source-unavailable.js";
import type { DxCollector } from "../../contracts/services.js";
import { CONTRACT_VERSION } from "../../contracts/version.js";
import type { ModuleDescriptor } from "../../model/descriptor.js";
import { emptyFlightContext } from "../../model/event.js";
import { DescriptorIdSchema } from "../../model/ids.js";
import type { ProbeReceipt } from "../../model/probe.js";
import {
  CURSOR_TRANSCRIPT_ADAPTER_ID,
  CURSOR_TRANSCRIPT_ADAPTER_VERSION,
  parseCursorTranscript,
} from "./parse.js";

export const CURSOR_TRANSCRIPT_FIXTURE_IDS = [
  "b07-cursor-transcript-jsonl",
  "b07-cursor-subagent-jsonl",
  "b07-cursor-transcript-txt",
] as const;

export const cursorTranscriptDescriptor: ModuleDescriptor = {
  contractVersion: CONTRACT_VERSION,
  fixtureIds: [...CURSOR_TRANSCRIPT_FIXTURE_IDS],
  gaps: [
    {
      code: "cursor-agent-output",
      message:
        "cursor-agent also writes these transcripts; its stream-json output is read by collector/cursor-cli, and its chat store adds turn times, request ids and branches",
    },
    {
      code: "charge-unavailable",
      message:
        "Transcripts carry no billed charge; money needs a separate billing import",
    },
    {
      code: "tokens-optional",
      message:
        "Role/content transcripts usually omit usage; tokens are source-reported only when a usage object is present, else unavailable plus a labelled visible-text estimate",
    },
    {
      code: "worktree-folder-only",
      message:
        "Auto-sync reads ~/.cursor/projects/<worktree slug>/agent-transcripts for each synced worktree; other projects are never read",
    },
    {
      code: "markdown-export-unsupported",
      message: "Manual Export Transcript .md files are not parsed",
    },
  ],
  id: DescriptorIdSchema.make("collector.cursor-transcripts"),
  kind: "collector",
  owner: "B07",
  readiness: "degraded",
  requiredInputs: [
    "selectedInput: path to one Cursor ~/.cursor/projects/<slug>/agent-transcripts/<composerId>(.jsonl|.txt) file, or a subagents/<id>.jsonl child",
  ],
  supportedFields: [
    "identity.sessionId",
    "identity.turnId",
    "payload.model",
    "payload.tokens.input",
    "payload.tokens.cached-input",
    "payload.tokens.cache-write",
    "payload.tokens.output",
    "payload.tokens.reasoning",
    "payload.tokens.total",
    "payload.unmappedUsage",
    "payload.usageState",
    "payload.toolCalls",
    "payload.toolNames",
    "payload.estimates.visibleTextTokens",
    "payload.parentSessionId",
  ],
  version: CURSOR_TRANSCRIPT_ADAPTER_VERSION,
};

const segmentsOf = (path: string): string[] =>
  path.split(/[\\/]/u).filter((part) => part !== "");

const basename = (path: string): string => segmentsOf(path).at(-1) ?? path;

const stem = (name: string): string => name.replace(/\.[^.]+$/u, "");

export const sessionFromPath = (path: string) => {
  const segments = segmentsOf(path);
  const name = stem(basename(path));
  const subIndex = segments.lastIndexOf("subagents");

  if (subIndex > 0 && subIndex === segments.length - 2) {
    return {
      parentSessionId: segments[subIndex - 1] ?? null,
      sessionHint: name,
    };
  }

  return { parentSessionId: null, sessionHint: name === "" ? null : name };
};

const hashFailure = (error: { readonly message: string }) =>
  new SourceUnavailable({
    adapterId: CURSOR_TRANSCRIPT_ADAPTER_ID,
    message: `cannot hash Cursor transcript evidence: ${error.message}`,
  });

const requirePath = (selectedInput: string | null) =>
  selectedInput === null || selectedInput.trim() === ""
    ? Effect.fail(
        new InvalidInput({
          field: "selectedInput",
          message:
            "cursor-transcripts needs an explicitly selected transcript file; nothing is scanned by default",
        })
      )
    : Effect.succeed(selectedInput);

const readSelected = (path: string) =>
  Effect.gen(function* readSelectedTranscript() {
    const fileSystem = yield* FileSystem.FileSystem;

    return yield* fileSystem.readFileString(path).pipe(
      Effect.mapError(
        (error) =>
          new SourceUnavailable({
            adapterId: CURSOR_TRANSCRIPT_ADAPTER_ID,
            message: `cannot read selected Cursor transcript: ${error.message}`,
          })
      )
    );
  });

export const cursorTranscriptCollector: DxCollector<
  FileSystem.FileSystem | Crypto.Crypto
> = {
  collect: (input) =>
    Effect.gen(function* collectCursorTranscript() {
      const path = yield* requirePath(input.selectedInput);
      const text = yield* readSelected(path);
      const now = yield* DateTime.now;

      const result = yield* parseCursorTranscript(text, {
        ...sessionFromPath(path),
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
  descriptor: cursorTranscriptDescriptor,
};

export const probeCursorTranscript = (path: string) =>
  Effect.gen(function* probeSelectedTranscript() {
    const probedAt = DateTime.formatIso(yield* DateTime.now);

    const base = {
      adapterId: CURSOR_TRANSCRIPT_ADAPTER_ID,
      probeId: `probe:${CURSOR_TRANSCRIPT_ADAPTER_ID}:${basename(path)}`,
      probedAt,
      sourceKind: "cursor-transcript",
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

    const result = yield* parseCursorTranscript(text.value, {
      ...sessionFromPath(path),
      context: emptyFlightContext,
      observedAt: probedAt,
      origin: "imported",
      sourceName: basename(path),
    }).pipe(Effect.mapError(hashFailure));

    return {
      ...base,
      itemCount: result.events.length,
      layout: result.layout,
      notes: [
        `lines=${String(result.lineCount)}`,
        `coverage=${result.coverage.state}`,
      ],
      present: true,
      readable: true,
      version: null,
    } satisfies ProbeReceipt;
  });
