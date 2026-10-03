// @effect-diagnostics-next-line nodeBuiltinImport:off -- Decoded bytes require a separate content hash from the retained physical source.
import { createHash } from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native stream lifecycle types describe the bounded decoder resource.
import type { Transform } from "node:stream";
import * as zlib from "node:zlib";

import { Effect, Exit, Predicate, Schema } from "effect";

import type { AgentStoreFailure } from "../contracts/agent-store.js";
import { AgentError } from "../contracts/error-agent.js";
import { SourceUnavailable } from "../contracts/error-source-unavailable.js";
import type { Harness, ReadInput, SessionRef } from "../harness/contract.js";
import { scanZstdFrames } from "../harness/deepseek/frames.js";
import { DeepseekHarness, DeepseekStore } from "../harness/deepseek/index.js";
import { readDeepseekSession } from "../harness/deepseek/read.js";
import { memoryFileStore } from "../harness/file-store.js";
import { OmpHarness, OmpStore } from "../harness/omp/index.js";
import { statsTotalsByFile } from "../harness/omp/stats.js";
import type { AgentScope } from "../model/agent-common.js";
import type { OperationBounds } from "../model/agent-operation.js";
import type { SelectedSourceSnapshot, SnapshotHarness } from "./collector.js";
import type { OperationWorkContext } from "./ports.js";

const OUTPUT_CHUNK_BYTES = 64;

const DecoderWindowErrorSchema = Schema.Struct({
  code: Schema.Literal("ZSTD_error_frameParameter_windowTooLarge"),
});

export type OperationSnapshotEncoding = "identity" | "gzip" | "zstd";

export interface DecodedOperationSnapshot {
  readonly source: SelectedSourceSnapshot;
  readonly bytes: Uint8Array;
  readonly contentDigest: string;
  readonly encoding: OperationSnapshotEncoding;
  readonly rawRecordUnits: number;
}

interface DecodingWork {
  emittedBytes: number;
}

export const operationSnapshotEncoding = (
  file: string
): OperationSnapshotEncoding => {
  if (file.endsWith(".gz")) {
    return "gzip";
  }

  return file.endsWith(".zst") || file.endsWith(".zstd") ? "zstd" : "identity";
};

const unavailable = (
  snapshot: SelectedSourceSnapshot,
  message: string
): SourceUnavailable =>
  new SourceUnavailable({
    adapterId: `harness.${snapshot.ref.harness}`,
    message,
  });

const exhausted = (message: string): AgentError =>
  new AgentError({
    code: "budget-exhausted",
    currentRevision: null,
    expectedRevision: null,
    message,
    recovery: { action: "replan", ref: null },
    ref: null,
    retryable: false,
  });

const recordUnits = (bytes: Uint8Array): number => {
  let units = 0;

  for (const byte of bytes) {
    if (byte === 10) {
      units += 1;
    }
  }

  return units + (bytes.byteLength > 0 && bytes.at(-1) !== 10 ? 1 : 0);
};

const checkZstdSource = Effect.fn("checkZstdSource")(
  function* checkCompleteFrames(
    snapshot: SelectedSourceSnapshot,
    context: OperationWorkContext
  ): Effect.fn.Return<void, AgentStoreFailure | SourceUnavailable> {
    const { bytes } = snapshot;
    const remaining = yield* context.budget.remaining;
    const maximumCandidates = Math.max(1, remaining.maxRecords);
    let candidates = 0;

    for (let at = 0; at + 3 < bytes.byteLength; at += 1) {
      if (at % 65_536 === 0) {
        yield* context.budget.remaining;
      }

      const first = bytes[at];

      const standard =
        first === 0x28 &&
        bytes[at + 1] === 0xb5 &&
        bytes[at + 2] === 0x2f &&
        bytes[at + 3] === 0xfd;

      const skippable =
        first !== undefined &&
        first >= 0x50 &&
        first <= 0x5f &&
        bytes[at + 1] === 0x2a &&
        bytes[at + 2] === 0x4d &&
        bytes[at + 3] === 0x18;

      if (standard || skippable) {
        candidates += 1;

        if (candidates > maximumCandidates) {
          return yield* exhausted(
            "The encoded frame candidates exceed the remaining record allowance."
          );
        }
      }
    }

    if (scanZstdFrames(bytes, 0).torn) {
      return yield* unavailable(
        snapshot,
        "The Zstandard source contains an incomplete or unsupported frame; no decoded observations were accepted."
      );
    }

    yield* context.budget.remaining;

    return yield* Effect.void;
  }
);

const finishStream = (decoder: Transform): Effect.Effect<void> =>
  Effect.callback<null>((resume) => {
    if (decoder.closed) {
      resume(Effect.succeed(null));

      return;
    }

    decoder.once("close", () => {
      resume(Effect.succeed(null));
    });
    decoder.destroy();
  }).pipe(Effect.asVoid);

const makeDecoder = (
  snapshot: SelectedSourceSnapshot,
  encoding: Exclude<OperationSnapshotEncoding, "identity">,
  outputLimit: number
): Effect.Effect<Transform, SourceUnavailable> => {
  if (encoding === "zstd" && !Predicate.isFunction(zlib.createZstdDecompress)) {
    return Effect.fail(
      unavailable(
        snapshot,
        "This Node runtime has no native Zstandard decoder."
      )
    );
  }

  return Effect.try({
    catch: () =>
      unavailable(snapshot, "The bounded native decoder is unavailable."),
    try: () => {
      const options = {
        chunkSize: OUTPUT_CHUNK_BYTES,
        maxOutputLength: outputLimit,
      };

      if (encoding === "gzip") {
        return zlib.createGunzip(options);
      }

      const maximumWindowLog = Math.max(
        10,
        Math.min(26, Math.floor(Math.log2(outputLimit)))
      );

      return zlib.createZstdDecompress({
        ...options,
        params: {
          [zlib.constants.ZSTD_d_windowLogMax]: maximumWindowLog,
        },
      });
    },
  });
};

const decodeStream = (
  snapshot: SelectedSourceSnapshot,
  encoding: Exclude<OperationSnapshotEncoding, "identity">,
  outputLimit: number,
  work: DecodingWork
): Effect.Effect<Uint8Array, SourceUnavailable | AgentError> =>
  Effect.scoped(
    Effect.gen(function* boundedDecode() {
      const decoder = yield* Effect.acquireRelease(
        makeDecoder(snapshot, encoding, outputLimit),
        finishStream
      );

      return yield* Effect.callback<Uint8Array, SourceUnavailable | AgentError>(
        (resume) => {
          const chunks: Uint8Array[] = [];
          let settled = false;

          const fail = (error: SourceUnavailable | AgentError): void => {
            if (settled) {
              return;
            }

            settled = true;
            resume(Effect.fail(error));
            decoder.destroy();
          };

          decoder.on("error", (error: Error) => {
            fail(
              Schema.is(DecoderWindowErrorSchema)(error)
                ? exhausted(
                    "The compressed source requires a decoder window beyond the reviewed byte allowance."
                  )
                : unavailable(
                    snapshot,
                    "The compressed source is invalid or its native decoder failed."
                  )
            );
          });

          decoder.on("data", (chunk: Uint8Array) => {
            if (settled) {
              return;
            }

            work.emittedBytes += chunk.byteLength;

            if (work.emittedBytes > outputLimit) {
              fail(
                exhausted(
                  "The decompressed source exceeds the remaining decoded-byte allowance."
                )
              );

              return;
            }

            chunks.push(chunk);
          });

          decoder.once("end", () => {
            if (settled) {
              return;
            }

            settled = true;
            const bytes = new Uint8Array(work.emittedBytes);
            let offset = 0;

            for (const chunk of chunks) {
              bytes.set(chunk, offset);
              offset += chunk.byteLength;
            }

            resume(Effect.succeed(bytes));
          });

          decoder.end(snapshot.bytes);

          return Effect.sync(() => {
            settled = true;
            decoder.destroy();
          });
        }
      );
    })
  );

export const decompressOperationSnapshot = Effect.fn(
  "decompressOperationSnapshot"
)(function* decompressCapturedSource(
  snapshot: SelectedSourceSnapshot,
  context: OperationWorkContext
): Effect.fn.Return<
  DecodedOperationSnapshot,
  AgentStoreFailure | SourceUnavailable
> {
  const encoding = operationSnapshotEncoding(snapshot.ref.path);

  if (encoding === "identity") {
    return {
      bytes: snapshot.bytes,
      contentDigest: snapshot.contentDigest,
      encoding,
      rawRecordUnits: recordUnits(snapshot.bytes),
      source: snapshot,
    };
  }

  if (encoding === "zstd") {
    yield* checkZstdSource(snapshot, context);
  }

  const remaining = yield* context.budget.remaining;
  const outputLimit = remaining.maxBytes - OUTPUT_CHUNK_BYTES;

  if (outputLimit <= 0) {
    return yield* exhausted(
      "The remaining byte allowance cannot hold bounded decompression output."
    );
  }

  const work: DecodingWork = { emittedBytes: 0 };

  const bytes = yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* reservedDecode() {
      const reservation = yield* context.budget.reserve({
        byteUnits: remaining.maxBytes,
        bytesRead: 0,
        filesRead: 0,
        recordsDecoded: 0,
        requests: 0,
        retries: 0,
      });

      const result = yield* Effect.exit(
        restore(
          decodeStream(snapshot, encoding, outputLimit, work).pipe(
            Effect.timeout(remaining.maxElapsedMs),
            Effect.catchTag("TimeoutError", () =>
              Effect.fail(
                exhausted(
                  "The operation time limit expired during decompression."
                )
              )
            )
          )
        )
      );

      yield* reservation.complete({
        byteUnits: work.emittedBytes,
        bytesRead: 0,
        filesRead: 0,
        recordsDecoded: 0,
        requests: 0,
        retries: 0,
      });

      return yield* Exit.isSuccess(result)
        ? Effect.succeed(result.value)
        : Effect.failCause(result.cause);
    })
  );

  yield* context.budget.remaining;
  const units = recordUnits(bytes);

  const records = yield* context.budget.reserve({
    bytesRead: 0,
    filesRead: 0,
    recordUnits: units,
    recordsDecoded: 0,
    requests: 0,
    retries: 0,
  });

  yield* records.complete({
    bytesRead: 0,
    filesRead: 0,
    recordUnits: units,
    recordsDecoded: 0,
    requests: 0,
    retries: 0,
  });

  yield* Effect.try({
    catch: () =>
      unavailable(snapshot, "The decompressed source is not valid UTF-8."),
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  });

  return {
    bytes,
    contentDigest: createHash("sha256").update(bytes).digest("hex"),
    encoding,
    rawRecordUnits: units,
    source: snapshot,
  };
});

const exactSource = (
  ref: SessionRef,
  snapshot: SelectedSourceSnapshot
): boolean =>
  ref.harness === snapshot.ref.harness &&
  ref.channel === "session-file" &&
  ref.path === snapshot.ref.path &&
  ref.id === snapshot.ref.id &&
  ref.sessionId === snapshot.ref.sessionId &&
  ref.source === snapshot.ref.source &&
  ref.mtimeMs === snapshot.ref.mtimeMs &&
  ref.size === snapshot.ref.size &&
  ref.worktree === snapshot.ref.worktree;

const rawPath = (file: string): string => {
  let suffix = ".gz";

  if (file.endsWith(".zstd")) {
    suffix = ".zstd";
  } else if (file.endsWith(".zst")) {
    suffix = ".zst";
  }

  const uncompressed = file.slice(0, -suffix.length);

  return uncompressed.endsWith(".jsonl")
    ? uncompressed
    : `${uncompressed}.jsonl`;
};

const nativeCompressedParser = (
  decoded: DecodedOperationSnapshot
): Effect.Effect<Harness, SourceUnavailable> => {
  const { source, bytes } = decoded;

  const memory = {
    files: [
      {
        bytes,
        mtimeMs: source.ref.mtimeMs ?? 0,
        path: source.ref.path,
      },
    ],
    roots: [source.selection.root],
  };

  if (source.ref.harness === "omp") {
    const base = memoryFileStore("omp", memory);

    return OmpHarness.make.pipe(
      Effect.provideService(OmpStore, {
        ...base,
        readHead: base.readBytes,
        readSession: base.readBytes,
        realPath: (file) => Effect.succeed(file),
        statsTotals: Effect.succeed(statsTotalsByFile([])),
      })
    );
  }

  if (source.ref.harness === "deepseek") {
    return DeepseekHarness.make.pipe(
      Effect.provide(DeepseekStore.memory(memory)),
      Effect.map((base): Harness => ({
        ...base,
        read: (ref: SessionRef, input: ReadInput) =>
          Effect.sync(() => {
            const batch = readDeepseekSession({
              bytes,
              harnessVersion: null,
              input: { ...input, cursor: null },
              ref: { ...ref, path: rawPath(ref.path) },
            });

            return {
              ...batch,
              coverage: {
                ...batch.coverage,
                gaps: [
                  ...batch.coverage.gaps,
                  {
                    code: "collection.compressed-cursor-retained",
                    message:
                      "The bounded compressed snapshot was replayed for deduplication. Its encoded cursor was retained because decoded offsets cannot advance the physical source cursor.",
                  },
                ],
                state:
                  batch.coverage.state === "complete"
                    ? "partial"
                    : batch.coverage.state,
              },
              cursor: null,
            };
          }),
      }))
    );
  }

  return Effect.fail(
    unavailable(
      source,
      "No bounded native parser is installed for this compressed harness."
    )
  );
};

export const compressedSnapshotHarness = Effect.fn("compressedSnapshotHarness")(
  function* makeCompressedParser(
    decoded: DecodedOperationSnapshot,
    context: OperationWorkContext
  ): Effect.fn.Return<SnapshotHarness, AgentStoreFailure | SourceUnavailable> {
    if (
      decoded.encoding === "identity" ||
      decoded.source.ref.channel !== "session-file"
    ) {
      return yield* unavailable(
        decoded.source,
        "A compressed session-file snapshot is required."
      );
    }

    const base = yield* nativeCompressedParser(decoded);
    let read = false;

    return {
      ...base,
      discover: Effect.succeed({
        harness: decoded.source.ref.harness,
        present: true,
        reason: null,
        roots: [decoded.source.selection.root],
        sessions: 1,
        version: null,
      }),
      locate: () => Effect.succeed([decoded.source.ref]),
      read: Effect.fn("compressedSnapshotHarness.read")(
        function* readCapturedSession(ref: SessionRef, input: ReadInput) {
          if (read || !exactSource(ref, decoded.source)) {
            return yield* unavailable(
              decoded.source,
              "The bounded parser permits one read of its exact selected source."
            );
          }

          read = true;
          yield* context.budget.remaining.pipe(
            Effect.mapError((error) =>
              unavailable(decoded.source, error.message)
            )
          );

          return yield* base.read(ref, input);
        }
      ),
      recordUnitsPrepaid: true,
      retainCursor: decoded.source.ref.harness === "deepseek",
    };
  }
);

export const boundedCompressedSnapshotHarness = Effect.fn(
  "boundedCompressedSnapshotHarness"
)(function* makeBoundedCompressedParser(
  snapshot: SelectedSourceSnapshot,
  _bounds: OperationBounds,
  _scope: AgentScope,
  context: OperationWorkContext
): Effect.fn.Return<SnapshotHarness, AgentStoreFailure> {
  return yield* decompressOperationSnapshot(snapshot, context).pipe(
    Effect.flatMap((decoded) => compressedSnapshotHarness(decoded, context)),
    Effect.catchTag("SourceUnavailable", (error) =>
      Effect.fail(
        new AgentError({
          code: "source-unavailable",
          currentRevision: null,
          expectedRevision: null,
          message: error.message,
          recovery: { action: "replan", ref: null },
          ref: null,
          retryable: false,
        })
      )
    )
  );
});
