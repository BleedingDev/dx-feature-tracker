import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { ClaudeCodeHarness } from "../../../src/dx/harness/claude-code/index.js";
import { CodexHarness } from "../../../src/dx/harness/codex/index.js";
import {
  harnessDescriptor,
  toCollector,
} from "../../../src/dx/harness/collector.js";
import { everywhere } from "../../../src/dx/harness/contract.js";
import { DeepseekHarness } from "../../../src/dx/harness/deepseek/index.js";
import { HARNESS_IDS } from "../../../src/dx/harness/ids.js";
import { OmpHarness } from "../../../src/dx/harness/omp/index.js";
import { OpencodeHarness } from "../../../src/dx/harness/opencode/index.js";
import { PiHarness } from "../../../src/dx/harness/pi/index.js";
import {
  HARNESS_META,
  channelRank,
} from "../../../src/dx/harness/precedence.js";
import {
  HarnessRegistry,
  registryWith,
} from "../../../src/dx/harness/registry.js";
import { emptyFlightContext } from "../../../src/dx/model/event.js";
import { buildRegistry } from "../../../src/dx/registry/registry.js";
import { harnessConformance } from "./conformance.js";

harnessConformance("claude-code", registryWith(ClaudeCodeHarness.mock), {
  tier: "mock",
});

harnessConformance("codex", registryWith(CodexHarness.mock), { tier: "mock" });

harnessConformance("opencode", registryWith(OpencodeHarness.mock), {
  tier: "mock",
});

harnessConformance("pi", registryWith(PiHarness.mock), { tier: "mock" });

harnessConformance("omp", registryWith(OmpHarness.mock), { tier: "mock" });

harnessConformance("deepseek", registryWith(DeepseekHarness.mock), {
  tier: "mock",
});

harnessConformance("cursor", registryWith(), { tier: "mock" });

describe("harness registry", () => {
  it.effect("holds one harness per tool, in tool order", () =>
    Effect.gen(function* registryOrder() {
      const registry = yield* HarnessRegistry;

      expect(registry.harnesses.map((harness) => harness.id)).toStrictEqual(
        HARNESS_IDS
      );

      const located = yield* registry.locate(everywhere);

      expect(located).toStrictEqual({ failures: [], refs: [] });

      const discovered = yield* registry.discover;

      expect(discovered.map((entry) => entry.present)).toStrictEqual(
        HARNESS_IDS.map(() => false)
      );
    }).pipe(Effect.provide(registryWith()))
  );

  it("gives every tool its own channel precedence", () => {
    for (const id of HARNESS_IDS) {
      const { channels } = HARNESS_META[id];

      expect(channels.length, id).toBeGreaterThan(0);
      expect(new Set(channels).size, id).toBe(channels.length);
      expect(channelRank(id, channels[0] ?? "hooks"), id).toBe(0);
    }

    expect(channelRank("cursor", "usage-api")).toBeLessThan(
      channelRank("cursor", "hooks")
    );
  });

  it("lists placeholder tools as unsupported collectors until they read sessions", () => {
    const registry = buildRegistry();

    for (const id of HARNESS_IDS.filter((harness) => harness !== "cursor")) {
      const descriptor = harnessDescriptor(id);

      expect(descriptor.readiness, id).toBe(HARNESS_META[id].readiness);
      expect(
        registry.descriptors.some((listed) => listed.id === descriptor.id),
        id
      ).toBe(true);
    }
  });

  it.effect("asks for a session file when collected without input", () =>
    Effect.gen(function* collectWithoutInput() {
      const failure = yield* Effect.flip(
        toCollector("pi").collect({
          adapterId: "harness.pi",
          context: emptyFlightContext,
          cursor: null,
          origin: "fixture",
          scratchDir: null,
          selectedInput: null,
        })
      );

      expect(failure._tag).toBe("InvalidInput");
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer)))
  );
});
