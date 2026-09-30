import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";

import {
  classifyInterval,
  closeOpenIntervalAt,
  intervalHelpers,
  intervalsDescriptor,
} from "../../src/dx/metrics/intervals/intervals.js";
import { ModuleDescriptorSchema } from "../../src/dx/model/descriptor.js";
import type { Interval } from "../../src/dx/model/interval.js";
import {
  IntervalSchema,
  IntervalUnionResultSchema,
} from "../../src/dx/model/interval.js";

const CaseSchema = Schema.Struct({
  expect: Schema.Struct({
    sum: Schema.Struct({
      excluded: Schema.Int,
      totalMs: Schema.NullOr(Schema.Finite),
    }),
    union: IntervalUnionResultSchema,
  }),
  id: Schema.String,
  intervals: Schema.Array(IntervalSchema),
});

const CasesFileSchema = Schema.Struct({
  cases: Schema.Array(CaseSchema),
});

const loadCases = Effect.gen(function* loadCases() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const text = yield* fs.readFileString(
    path.join(import.meta.dirname, "fixtures", "b27", "cases.json")
  );

  return yield* Schema.decodeEffect(Schema.fromJsonString(CasesFileSchema))(
    text
  );
});

const iv = (startMs: number | null, endMs: number | null): Interval =>
  Schema.decodeSync(IntervalSchema)({
    endMs,
    evidenceIds: [],
    label: "t",
    startMs,
  });

describe("b27 interval helpers", () => {
  it.effect("fixture cases match union and sum expectations", () =>
    Effect.gen(function* fixtureCases() {
      const { cases } = yield* loadCases;
      expect(cases.map((c) => c.id)).toEqual(
        intervalsDescriptor.fixtureIds.filter((id) => id !== "b27-branch-as-of")
      );

      for (const c of cases) {
        expect(intervalHelpers.union(c.intervals), c.id).toEqual(
          c.expect.union
        );
        expect(intervalHelpers.sum(c.intervals), c.id).toEqual(c.expect.sum);
      }
    }).pipe(Effect.provide(NodeServices.layer))
  );

  it("union is order independent", () => {
    const a = [iv(10, 20), iv(0, 5), iv(4, 12), iv(null, 3), iv(9, 1)];
    const b = a.toReversed();
    expect(intervalHelpers.union(a)).toEqual(intervalHelpers.union(b));
    expect(intervalHelpers.union(a).totalMs).toBe(20);
  });

  it("overlap handles disjoint, nested, censored and clock errors", () => {
    expect(intervalHelpers.overlap(iv(0, 10), iv(5, 20))).toBe(5);
    expect(intervalHelpers.overlap(iv(0, 10), iv(2, 3))).toBe(1);
    expect(intervalHelpers.overlap(iv(0, 10), iv(10, 20))).toBe(0);
    expect(intervalHelpers.overlap(iv(0, 10), iv(null, 20))).toBeNull();
    expect(intervalHelpers.overlap(iv(0, 10), iv(8, 2))).toBeNull();
  });

  it("classifies non-finite bounds as censored", () => {
    const bad: Interval = {
      endMs: Number.NaN,
      evidenceIds: [],
      label: "t",
      startMs: 0,
    };

    expect(classifyInterval(bad)).toBe("censored");
    expect(intervalHelpers.sum([bad])).toEqual({ excluded: 1, totalMs: null });
  });

  it("b27-branch-as-of closes only open intervals with a known start", () => {
    const open = iv(1000, null);
    const closed = closeOpenIntervalAt(open, 4000);
    expect(closed).toMatchObject({ endMs: 4000, label: "t@as-of" });
    expect(intervalHelpers.sum([closed]).totalMs).toBe(3000);
    expect(closeOpenIntervalAt(open, 500)).toBe(open);
    expect(closeOpenIntervalAt(iv(null, null), 500).endMs).toBeNull();
    const done = iv(0, 10);
    expect(closeOpenIntervalAt(done, 99)).toBe(done);
  });

  it("descriptor decodes and is ready", () => {
    const decoded = Schema.decodeSync(ModuleDescriptorSchema)(
      intervalsDescriptor
    );

    expect(decoded.readiness).toBe("ready");
    expect(decoded.owner).toBe("B27");
  });
});
