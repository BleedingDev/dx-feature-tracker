export type WireField =
  | { readonly no: number; readonly kind: "varint"; readonly value: bigint }
  | { readonly no: number; readonly kind: "bytes"; readonly value: Uint8Array }
  | { readonly no: number; readonly kind: "fixed"; readonly size: 4 | 8 };

interface Cursor {
  offset: number;
}

const MAX_VARINT_BYTES = 10;

const VARINT_BASE = 128;

const readVarint = (bytes: Uint8Array, at: Cursor): bigint | null => {
  let result = 0n;
  let scale = 1n;

  for (let index = 0; index < MAX_VARINT_BYTES; index += 1) {
    const byte = bytes[at.offset];

    if (byte === undefined) {
      return null;
    }

    at.offset += 1;
    result += BigInt(byte % VARINT_BASE) * scale;

    if (byte < VARINT_BASE) {
      return result;
    }

    scale *= BigInt(VARINT_BASE);
  }

  return null;
};

const readField = (bytes: Uint8Array, at: Cursor): WireField | null => {
  const key = readVarint(bytes, at);

  if (key === null) {
    return null;
  }

  const no = Number(key / 8n);
  const wire = Number(key % 8n);

  if (no === 0) {
    return null;
  }

  if (wire === 0) {
    const value = readVarint(bytes, at);

    return value === null ? null : { kind: "varint", no, value };
  }

  if (wire === 2) {
    const length = readVarint(bytes, at);

    if (length === null || at.offset + Number(length) > bytes.length) {
      return null;
    }

    const value = bytes.subarray(at.offset, at.offset + Number(length));

    at.offset += Number(length);

    return { kind: "bytes", no, value };
  }

  const size = wire === 1 ? 8 : 4;

  if ((wire !== 1 && wire !== 5) || at.offset + size > bytes.length) {
    return null;
  }

  at.offset += size;

  return { kind: "fixed", no, size };
};

export const readMessage = (bytes: Uint8Array): readonly WireField[] | null => {
  const at: Cursor = { offset: 0 };
  const fields: WireField[] = [];

  while (at.offset < bytes.length) {
    const field = readField(bytes, at);

    if (field === null) {
      return null;
    }

    fields.push(field);
  }

  return fields;
};

const decoder = new TextDecoder("utf-8", { fatal: true });

const textOf = (value: Uint8Array): string | null => {
  try {
    return decoder.decode(value);
  } catch {
    return null;
  }
};

export const bytesOf = (
  fields: readonly WireField[],
  no: number
): readonly Uint8Array[] =>
  fields.flatMap((field) =>
    field.no === no && field.kind === "bytes" ? [field.value] : []
  );

export const stringsOf = (
  fields: readonly WireField[],
  no: number
): readonly string[] =>
  bytesOf(fields, no).flatMap((value) => {
    const text = textOf(value);

    return text === null ? [] : [text];
  });

export const stringOf = (
  fields: readonly WireField[],
  no: number
): string | null => stringsOf(fields, no).at(-1) ?? null;

export const numberOf = (
  fields: readonly WireField[],
  no: number
): number | null => {
  const found = fields.findLast(
    (field) => field.no === no && field.kind === "varint"
  );

  if (
    found?.kind !== "varint" ||
    found.value > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return null;
  }

  return Number(found.value);
};

export const messagesOf = (
  fields: readonly WireField[],
  no: number
): readonly (readonly WireField[])[] =>
  bytesOf(fields, no).flatMap((value) => {
    const message = readMessage(value);

    return message === null ? [] : [message];
  });

export const hexOf = (value: Uint8Array): string =>
  Buffer.from(value).toString("hex");
