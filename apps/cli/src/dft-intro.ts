// @effect-diagnostics nodeBuiltinImport:off -- The live dashboard reads its three small intro video files once at startup with synchronous node:fs reads and serves them from memory.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface IntroAsset {
  readonly body: Buffer;
  readonly contentType: string;
}

export type IntroAssets = ReadonlyMap<string, IntroAsset>;

export const INTRO_FILES = {
  "dft-intro-poster.png": "image/png",
  "dft-intro.mp4": "video/mp4",
  "dft-intro.webm": "video/webm",
} as const satisfies Readonly<Record<string, string>>;

export const INTRO_ROUTE = "/intro/";

export const introAssetsDir = (): string => {
  const bundled = path.resolve(import.meta.dirname, "assets", "intro");

  return existsSync(bundled)
    ? bundled
    : path.resolve(import.meta.dirname, "..", "assets", "intro");
};

export const loadIntroAssets = (
  dir: string = introAssetsDir()
): IntroAssets | null => {
  try {
    return new Map(
      Object.entries(INTRO_FILES).map(([name, contentType]) => [
        name,
        { body: readFileSync(path.join(dir, name)), contentType },
      ])
    );
  } catch {
    return null;
  }
};

export interface ByteRange {
  readonly end: number;
  readonly start: number;
}

const RANGE = /^bytes=(?<from>\d*)-(?<to>\d*)$/u;

export const parseRange = (
  header: string | undefined,
  size: number
): ByteRange | "invalid" | null => {
  if (header === undefined) {
    return null;
  }

  const match = RANGE.exec(header.trim());
  const from = match?.groups?.from ?? "";
  const to = match?.groups?.to ?? "";

  if (match === null || (from === "" && to === "")) {
    return "invalid";
  }

  const range =
    from === ""
      ? { end: size - 1, start: Math.max(0, size - Number(to)) }
      : {
          end: to === "" ? size - 1 : Math.min(Number(to), size - 1),
          start: Number(from),
        };

  return range.start > range.end || range.start >= size ? "invalid" : range;
};
