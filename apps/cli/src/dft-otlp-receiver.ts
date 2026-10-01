// @effect-diagnostics nodeBuiltinImport:off -- The OTLP/HTTP receiver reads exporter requests from node:http inside dft dashboard on 127.0.0.1.
import type { IncomingMessage, ServerResponse } from "node:http";

import { EventStore, dxStoreLayer } from "@rat-stack/core/dx";
import type { DxEventEnvelope, EventBatch } from "@rat-stack/core/dx";
import { Data, DateTime, Effect } from "effect";

import { decodeOtlpLogs, otelEvents } from "./dft-otlp.js";

export const OTLP_LOGS_PATH = "/v1/logs";

export const OTLP_PATHS: ReadonlySet<string> = new Set([
  OTLP_LOGS_PATH,
  "/v1/metrics",
  "/v1/traces",
]);

export const MAX_OTLP_BODY = 8 * 1024 * 1024;

export class OtlpReceiverError extends Data.TaggedError("OtlpReceiverError")<{
  readonly message: string;
  readonly status: number;
}> {}

const rejected = (status: number, message: string) =>
  Effect.fail(new OtlpReceiverError({ message, status }));

const readBytes = (request: IncomingMessage) =>
  Effect.callback<Uint8Array, OtlpReceiverError>((resume) => {
    const chunks: Buffer[] = [];
    let size = 0;

    request.on("data", (chunk: Buffer) => {
      size += chunk.length;

      if (size > MAX_OTLP_BODY) {
        resume(rejected(413, "OTLP request too large."));
        request.destroy();

        return;
      }

      chunks.push(chunk);
    });
    request.on("end", () => {
      resume(Effect.succeed(new Uint8Array(Buffer.concat(chunks))));
    });
    request.on("error", () => {
      resume(rejected(400, "Could not read the OTLP request."));
    });
  });

const header = (request: IncomingMessage, name: string): string | null => {
  const value = request.headers[name];

  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
};

const respond = (
  response: ServerResponse,
  status: number,
  json: boolean,
  message: string | null
) =>
  Effect.sync(() => {
    response.writeHead(status, {
      "cache-control": "no-store",
      "content-type": json ? "application/json" : "application/x-protobuf",
    });
    response.end(
      json ? JSON.stringify(message === null ? {} : { error: message }) : ""
    );
  });

export const otlpBatches = (
  events: readonly DxEventEnvelope[]
): readonly EventBatch[] => {
  const byAdapter = new Map<string, DxEventEnvelope[]>();

  for (const event of events) {
    byAdapter.set(event.adapterId, [
      ...(byAdapter.get(event.adapterId) ?? []),
      event,
    ]);
  }

  return [...byAdapter.entries()].map(([adapterId, list]) => ({
    coverage: {
      adapterId,
      expectedItems: null,
      gaps: [],
      observedItems: list.length,
      state: "partial",
      watermark: null,
      windowFrom: null,
      windowTo: null,
    },
    cursor: null,
    events: list,
  }));
};

export const receiveOtlp = (
  request: IncomingMessage,
  response: ServerResponse,
  store: Parameters<typeof dxStoreLayer>[0]
) =>
  Effect.gen(function* receive() {
    const json = (header(request, "content-type") ?? "").includes("json");

    if (header(request, "origin") !== null) {
      return yield* rejected(
        403,
        "OTLP exporters do not send an Origin header; browser requests are refused."
      );
    }

    const bytes = yield* readBytes(request);
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    if (url.pathname !== OTLP_LOGS_PATH) {
      return yield* respond(response, 200, json, null);
    }

    const records = decodeOtlpLogs({
      bytes,
      contentEncoding: header(request, "content-encoding"),
      contentType: header(request, "content-type"),
    });

    if (records === null) {
      return yield* rejected(400, "Not an OTLP logs request.");
    }

    const now = DateTime.formatIso(yield* DateTime.now);
    const events = otelEvents(records, now);

    if (events.length > 0) {
      yield* Effect.gen(function* persist() {
        const eventStore = yield* EventStore;

        for (const batch of otlpBatches(events)) {
          yield* eventStore.append(batch);
        }
      }).pipe(
        Effect.provide(dxStoreLayer(store)),
        Effect.catch(() => rejected(503, "Could not store OTLP events."))
      );
    }

    return yield* respond(response, 200, json, null);
  }).pipe(
    Effect.catchTag("OtlpReceiverError", (failure) =>
      respond(
        response,
        failure.status,
        (header(request, "content-type") ?? "").includes("json"),
        failure.message
      )
    )
  );
