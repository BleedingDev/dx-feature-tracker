import { Option, Predicate, Schema } from "effect";

import type { DxEventEnvelope } from "../../model/event.js";

export const MAX_REF_CHARS = 240;

export const MAX_EXCERPT_CHARS = 512;

export const MAX_FIELD_CHARS = 120;

export const MAX_EXCERPT_FIELDS = 24;

const MAX_DEPTH = 2;

export interface RedactedText {
  readonly text: string;
  readonly redacted: boolean;
}

const SECRET_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gu,
    "[redacted:private-key]",
  ],
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/gu, "[redacted:jwt]"],
  [/\bgithub_pat_\w{20,}/gu, "[redacted:token]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/gu, "[redacted:token]"],
  [/\bsk-[\w-]{16,}/gu, "[redacted:token]"],
  [/\bxox[abprs]-[\w-]{10,}/gu, "[redacted:token]"],
  [/\bAKIA[0-9A-Z]{16}\b/gu, "[redacted:aws-key]"],
  [/\b(?:Bearer|Basic|token)\s+[\w.~+/=-]{8,}/giu, "[redacted:credential]"],
  [
    /\b(?<prefix>(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd|pwd|client[_-]?secret)\s*[=:]\s*)["']?[^\s"'&;,]+/giu,
    "$<prefix>[redacted]",
  ],
  [/\b[\w.%+-]+@[\w-]+(?:\.[\w-]+)+\b/gu, "[redacted:email]"],
  [/(?:\/Users|\/home)\/[^/\s"']+/gu, "~"],
  [/[A-Za-z]:\\Users\\[^\\\s"']+/gu, "~"],
];

export const redactText = (input: string): RedactedText => {
  let text = input;

  for (const [pattern, replacement] of SECRET_PATTERNS) {
    text = text.replace(pattern, replacement);
  }

  return { redacted: text !== input, text };
};

export const truncate = (input: string, max: number): RedactedText =>
  input.length <= max
    ? { redacted: false, text: input }
    : { redacted: true, text: `${input.slice(0, Math.max(0, max - 1))}…` };

const stripUrl = (input: string): RedactedText => {
  if (!/^[a-z][\d+.a-z-]*:\/\//iu.test(input)) {
    return { redacted: false, text: input };
  }

  try {
    const url = new URL(input);

    const hadSecretParts =
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "";

    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";

    return { redacted: hadSecretParts, text: url.toString() };
  } catch {
    return { redacted: true, text: "[redacted:unparseable-url]" };
  }
};

const stripControl = (input: string): string => {
  let out = "";

  for (let index = 0; index < input.length; index += 1) {
    const code = input.codePointAt(index) ?? 0;

    if (code >= 32 && code !== 127) {
      out += input.charAt(index);
    }
  }

  return out;
};

export const boundRef = (ref: string): RedactedText => {
  const url = stripUrl(stripControl(ref));
  const secret = redactText(url.text);
  const bounded = truncate(secret.text, MAX_REF_CHARS);

  return {
    redacted:
      url.redacted ||
      secret.redacted ||
      bounded.redacted ||
      url.text.length !== ref.length,
    text: bounded.text,
  };
};

const CONTENT_KEY =
  /^(?:prompt|prompts|text|content|contents|message|messages|body|output|stdout|stderr|diff|patch|transcript|code|response|completion|reasoning|thinking|instructions|query|input|args|arguments|command|commandline|cmd|env|environment|headers|cookie|cookies|title|description|comment|snippet|excerpt|before|after|old_string|new_string|oldtext|newtext|preimage|postimage)$/iu;

const SECRET_KEY =
  /secret|password|passwd|api[_-]?key|authorization|cookie|credential|private[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|^token$|^auth$/iu;

export type FieldDisposition = "kept" | "redacted" | "withheld";

export interface ExcerptField {
  readonly path: string;
  readonly value: string;
  readonly disposition: FieldDisposition;
}

const isJsonArray = (value: Schema.Json): value is Schema.JsonArray =>
  Array.isArray(value);

interface VisitState {
  readonly out: ExcerptField[];
  dropped: number;
}

const visit = (
  value: Schema.Json,
  path: string,
  depth: number,
  state: VisitState
): void => {
  const { out } = state;

  if (out.length >= MAX_EXCERPT_FIELDS) {
    state.dropped += 1;

    return;
  }

  const leaf = path.split(".").at(-1) ?? path;

  if (
    value === null ||
    Predicate.isNumber(value) ||
    Predicate.isBoolean(value)
  ) {
    out.push({ disposition: "kept", path, value: String(value) });

    return;
  }

  if (Predicate.isString(value)) {
    if (SECRET_KEY.test(leaf)) {
      out.push({ disposition: "withheld", path, value: "[redacted]" });

      return;
    }

    if (CONTENT_KEY.test(leaf)) {
      out.push({
        disposition: "withheld",
        path,
        value: `[withheld:${value.length} chars]`,
      });

      return;
    }

    const secret = redactText(value.replaceAll(/\s+/gu, " "));
    const bounded = truncate(secret.text, MAX_FIELD_CHARS);
    out.push({
      disposition: secret.redacted || bounded.redacted ? "redacted" : "kept",
      path,
      value: bounded.text,
    });

    return;
  }

  if (isJsonArray(value)) {
    out.push({
      disposition: "withheld",
      path,
      value: `[array:${value.length}]`,
    });

    return;
  }

  if (depth >= MAX_DEPTH || SECRET_KEY.test(leaf) || CONTENT_KEY.test(leaf)) {
    out.push({ disposition: "withheld", path, value: "[object]" });

    return;
  }

  for (const key of Object.keys(value).toSorted()) {
    const child = value[key];

    if (child !== undefined) {
      visit(child, `${path}.${key}`, depth + 1, state);
    }
  }
};

export interface PayloadExcerpt {
  readonly excerpt: string | null;
  readonly redacted: boolean;
  readonly fields: readonly ExcerptField[];
  readonly droppedFields: number;
}

const decodeJsonObject = Schema.decodeUnknownOption(Schema.JsonObject);

export const excerptPayload = (
  payload: DxEventEnvelope["payload"]
): PayloadExcerpt => {
  const decoded = decodeJsonObject(payload);

  if (Option.isNone(decoded)) {
    return {
      droppedFields: 0,
      excerpt: "[withheld:non-json payload]",
      fields: [],
      redacted: true,
    };
  }

  const json = decoded.value;
  const state: VisitState = { dropped: 0, out: [] };

  for (const key of Object.keys(json).toSorted()) {
    const child = json[key];

    if (child !== undefined) {
      visit(child, key, 1, state);
    }
  }

  const fields = state.out;

  if (fields.length === 0) {
    return { droppedFields: 0, excerpt: null, fields, redacted: false };
  }

  const joined = fields
    .map((field) => `${field.path}=${field.value}`)
    .join("; ");

  const bounded = truncate(joined, MAX_EXCERPT_CHARS);
  const droppedFields = state.dropped > 0;

  return {
    droppedFields: state.dropped,
    excerpt: bounded.text,
    fields,
    redacted:
      bounded.redacted ||
      droppedFields ||
      fields.some((field) => field.disposition !== "kept"),
  };
};
