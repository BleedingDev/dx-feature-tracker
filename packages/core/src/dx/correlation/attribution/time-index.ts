export interface Timed<T> {
  readonly at: number;
  readonly item: T;
  readonly order: number;
}

export interface TimeIndex<T> {
  readonly all: readonly T[];
  readonly timed: readonly Timed<T>[];
}

export const timeIndexOf = <T>(
  items: readonly T[],
  timeOf: (item: T) => number | null
): TimeIndex<T> => ({
  all: items,
  timed: items
    .flatMap((item, order) => {
      const at = timeOf(item);

      return at === null ? [] : [{ at, item, order }];
    })
    .toSorted((a, b) => a.at - b.at || a.order - b.order),
});

const boundOf = <T>(
  timed: readonly Timed<T>[],
  at: number,
  inclusive: boolean
): number => {
  let low = 0;
  let high = timed.length;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const value = timed[middle]?.at ?? Number.POSITIVE_INFINITY;

    if (value < at || (inclusive && value === at)) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  return low;
};

export const timedWithin = <T>(
  timed: readonly Timed<T>[],
  from: number,
  to: number
): readonly Timed<T>[] =>
  timed.slice(boundOf(timed, from, false), boundOf(timed, to, true));

export const nearest = <T>(
  index: TimeIndex<T>,
  at: number | null
): T | undefined => {
  const { timed } = index;

  if (at === null || timed.length === 0) {
    return index.all[0];
  }

  const after = boundOf(timed, at, false);
  const later = timed[after]?.at ?? Number.POSITIVE_INFINITY;
  const earlier = timed[after - 1]?.at ?? Number.NEGATIVE_INFINITY;
  const gap = Math.min(later - at, at - earlier);

  const ties = [
    ...(later - at === gap ? timedWithin(timed, later, later) : []),
    ...(at - earlier === gap ? timedWithin(timed, earlier, earlier) : []),
  ];

  return ties.toSorted((a, b) => a.order - b.order)[0]?.item;
};
