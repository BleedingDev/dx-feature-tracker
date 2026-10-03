// @effect-diagnostics nodeBuiltinImport:off -- Built CLI checks spawn an isolated dft process and inspect its JSON output.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { agentRequestFrom } from "../src/dft-session.js";
import type { AgentFlagValues } from "../src/dft-session.js";

const dftMain = path.resolve(import.meta.dirname, "..", "dist", "dft-main.js");

const dft = (args: readonly string[]) => {
  const scratch = mkdtempSync(path.join(tmpdir(), "dft-agent-"));
  const home = path.join(scratch, "home");
  const dftHome = path.join(scratch, "dft-home");

  mkdirSync(home);

  try {
    const result = spawnSync(process.execPath, [dftMain, ...args], {
      cwd: scratch,
      encoding: "utf-8",
      env: {
        ...process.env,
        DFT_CURSOR_USAGE: "off",
        DFT_HOME: dftHome,
        DFT_PRICE_CATALOG: "on",
        HOME: home,
        NO_COLOR: "1",
      },
      timeout: 15_000,
    });

    return {
      ...result,
      priceCatalogExists: existsSync(path.join(dftHome, "price-catalog")),
    };
  } finally {
    rmSync(scratch, { force: true, recursive: true });
  }
};

const decodeStatusEffects = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      effects: Schema.Struct({
        acquisition: Schema.Struct({
          performed: Schema.Boolean,
          receipt: Schema.Null,
          requested: Schema.Boolean,
        }),
        prices: Schema.Struct({
          networkRequests: Schema.Number,
          origin: Schema.String,
          refreshPermitted: Schema.Boolean,
        }),
      }),
    })
  )
);

const decodeAgentContext = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      context: Schema.Struct({
        effectivePolicies: Schema.Struct({
          acquisition: Schema.String,
          derivation: Schema.String,
          learning: Schema.String,
          prices: Schema.String,
        }),
        profileVersion: Schema.String,
      }),
    })
  )
);

const agentOnlyFlags: readonly AgentFlagValues[] = [
  { acquisition: "recorded-only" },
  { basis: "fixture-basis-1" },
  { budgetDecodedBytes: 2048 },
  { budgetElapsedMs: 50 },
  { budgetFacts: 10 },
  { budgetItems: 3 },
  { budgetNetworkRequests: 0 },
  { budgetOutputBytes: 8192 },
  { budgetSeriesBuckets: 2 },
  { budgetStacks: 1 },
  { cursor: "fixture-cursor-1" },
  { derivation: "ready-only" },
  { detail: "summary" },
  { learning: "hidden" },
  { previousBasis: "fixture-basis-0" },
  { prices: "cached-only" },
];

const invalidProfileFlags: readonly AgentFlagValues[] = [
  { agentProfile: "" },
  { agentProfile: "dx.agent.v2" },
  { acquisition: "all-sources", agentProfile: "dx.agent.v1" },
  { agentProfile: "dx.agent.v1", prices: "always-refresh" },
  { agentProfile: "dx.agent.v1", derivation: "all" },
  { agentProfile: "dx.agent.v1", learning: "all-scopes" },
  { agentProfile: "dx.agent.v1", detail: "full" },
  { agentProfile: "dx.agent.v1", basis: "" },
  { agentProfile: "dx.agent.v1", previousBasis: "" },
  { agentProfile: "dx.agent.v1", basis: "x".repeat(257) },
  { agentProfile: "dx.agent.v1", budgetFacts: 0 },
  { agentProfile: "dx.agent.v1", budgetDecodedBytes: 0 },
  { agentProfile: "dx.agent.v1", budgetOutputBytes: 1024 },
  { agentProfile: "dx.agent.v1", budgetItems: 501 },
  { agentProfile: "dx.agent.v1", budgetSeriesBuckets: 367 },
  { agentProfile: "dx.agent.v1", budgetStacks: 51 },
  { agentProfile: "dx.agent.v1", budgetElapsedMs: 60_001 },
  { agentProfile: "dx.agent.v1", budgetNetworkRequests: -1 },
  { agentProfile: "dx.agent.v1", budgetFacts: 1.5 },
  { agentProfile: "dx.agent.v1", budgetFacts: Number.NaN },
  { agentProfile: "dx.agent.v1", budgetFacts: Number.POSITIVE_INFINITY },
];

describe("dft agent profile", () => {
  it.effect("leaves ordinary reads without an agent request", () =>
    Effect.gen(function* ordinaryReads() {
      expect(yield* agentRequestFrom({})).toBeUndefined();
      expect(
        yield* agentRequestFrom({
          agentProfile: undefined,
          basis: undefined,
          budgetNetworkRequests: undefined,
          prices: undefined,
        })
      ).toBeUndefined();
    })
  );

  it.effect("sets bounded recorded-data policies for an explicit profile", () =>
    Effect.gen(function* defaultAgentRequest() {
      const request = yield* agentRequestFrom({ agentProfile: "dx.agent.v1" });

      expect(request).toMatchObject({
        budget: {
          maxDecodedBytes: 1_048_576,
          maxElapsedMs: 5000,
          maxFacts: 1000,
          maxItems: 20,
          maxNetworkRequests: 0,
          maxOutputBytes: 16_384,
          maxSeriesBuckets: 32,
          maxStacks: 8,
        },
        detail: "summary",
        policies: {
          acquisition: "recorded-only",
          derivation: "ready-only",
          learning: "hidden",
          prices: "cached-only",
        },
        profileVersion: "dx.agent.v1",
      });
      expect(request?.basisId).toBeUndefined();
      expect(request?.previousBasisId).toBeUndefined();
    })
  );

  it.effect("preserves explicit policies, budgets and basis selections", () =>
    Effect.gen(function* explicitAgentRequest() {
      const request = yield* agentRequestFrom({
        acquisition: "refresh-selected",
        agentProfile: "dx.agent.v1",
        basis: "fixture-basis-1",
        budgetDecodedBytes: 2048,
        budgetElapsedMs: 50,
        budgetFacts: 10,
        budgetItems: 3,
        budgetNetworkRequests: 1,
        budgetOutputBytes: 8192,
        budgetSeriesBuckets: 2,
        budgetStacks: 1,
        derivation: "bounded-refresh",
        detail: "expanded",
        learning: "selected-scope",
        previousBasis: "fixture-basis-0",
        prices: "pinned",
      });

      expect(request).toMatchObject({
        basisId: "fixture-basis-1",
        budget: {
          maxDecodedBytes: 2048,
          maxElapsedMs: 50,
          maxFacts: 10,
          maxItems: 3,
          maxNetworkRequests: 1,
          maxOutputBytes: 8192,
          maxSeriesBuckets: 2,
          maxStacks: 1,
        },
        detail: "expanded",
        policies: {
          acquisition: "refresh-selected",
          derivation: "bounded-refresh",
          learning: "selected-scope",
          prices: "pinned",
        },
        previousBasisId: "fixture-basis-0",
        profileVersion: "dx.agent.v1",
      });
    })
  );

  it.effect.each(agentOnlyFlags)(
    "rejects agent-only flags without a profile %#",
    (flags) =>
      Effect.gen(function* missingAgentProfile() {
        const error = yield* agentRequestFrom(flags).pipe(Effect.flip);

        expect(error._tag).toBe("InvalidInput");
        expect(error.field).toBe("agent-profile");
        expect(error.message).toContain("--agent-profile dx.agent.v1");
      })
  );

  it.effect.each(invalidProfileFlags)(
    "rejects unsupported or unbounded profile values %#",
    (flags) =>
      Effect.gen(function* invalidAgentProfile() {
        const error = yield* agentRequestFrom(flags).pipe(Effect.flip);

        expect(error._tag).toBe("InvalidInput");
        expect(error.field).toBe("agent-profile");
        expect(error.message).toMatch(/unsupported/iu);
        expect(error.message.length).toBeLessThanOrEqual(256);
      })
  );
});

describe("built dft read profile", () => {
  it("reports skipped pricing and acquisition for a cheap status read", () => {
    const result = dft(["status", "--summary", "--json"]);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(decodeStatusEffects(result.stdout).effects).toEqual({
      acquisition: { performed: false, receipt: null, requested: false },
      prices: {
        networkRequests: 0,
        origin: "skipped",
        refreshPermitted: false,
      },
    });
    expect(result.priceCatalogExists).toBe(false);
  });

  it("acknowledges the profile and effective read policies in status context", () => {
    const result = dft([
      "status",
      "--summary",
      "--json",
      "--agent-profile",
      "dx.agent.v1",
    ]);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(decodeAgentContext(result.stdout).context).toEqual({
      effectivePolicies: {
        acquisition: "recorded-only",
        derivation: "ready-only",
        learning: "hidden",
        prices: "cached-only",
      },
      profileVersion: "dx.agent.v1",
    });
    expect(result.priceCatalogExists).toBe(false);
  });

  it("continues a retained analyze cursor from another cwd and validates explicit repo selectors", () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "dft-agent-cursor-"));
    const originalRepo = path.join(scratch, "original-repo");
    const conflictingRepo = path.join(scratch, "conflicting-repo");
    const storePath = path.join(scratch, "dft.db");

    mkdirSync(originalRepo);
    mkdirSync(conflictingRepo);

    const args = [
      "analyze",
      "--agent-profile",
      "dx.agent.v1",
      "--derivation",
      "bounded-refresh",
      "--budget-items",
      "1",
      "--budget-output-bytes",
      "65536",
      "--db",
      storePath,
    ];

    const decodePage = Schema.decodeUnknownSync(
      Schema.fromJsonString(
        Schema.Struct({
          context: Schema.Struct({
            basisId: Schema.String,
            resultDigest: Schema.NullOr(Schema.String),
            scope: Schema.Struct({ repoId: Schema.NullOr(Schema.String) }),
          }),
          result: Schema.Struct({ id: Schema.String }),
          view: Schema.Struct({
            items: Schema.Array(
              Schema.Struct({ ref: Schema.Struct({ id: Schema.String }) })
            ),
            nextCursor: Schema.NullOr(Schema.String),
          }),
        })
      )
    );

    try {
      const first = dft([...args, "--repo", originalRepo]);

      expect(first.error).toBeUndefined();
      expect(first.status).toBe(0);

      const firstPage = decodePage(first.stdout);
      const cursor = firstPage.view.nextCursor;

      expect(cursor).not.toBeNull();

      if (cursor === null) {
        throw new Error("The first analyze page must offer a retained cursor.");
      }

      const resumed = dft([...args, "--cursor", cursor]);

      expect(resumed.error).toBeUndefined();
      expect(resumed.status).toBe(0);

      const resumedPage = decodePage(resumed.stdout);

      expect(resumedPage.context).toEqual(firstPage.context);
      expect(resumedPage.result.id).toBe(firstPage.result.id);
      expect(resumedPage.view.items).toHaveLength(1);
      expect(resumedPage.view.items[0]?.ref.id).not.toBe(
        firstPage.view.items[0]?.ref.id
      );
      expect(firstPage.context.scope.repoId).toBe(originalRepo);
      expect(first.priceCatalogExists).toBe(false);
      expect(resumed.priceCatalogExists).toBe(false);

      const conflicting = dft([
        ...args,
        "--cursor",
        cursor,
        "--repo",
        conflictingRepo,
      ]);

      expect(conflicting.error).toBeUndefined();
      expect(conflicting.status).not.toBe(0);
      expect(`${conflicting.stdout}\n${conflicting.stderr}`).toMatch(
        /scope|selector|cursor/iu
      );
      expect(conflicting.priceCatalogExists).toBe(false);
    } finally {
      rmSync(scratch, { force: true, recursive: true });
    }
  });

  it("rejects an unsupported profile before initializing the price catalog", () => {
    const result = dft([
      "status",
      "--summary",
      "--json",
      "--agent-profile",
      "dx.agent.v2",
    ]);

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(
      /unsupported agent profile/iu
    );
    expect(result.priceCatalogExists).toBe(false);
  });
});
