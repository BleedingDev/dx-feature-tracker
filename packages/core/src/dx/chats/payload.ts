import { Option, Schema } from "effect";

import type { DxEventEnvelope } from "../model/event.js";

type Payload = DxEventEnvelope["payload"];

const decodeString = Schema.decodeUnknownOption(Schema.String);

const decodeFinite = Schema.decodeUnknownOption(Schema.Finite);

const decodeBoolean = Schema.decodeUnknownOption(Schema.Boolean);

const EFFORT_FIELDS = [
  "reasoningEffort",
  "reasoning_effort",
  "effort",
  "thinkingLevel",
  "thinking_level",
] as const;

const YES = new Set(["yes", "true"]);

const NO = new Set(["no", "false"]);

export const textField = (payload: Payload, key: string): string | null =>
  Option.match(decodeString(payload[key]), {
    onNone: () => null,
    onSome: (value) => (value.trim() === "" ? null : value.trim()),
  });

export const numberField = (payload: Payload, key: string): number | null =>
  Option.getOrNull(decodeFinite(payload[key]));

export const booleanField = (payload: Payload, key: string): boolean | null =>
  Option.getOrNull(decodeBoolean(payload[key]));

export const effortField = (payload: Payload): string | null => {
  for (const key of EFFORT_FIELDS) {
    const value = textField(payload, key);

    if (value !== null) {
      return value.toLowerCase();
    }
  }

  return null;
};

export const maxModeField = (payload: Payload): boolean | null => {
  const flag = booleanField(payload, "maxMode");

  if (flag !== null) {
    return flag;
  }

  const word = textField(payload, "maxMode")?.toLowerCase() ?? null;

  if (word === null) {
    return null;
  }

  if (YES.has(word)) {
    return true;
  }

  return NO.has(word) ? false : null;
};
