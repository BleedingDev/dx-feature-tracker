import { Option, Schema } from "effect";

import type { DxEventEnvelope } from "../model/event.js";

const decodeKeys = Schema.decodeUnknownOption(
  Schema.Array(Schema.NonEmptyString)
);

const prefixed = (prefix: string, value: string | null): readonly string[] =>
  value === null || value === "" ? [] : [`${prefix}:${value}`];

export const correlationKeysOf = (
  event: DxEventEnvelope
): readonly string[] => [
  ...new Set([
    ...prefixed("request", event.identity.requestId),
    ...prefixed("generation", event.identity.generationId),
    ...prefixed("session", event.identity.sessionId),
    ...(Option.getOrNull(decodeKeys(event.payload.correlationKeys)) ?? []),
  ]),
];

export const sessionIdsOf = (event: DxEventEnvelope): readonly string[] =>
  correlationKeysOf(event).flatMap((key) =>
    key.startsWith("session:") ? [key.slice("session:".length)] : []
  );
