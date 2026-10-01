// @effect-diagnostics nodeBuiltinImport:off -- The opt-in live tier spawns DeepSeek Harness in an owned temp DSH_HOME and reads what it wrote.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { afterAll, describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";

import { everywhere } from "../../../src/dx/harness/contract.js";
import type { SessionRef } from "../../../src/dx/harness/contract.js";
import {
  DeepseekHarness,
  DeepseekStore,
} from "../../../src/dx/harness/deepseek/index.js";
import { HarnessHome } from "../../../src/dx/harness/home.js";
import {
  harnessKitLayer,
  registryWith,
} from "../../../src/dx/harness/registry.js";
import { emptyFlightContext } from "../../../src/dx/model/event.js";
import { harnessConformance, liveHarnesses } from "./conformance.js";

const ROUTER = "http://127.0.0.1:8790";

const ROUTER_MODEL = "claude-luna";

const optedIn = liveHarnesses().includes("deepseek");

const liveDeepseek = Layer.fresh(DeepseekHarness.layer).pipe(
  Layer.provide(DeepseekStore.layer),
  Layer.provide(harnessKitLayer),
  Layer.provide(NodeServices.layer)
);

harnessConformance("deepseek", registryWith(liveDeepseek), {
  maxSessions: 200,
  scope: everywhere,
  tier: "live",
});

const protoInstalls = (): readonly string[] => {
  const root = path.join(os.homedir(), ".proto", "tools", "node");

  try {
    return readdirSync(root)
      .toSorted()
      .toReversed()
      .map((version) => path.join(root, version, "bin", "dsh"));
  } catch {
    return [];
  }
};

const findDsh = (): string | null => {
  const found = spawnSync("sh", ["-c", "command -v dsh"], {
    encoding: "utf-8",
  });

  const fromPath = found.status === 0 ? found.stdout.trim() : "";

  return fromPath === ""
    ? (protoInstalls().find((candidate) => existsSync(candidate)) ?? null)
    : fromPath;
};

// @effect-diagnostics-next-line asyncFunction:off -- the opt-in live tier probes the local router once, before any test runs.
const routerUp = async (): Promise<boolean> => {
  try {
    // @effect-diagnostics-next-line globalFetch:off -- a one-off reachability probe of the local router, outside any Effect program.
    const response = await fetch(`${ROUTER}/v1/models`, {
      signal: AbortSignal.timeout(2000),
    });

    return response.ok;
  } catch {
    return false;
  }
};

const dsh = optedIn ? findDsh() : null;

const ready = dsh !== null && (await routerUp());

const base = mkdtempSync(path.join(os.tmpdir(), "dft-deepseek-live-"));

afterAll(() => {
  rmSync(base, { force: true, recursive: true });
});

const OVERLAY = `- id: llm-pi-ai
  config:
    providers:
      local-router:
        displayName: Local Router
        apiKeyEnv: DSH_PROBE_KEY
        api: anthropic-messages
        baseURL: ${ROUTER}
        models:
          - id: ${ROUTER_MODEL}
            name: Luna via local router
            contextWindow: 200000
            reasoningEfforts: false
- id: agent-default-model
  config:
    provider: local-router
    model: ${ROUTER_MODEL}
`;

const StepEndSchema = Schema.Struct({
  phase: Schema.Literal("step_end"),
  usage: Schema.Struct({
    cacheReadTokens: Schema.optional(Schema.Finite),
    cacheWriteTokens: Schema.optional(Schema.Finite),
    inputTokens: Schema.Finite,
    outputTokens: Schema.Finite,
  }),
});

const decodeStepEnd = Schema.decodeUnknownOption(
  Schema.fromJsonString(StepEndSchema)
);

const runDsh = (binary: string, dshHome: string, cwd: string) => {
  const overlay = path.join(base, "router.patch.yml");
  const sibling = path.join(path.dirname(binary), "node");

  writeFileSync(overlay, OVERLAY);

  const args = [
    "--profile",
    "headless",
    "--patch",
    overlay,
    "--json",
    "Reply with exactly the word: ok. Do not use tools.",
  ];

  const result = existsSync(sibling)
    ? spawnSync(sibling, [binary, ...args], {
        cwd,
        encoding: "utf-8",
        env: { ...process.env, DSH_HOME: dshHome, DSH_PROBE_KEY: "local" },
        timeout: 240_000,
      })
    : spawnSync(binary, args, {
        cwd,
        encoding: "utf-8",
        env: { ...process.env, DSH_HOME: dshHome, DSH_PROBE_KEY: "local" },
        timeout: 240_000,
      });

  const steps = result.stdout
    .split("\n")
    .flatMap((line) => Option.toArray(decodeStepEnd(line)));

  return {
    status: result.status,
    total: steps.reduce(
      (sum, step) =>
        sum +
        step.usage.inputTokens +
        step.usage.outputTokens +
        (step.usage.cacheReadTokens ?? 0) +
        (step.usage.cacheWriteTokens ?? 0),
      0
    ),
  };
};

describe.skipIf(!ready)("DeepSeek live run through the local router", () => {
  it.effect(
    "reads the session dsh just wrote with the totals dsh reported",
    () =>
      Effect.gen(function* liveRun() {
        const dshHome = path.join(base, "dsh");
        const cwd = path.join(base, "work");

        mkdirSync(cwd, { recursive: true });

        const run = runDsh(dsh ?? "dsh", dshHome, cwd);

        expect(run.status).toBe(0);
        expect(run.total).toBeGreaterThan(0);

        const events = yield* Effect.gen(function* readLive() {
          const harness = yield* DeepseekHarness;
          const refs = yield* harness.locate(everywhere);

          const batches = yield* Effect.forEach((ref: SessionRef) =>
            harness.read(ref, {
              context: emptyFlightContext,
              cursor: null,
              origin: "live",
            })
          )(refs);

          return batches.flatMap((batch) => batch.events);
        }).pipe(
          Effect.provide(
            Layer.fresh(DeepseekHarness.layer).pipe(
              Layer.provide(DeepseekStore.layer),
              Layer.provide(HarnessHome.at(base, { DSH_HOME: dshHome })),
              Layer.provide(NodeServices.layer)
            )
          )
        );

        const usage = events.filter((event) => event.kind === "ai.usage");

        expect(
          usage.reduce(
            (sum, event) => sum + (event.usage?.tokens.total ?? 0),
            0
          )
        ).toBe(run.total);

        for (const event of usage) {
          expect(event.ai?.via).toBe("local-router");
          expect(event.ai?.modelRaw).not.toBeNull();
          expect(event.payload.modelRequested).toBe(ROUTER_MODEL);
        }
      }),
    { timeout: 300_000 }
  );
});
