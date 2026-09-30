import { Schema } from "effect";

export const compareText = (a: string, b: string): number => {
  if (a < b) {
    return -1;
  }

  return a > b ? 1 : 0;
};

export const canonicalKeyOf = <T, E>(
  schema: Schema.Codec<T, E>
): ((value: T) => string) => {
  const encode = Schema.encodeSync(schema);

  return (value) => JSON.stringify(encode(value));
};

export const uniqueByKey = <A>(
  items: readonly A[],
  keyOf: (item: A) => string
): A[] => {
  const seen = new Map<string, A>();

  for (const item of items) {
    const key = keyOf(item);

    if (!seen.has(key)) {
      seen.set(key, item);
    }
  }

  return [...seen.entries()]
    .toSorted(([a], [b]) => compareText(a, b))
    .map(([, item]) => item);
};
