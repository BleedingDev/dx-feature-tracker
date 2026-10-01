const NEWLINE = 0x0a;

const decoder = new TextDecoder();

export interface ByteLine {
  readonly end: number;
  readonly start: number;
  readonly text: string;
}

export interface SplitLines {
  readonly complete: readonly ByteLine[];
  readonly partial: ByteLine | null;
}

export const splitLines = (bytes: Uint8Array, base: number): SplitLines => {
  const complete: ByteLine[] = [];
  let start = 0;
  let newline = bytes.indexOf(NEWLINE, start);

  while (newline !== -1) {
    const text = decoder.decode(bytes.subarray(start, newline));

    if (text.trim() !== "") {
      complete.push({ end: base + newline + 1, start: base + start, text });
    }

    start = newline + 1;
    newline = bytes.indexOf(NEWLINE, start);
  }

  const rest = decoder.decode(bytes.subarray(start));

  return {
    complete,
    partial:
      rest.trim() === ""
        ? null
        : { end: base + bytes.byteLength, start: base + start, text: rest },
  };
};
