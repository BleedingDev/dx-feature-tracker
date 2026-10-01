import { describe, expect, it } from "@effect/vitest";
import { DxEventEnvelopeSchema } from "@rat-stack/core/dx";
import { Schema } from "effect";

import { otlpBatches } from "../src/dft-otlp-receiver.js";
import { decodeOtlpLogs, otelEvents } from "../src/dft-otlp.js";
import {
  CONVERSATION,
  SESSION,
  claudeLogsJson,
  codexLogsProtobuf,
  gzip,
} from "./otlp-payloads.js";

const NOW = "2026-10-01T14:00:00.000Z";

const json = (text: string) => ({
  bytes: new TextEncoder().encode(text),
  contentEncoding: null,
  contentType: "application/json",
});

const isEnvelope = Schema.is(DxEventEnvelopeSchema);

describe("OTLP logs receiver decoding", () => {
  it("turns a Claude Code api_request into one otel request with a list-price tool figure", () => {
    const records = decodeOtlpLogs(json(claudeLogsJson("req_fixture_1")));

    expect(records).toHaveLength(2);

    const [event, ...rest] = otelEvents(records ?? [], NOW);

    expect(rest).toEqual([]);
    expect(isEnvelope(event)).toBe(true);
    expect(event?.ai).toMatchObject({
      branchSource: "unassigned",
      channel: "otel",
      effort: "medium",
      harness: "claude-code",
      harnessVersion: "2.1.286",
      modelRaw: "claude-sonnet-5",
      provider: "anthropic",
      sessionId: SESSION,
    });
    expect(event?.usage).toEqual({
      premiumRequests: null,
      requestKey: "req_fixture_1",
      serviceTier: null,
      speed: "normal",
      tokens: {
        cacheRead: 27_778,
        cacheWrite: 27_117,
        cacheWrite1h: null,
        cacheWrite5m: null,
        inputFresh: 2,
        output: 4,
        reasoning: null,
        total: 54_901,
      },
      toolFigure: { amount: 0.25, currency: "USD", kind: "list-price" },
    });
    expect(event?.identity.requestId).toBe("req_fixture_1");
    expect(event?.occurredAt).toBe("2026-10-01T13:17:19.874Z");
    expect(JSON.stringify(event)).not.toContain("redacted");
  });

  it("gives the same event id to the same request, so a resend is a duplicate", () => {
    const first = otelEvents(
      decodeOtlpLogs(json(claudeLogsJson("req_fixture_2"))) ?? [],
      NOW
    );

    const again = otelEvents(
      decodeOtlpLogs(json(claudeLogsJson("req_fixture_2"))) ?? [],
      "2026-10-01T15:00:00.000Z"
    );

    expect(again.map((event) => event.eventId)).toEqual(
      first.map((event) => event.eventId)
    );
  });

  it("decodes a gzipped protobuf Codex response.completed event", () => {
    const records = decodeOtlpLogs({
      bytes: gzip(codexLogsProtobuf()),
      contentEncoding: "gzip",
      contentType: "application/x-protobuf",
    });

    expect(records).toHaveLength(2);
    expect(records?.[1]?.attributes.get("duration_ms")).toBe(-1);

    const [event, ...rest] = otelEvents(records ?? [], NOW);

    expect(rest).toEqual([]);
    expect(isEnvelope(event)).toBe(true);
    expect(event?.ai).toMatchObject({
      channel: "otel",
      effort: "high",
      harness: "codex",
      harnessVersion: "0.159.3",
      sessionId: CONVERSATION,
    });
    expect(event?.usage?.tokens).toEqual({
      cacheRead: 11_008,
      cacheWrite: 0,
      cacheWrite1h: null,
      cacheWrite5m: null,
      inputFresh: 7834,
      output: 5,
      reasoning: 2,
      total: 18_847,
    });
    expect(event?.usage?.toolFigure).toBeNull();
    expect(event?.usage?.requestKey).toBe(
      `codex:${CONVERSATION}:2026-10-01T13:18:03.381Z`
    );
  });

  it("rejects bodies that are not OTLP logs", () => {
    expect(decodeOtlpLogs(json("not json"))).toBeNull();

    expect(
      decodeOtlpLogs({
        bytes: new Uint8Array([10, 200]),
        contentEncoding: null,
        contentType: "application/x-protobuf",
      })
    ).toBeNull();

    expect(
      decodeOtlpLogs({
        bytes: new Uint8Array([1, 2, 3]),
        contentEncoding: "gzip",
        contentType: "application/json",
      })
    ).toBeNull();
  });

  it("groups events into one store batch per tool", () => {
    const claude = otelEvents(
      decodeOtlpLogs(json(claudeLogsJson("req_fixture_3"))) ?? [],
      NOW
    );

    const codex = otelEvents(
      decodeOtlpLogs({
        bytes: codexLogsProtobuf(),
        contentEncoding: null,
        contentType: "application/x-protobuf",
      }) ?? [],
      NOW
    );

    expect(
      otlpBatches([...claude, ...codex]).map((batch) => [
        batch.coverage.adapterId,
        batch.events.length,
      ])
    ).toEqual([
      ["harness.claude-code", 1],
      ["harness.codex", 1],
    ]);
  });
});
