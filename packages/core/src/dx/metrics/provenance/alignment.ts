export type AlignmentResult =
  | {
      readonly kind: "unique";
      readonly pairs: readonly (readonly [number, number])[];
    }
  | { readonly kind: "ambiguous" };

const cell = (table: readonly number[][], i: number, j: number): number =>
  table[i]?.[j] ?? 0;

export const alignUnique = (
  before: readonly string[],
  after: readonly string[]
): AlignmentResult => {
  const n = before.length;
  const m = after.length;

  const lengths: number[][] = Array.from({ length: n + 1 }, () =>
    Array.from({ length: m + 1 }, () => 0)
  );

  const counts: number[][] = Array.from({ length: n + 1 }, () =>
    Array.from({ length: m + 1 }, () => 1)
  );

  for (let i = n - 1; i >= 0; i -= 1) {
    const row = lengths[i] ?? [];
    const countRow = counts[i] ?? [];

    for (let j = m - 1; j >= 0; j -= 1) {
      const skipBefore = cell(lengths, i + 1, j);
      const skipAfter = cell(lengths, i, j + 1);

      const matched =
        before[i] === after[j] ? cell(lengths, i + 1, j + 1) + 1 : -1;

      const best = Math.max(skipBefore, skipAfter, matched);
      row[j] = best;
      let total = 0;

      if (matched === best) {
        total += cell(counts, i + 1, j + 1);
      }

      if (skipBefore === best) {
        total += cell(counts, i + 1, j);
      }

      if (skipAfter === best) {
        total += cell(counts, i, j + 1);
      }

      if (
        skipBefore === best &&
        skipAfter === best &&
        cell(lengths, i + 1, j + 1) === best
      ) {
        total -= cell(counts, i + 1, j + 1);
      }

      countRow[j] = Math.min(total, 2);
    }
  }

  if (cell(counts, 0, 0) > 1) {
    return { kind: "ambiguous" };
  }

  const pairs: (readonly [number, number])[] = [];
  let i = 0;
  let j = 0;

  while (i < n && j < m) {
    if (
      before[i] === after[j] &&
      cell(lengths, i, j) === cell(lengths, i + 1, j + 1) + 1
    ) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (cell(lengths, i + 1, j) === cell(lengths, i, j)) {
      i += 1;
    } else {
      j += 1;
    }
  }

  return { kind: "unique", pairs };
};
