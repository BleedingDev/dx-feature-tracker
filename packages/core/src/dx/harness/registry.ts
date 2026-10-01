import { Context, Effect, Layer } from "effect";

import { ClaudeCodeHarness, ClaudeCodeStore } from "./claude-code/index.js";
import { CodexHarness, CodexStore } from "./codex/index.js";
import type {
  Discovery,
  HarnessScope,
  Harness,
  SessionRef,
} from "./contract.js";
import { CursorHarness, CursorStore } from "./cursor/index.js";
import { DeepseekHarness, DeepseekStore } from "./deepseek/index.js";
import { GitRunner } from "./git.js";
import { HarnessHome } from "./home.js";
import type { HarnessId } from "./ids.js";
import { LocalSqlite } from "./local-sqlite.js";
import { OmpHarness, OmpStore } from "./omp/index.js";
import { OpencodeHarness, OpencodeStore } from "./opencode/index.js";
import { PiHarness, PiStore } from "./pi/index.js";

export interface LocateFailure {
  readonly harness: HarnessId;
  readonly reason: string;
}

export interface Located {
  readonly failures: readonly LocateFailure[];
  readonly refs: readonly SessionRef[];
}

export interface HarnessCatalog {
  readonly discover: Effect.Effect<readonly Discovery[]>;
  readonly get: (id: HarnessId) => Harness | null;
  readonly harnesses: readonly Harness[];
  readonly locate: (scope: HarnessScope) => Effect.Effect<Located>;
}

export const harnessCatalog = (
  harnesses: readonly Harness[]
): HarnessCatalog => {
  const locateOne = (scope: HarnessScope) => (harness: Harness) =>
    harness.locate(scope).pipe(
      Effect.match({
        onFailure: (failure): Located => ({
          failures: [{ harness: harness.id, reason: failure.message }],
          refs: [],
        }),
        onSuccess: (refs): Located => ({ failures: [], refs }),
      })
    );

  const locate = (scope: HarnessScope) =>
    Effect.forEach(locateOne(scope))(harnesses).pipe(
      Effect.map((results): Located => ({
        failures: results.flatMap((result) => result.failures),
        refs: results.flatMap((result) => result.refs),
      }))
    );

  return {
    discover: Effect.forEach((harness: Harness) => harness.discover)(harnesses),
    get: (id) => harnesses.find((harness) => harness.id === id) ?? null,
    harnesses,
    locate,
  };
};

export class HarnessRegistry extends Context.Service<
  HarnessRegistry,
  HarnessCatalog
>()("dx/harness/HarnessRegistry", {
  make: Effect.gen(function* buildHarnessRegistry() {
    return harnessCatalog([
      yield* CursorHarness,
      yield* ClaudeCodeHarness,
      yield* CodexHarness,
      yield* OpencodeHarness,
      yield* PiHarness,
      yield* OmpHarness,
      yield* DeepseekHarness,
    ]);
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);

  static readonly fromHarnesses = (
    harnesses: readonly Harness[]
  ): Layer.Layer<HarnessRegistry> =>
    Layer.succeed(this, harnessCatalog(harnesses));
}

export const harnessKitLayer = Layer.mergeAll(
  HarnessHome.layer,
  LocalSqlite.layer,
  GitRunner.layer
);

export const liveHarnessLayers = Layer.mergeAll(
  CursorHarness.layer.pipe(Layer.provide(CursorStore.layer)),
  ClaudeCodeHarness.layer.pipe(Layer.provide(ClaudeCodeStore.layer)),
  CodexHarness.layer.pipe(Layer.provide(CodexStore.layer)),
  OpencodeHarness.layer.pipe(Layer.provide(OpencodeStore.layer)),
  PiHarness.layer.pipe(Layer.provide(PiStore.layer)),
  OmpHarness.layer.pipe(Layer.provide(OmpStore.layer)),
  DeepseekHarness.layer.pipe(Layer.provide(DeepseekStore.layer))
);

export const HarnessRegistryLive = HarnessRegistry.layer.pipe(
  Layer.provide(liveHarnessLayers),
  Layer.provide(harnessKitLayer)
);

export const harnessRegistryFor = (home: string) =>
  HarnessRegistry.layer.pipe(
    Layer.provide(liveHarnessLayers),
    Layer.provide(
      Layer.mergeAll(
        HarnessHome.forHome(home),
        LocalSqlite.layer,
        GitRunner.layer
      )
    )
  );

export const mockHarnessLayers = Layer.mergeAll(
  CursorHarness.mock,
  ClaudeCodeHarness.mock,
  CodexHarness.mock,
  OpencodeHarness.mock,
  PiHarness.mock,
  OmpHarness.mock,
  DeepseekHarness.mock
);

export const registryWith = <A = never, E = never, R = never>(
  ...overrides: readonly Layer.Layer<A, E, R>[]
): Layer.Layer<HarnessRegistry, E, R> =>
  HarnessRegistry.layer.pipe(
    Layer.provide(Layer.mergeAll(mockHarnessLayers, ...overrides))
  );
