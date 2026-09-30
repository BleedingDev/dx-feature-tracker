// @effect-diagnostics nodeBuiltinImport:off -- This test reads the committed Cursor skill files to check their static routing against the frozen capability contracts.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";

import {
  CapabilityNames,
  DxAnalyzeInput,
  DxExplainInput,
  dxAnalyzeContract,
  dxCollectContract,
  dxEvidenceContract,
  dxExplainContract,
  dxMarkContract,
  dxStatusContract,
} from "../../src/dx/contracts/capabilities.js";

const contracts = {
  dx_analyze: dxAnalyzeContract,
  dx_collect: dxCollectContract,
  dx_evidence: dxEvidenceContract,
  dx_explain: dxExplainContract,
  dx_mark: dxMarkContract,
  dx_status: dxStatusContract,
} as const;

const RoutingSchema = Schema.Struct({
  followUp: Schema.Array(Schema.String),
  inputs: Schema.Array(Schema.String),
  neverCalls: Schema.Array(Schema.String),
  readOnlyPreflight: Schema.String,
  server: Schema.String,
  skill: Schema.String,
  tool: Schema.String,
});

const FrontmatterSchema = Schema.Struct({
  description: Schema.String,
  name: Schema.String,
});

const decodeRouting = Schema.decodeUnknownSync(
  Schema.fromJsonString(RoutingSchema)
);

const decodeFrontmatter = Schema.decodeUnknownSync(FrontmatterSchema);

const readSkill = (name: string) =>
  readFileSync(
    fileURLToPath(
      new URL(`../../../../.cursor/skills/${name}/SKILL.md`, import.meta.url)
    ),
    "utf-8"
  );

const frontmatter = (text: string) => {
  const body = /^---\n(?<body>[\s\S]*?)\n---\n/u.exec(text)?.groups?.body;

  if (body === undefined) {
    throw new Error("missing frontmatter");
  }

  const entries = body.split("\n").flatMap((line) => {
    const groups = /^(?<key>[a-z]+):\s*(?<value>.+)$/u.exec(line)?.groups;

    return groups?.key === undefined || groups.value === undefined
      ? []
      : [[groups.key, groups.value] as const];
  });

  return decodeFrontmatter(Object.fromEntries(entries));
};

const routing = (text: string) => {
  const json = /```json dx-routing\n(?<json>[\s\S]*?)\n```/u.exec(text)?.groups
    ?.json;

  if (json === undefined) {
    throw new Error("missing dx-routing block");
  }

  return decodeRouting(json);
};

const isCapability = (name: string): name is keyof typeof contracts =>
  CapabilityNames.some((capability) => capability === name);

const contractFor = (name: string) => {
  if (!isCapability(name)) {
    throw new Error(`unknown capability ${name}`);
  }

  return contracts[name];
};

const cases = [
  { dir: "dx-analyze", input: DxAnalyzeInput, tool: "dx_analyze" },
  { dir: "dx-explain", input: DxExplainInput, tool: "dx_explain" },
] as const;

describe("B40 Cursor skills static routing", () => {
  for (const { dir, input, tool } of cases) {
    describe(dir, () => {
      const text = readSkill(dir);
      const meta = frontmatter(text);
      const route = routing(text);

      it("has Cursor skill frontmatter matching its directory", () => {
        expect(meta.name).toBe(dir);
        expect(route.skill).toBe(dir);
        expect(meta.description.length).toBeGreaterThan(40);
        expect(meta.description.length).toBeLessThanOrEqual(1024);
        expect(meta.description.toLowerCase()).toContain("branch");
      });

      it("routes to the frozen capability over the rat-stack MCP server", () => {
        expect(route.tool).toBe(tool);
        expect(isCapability(route.tool)).toBe(true);
        expect(contracts[tool].name).toBe(tool);
        expect(route.server).toBe("rat-stack");
        expect(text).toContain("apps/cli/dist/cli.js mcp");
      });

      it("uses exactly the contract input fields and no reserved names", () => {
        expect([...route.inputs].toSorted()).toEqual(
          Object.keys(input.fields).toSorted()
        );
        expect(route.inputs).not.toContain("json");
        expect(route.inputs).not.toContain("yes");
      });

      it("only references real capabilities and never routes to mutations", () => {
        const mentioned = new Set(text.match(/\bdx_[a-z]+\b/gu));

        for (const name of mentioned) {
          expect(isCapability(name), name).toBe(true);
        }

        expect(contractFor(route.readOnlyPreflight).annotations.readOnly).toBe(
          true
        );

        for (const name of route.followUp) {
          expect(isCapability(name), name).toBe(true);
          expect(route.neverCalls).not.toContain(name);
        }

        for (const name of route.neverCalls) {
          expect(contractFor(name).annotations.readOnly).toBe(false);
        }

        expect([...route.neverCalls].toSorted()).toEqual([
          "dx_collect",
          "dx_mark",
        ]);
      });

      it("states the honesty rules", () => {
        expect(text).toContain("unavailable");
        expect(text).toMatch(/never invent|do not infer/iu);
        expect(text).toMatch(/raw prompts/iu);
      });
    });
  }

  it("gives each skill a distinct tool so routing is unambiguous", () => {
    const tools = cases.map(({ dir }) => routing(readSkill(dir)).tool);
    expect(new Set(tools).size).toBe(tools.length);
  });

  it("keeps dx-explain read-only and dx-analyze snapshot-only", () => {
    expect(dxExplainContract.annotations.readOnly).toBe(true);
    expect(dxAnalyzeContract.annotations.idempotent).toBe(true);
  });
});
