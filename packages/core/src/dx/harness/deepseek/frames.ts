// @effect-diagnostics nodeBuiltinImport:off -- DeepSeek Harness writes concatenated Zstandard frames; node:zlib is the only decoder dft may use without a new dependency.
import { zstdDecompressSync } from "node:zlib";

const ZSTD_MAGIC = 0xfd_2f_b5_28;

const SKIPPABLE_FIRST = 0x18_4d_2a_50;

const SKIPPABLE_LAST = 0x18_4d_2a_5f;

const BLOCK_HEADER_BYTES = 3;

const CHECKSUM_BYTES = 4;

const RLE_BLOCK = 1;

const RESERVED_BLOCK = 3;

const FCS_SIZES = [0, 2, 4, 8] as const;

const DICTIONARY_SIZES = [0, 1, 2, 4] as const;

const NEWLINE = 0x0a;

export interface Frame {
  readonly end: number;
  readonly skippable: boolean;
  readonly start: number;
}

export interface FrameScan {
  readonly complete: number;
  readonly frames: readonly Frame[];
  readonly torn: boolean;
}

const bitsOf = (value: number, shift: number, width: number): number =>
  Math.floor(value / 2 ** shift) % 2 ** width;

const littleEndian = (
  bytes: Uint8Array,
  at: number,
  width: number
): number | null => {
  if (at + width > bytes.length) {
    return null;
  }

  let value = 0;

  for (let index = width - 1; index >= 0; index -= 1) {
    value = value * 256 + (bytes[at + index] ?? 0);
  }

  return value;
};

const headerLength = (descriptor: number): number => {
  const fcsFlag = bitsOf(descriptor, 6, 2);
  const singleSegment = bitsOf(descriptor, 5, 1);
  const dictionaryFlag = bitsOf(descriptor, 0, 2);
  const fcs = fcsFlag === 0 ? singleSegment : (FCS_SIZES[fcsFlag] ?? 0);

  return (
    1 +
    (singleSegment === 1 ? 0 : 1) +
    (DICTIONARY_SIZES[dictionaryFlag] ?? 0) +
    fcs
  );
};

const zstdFrameEnd = (bytes: Uint8Array, start: number): number | null => {
  const descriptor = bytes[start + 4];

  if (descriptor === undefined) {
    return null;
  }

  const hasChecksum = bitsOf(descriptor, 2, 1) === 1;
  let at = start + 4 + headerLength(descriptor);

  for (;;) {
    const header = littleEndian(bytes, at, BLOCK_HEADER_BYTES);

    if (header === null) {
      return null;
    }

    const type = bitsOf(header, 1, 2);

    if (type === RESERVED_BLOCK) {
      return null;
    }

    at +=
      BLOCK_HEADER_BYTES + (type === RLE_BLOCK ? 1 : Math.floor(header / 8));

    if (bitsOf(header, 0, 1) === 1) {
      const end = at + (hasChecksum ? CHECKSUM_BYTES : 0);

      return end > bytes.length ? null : end;
    }
  }
};

const frameAt = (bytes: Uint8Array, start: number): Frame | null => {
  const magic = littleEndian(bytes, start, 4);

  if (magic === null) {
    return null;
  }

  if (magic >= SKIPPABLE_FIRST && magic <= SKIPPABLE_LAST) {
    const size = littleEndian(bytes, start + 4, 4);

    return size === null || start + 8 + size > bytes.length
      ? null
      : { end: start + 8 + size, skippable: true, start };
  }

  const end = magic === ZSTD_MAGIC ? zstdFrameEnd(bytes, start) : null;

  return end === null ? null : { end, skippable: false, start };
};

export const scanZstdFrames = (bytes: Uint8Array, from: number): FrameScan => {
  const frames: Frame[] = [];
  let at = from;

  while (at < bytes.length) {
    const frame = frameAt(bytes, at);

    if (frame === null) {
      return { complete: at, frames, torn: true };
    }

    frames.push(frame);
    at = frame.end;
  }

  return { complete: at, frames, torn: false };
};

const decoder = new TextDecoder();

export interface DecodedLog {
  readonly corrupt: boolean;
  readonly end: number;
  readonly text: string;
  readonly torn: boolean;
}

const inflate = (bytes: Uint8Array): string | null => {
  try {
    return decoder.decode(zstdDecompressSync(bytes));
  } catch {
    return null;
  }
};

export const decodeZstdLog = (bytes: Uint8Array, from: number): DecodedLog => {
  const scan = scanZstdFrames(bytes, from);
  const parts: string[] = [];

  for (const frame of scan.frames) {
    const part = frame.skippable
      ? ""
      : inflate(bytes.subarray(frame.start, frame.end));

    if (part === null) {
      return {
        corrupt: true,
        end: frame.start,
        text: parts.join(""),
        torn: false,
      };
    }

    parts.push(part);
  }

  return {
    corrupt: false,
    end: scan.complete,
    text: parts.join(""),
    torn: scan.torn,
  };
};

export const decodeRawLog = (bytes: Uint8Array, from: number): DecodedLog => {
  const lastNewline = bytes.lastIndexOf(NEWLINE);
  const end = lastNewline < from ? from : lastNewline + 1;

  return {
    corrupt: false,
    end,
    text: decoder.decode(bytes.subarray(from, end)),
    torn: end < bytes.length,
  };
};
