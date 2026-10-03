import { Effect } from "effect";

export interface AuditWork {
  readonly decodedBytes: number | null;
  readonly examinedRows: number | null;
  readonly requests: number | null;
}

export interface AuditMeasurement extends AuditWork {
  readonly cache: "cold" | "warm";
  readonly capabilityCalls: 1;
  readonly calls: number;
  readonly elapsedMs: number;
  readonly outputBytes: number;
  readonly peakMemory: null;
  readonly peakMemoryReason: string;
  readonly task: string;
}

export const measureAuditTask = <A, E, R>(
  task: string,
  cache: AuditMeasurement["cache"],
  call: Effect.Effect<A, E, R>,
  work: (output: A) => AuditWork,
  calls: () => number,
  measurements: AuditMeasurement[]
): Effect.Effect<A, E, R> =>
  Effect.gen(function* measuresFixtureTask() {
    const beforeCalls = calls();
    const started = performance.now();

    const output = yield* call.pipe(
      Effect.tapError(() => Effect.log(`S06 task failed: ${task} (${cache})`))
    );

    const elapsedMs = performance.now() - started;
    measurements.push({
      ...work(output),
      cache,
      calls: calls() - beforeCalls,
      capabilityCalls: 1,
      elapsedMs,
      outputBytes: new TextEncoder().encode(JSON.stringify(output)).byteLength,
      peakMemory: null,
      peakMemoryReason:
        "The shared Vitest process does not provide a task-attributable memory peak.",
      task,
    });

    return output;
  });
