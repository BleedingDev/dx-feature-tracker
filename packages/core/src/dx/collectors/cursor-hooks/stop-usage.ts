export const STOP_TOKEN_FIELDS = [
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
] as const;

export type StopTokenCategory =
  | "input"
  | "cachedInput"
  | "cacheWrite"
  | "output";

export interface StopTokenUsage {
  readonly categories: Readonly<Partial<Record<StopTokenCategory, number>>>;
  readonly freshInputClamped: boolean;
  readonly verifiedFields: readonly string[];
}

const isStopTokenField = (path: string): boolean =>
  STOP_TOKEN_FIELDS.some((field) => field === path);

const nonNegative = (value: number | undefined): number | undefined =>
  value === undefined || value < 0 ? undefined : value;

const freshInputOf = (
  gross: number | undefined,
  cacheRead: number | undefined,
  cacheWrite: number | undefined
) =>
  gross === undefined || cacheRead === undefined || cacheWrite === undefined
    ? null
    : gross - cacheRead - cacheWrite;

export const stopTokenUsage = (
  raw: Readonly<Record<string, number>>
): StopTokenUsage | null => {
  const input = nonNegative(raw.input_tokens);
  const output = nonNegative(raw.output_tokens);
  const cacheRead = nonNegative(raw.cache_read_tokens);
  const cacheWrite = nonNegative(raw.cache_write_tokens);
  const fresh = freshInputOf(input, cacheRead, cacheWrite);

  const categories: Partial<Record<StopTokenCategory, number>> = {};

  if (fresh !== null) {
    categories.input = Math.max(fresh, 0);
  }

  if (cacheRead !== undefined) {
    categories.cachedInput = cacheRead;
  }

  if (cacheWrite !== undefined) {
    categories.cacheWrite = cacheWrite;
  }

  if (output !== undefined) {
    categories.output = output;
  }

  const verifiedFields = Object.keys(raw)
    .filter(isStopTokenField)
    .filter((field) => nonNegative(raw[field]) !== undefined)
    .filter((field) => field !== "input_tokens" || fresh !== null)
    .toSorted();

  return verifiedFields.length === 0
    ? null
    : {
        categories,
        freshInputClamped: fresh !== null && fresh < 0,
        verifiedFields,
      };
};
