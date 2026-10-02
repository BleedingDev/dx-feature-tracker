// @effect-diagnostics nodeBuiltinImport:off -- Black-box checks of the built dft binary: they spawn dist/dft-main.js with a throwaway home and read stdout.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";

import { USAGE_BY_CHOICES } from "../src/dft-usage.js";
import { VERSION } from "../src/version.js";

const dftMain = path.resolve(import.meta.dirname, "..", "dist", "dft-main.js");

const scratch = mkdtempSync(path.join(tmpdir(), "dft-surfaces-"));

const home = path.join(scratch, "home");

const dftHome = path.join(scratch, "dft-home");

mkdirSync(home);

afterAll(() => {
  rmSync(scratch, { force: true, recursive: true });
});

const env = {
  ...process.env,
  DFT_CURSOR_USAGE: "off",
  DFT_HOME: dftHome,
  DFT_PRICE_CATALOG: "off",
  HOME: home,
  NO_COLOR: "1",
};

const dft = (args: readonly string[], input?: string) =>
  spawnSync(process.execPath, [dftMain, ...args], {
    cwd: scratch,
    encoding: "utf-8",
    env,
    input,
    timeout: 15_000,
  });

const InitializeResponse = Schema.Struct({
  id: Schema.Literal(1),
  result: Schema.Struct({
    serverInfo: Schema.Struct({ name: Schema.String, version: Schema.String }),
  }),
});

const decodeInitialize = Schema.decodeUnknownSync(
  Schema.fromJsonString(InitializeResponse)
);

const initialize = {
  id: 1,
  jsonrpc: "2.0",
  method: "initialize",
  params: {
    capabilities: {},
    clientInfo: { name: "dft-test", version: "0.0.0" },
    protocolVersion: "2025-06-18",
  },
};

const helpOf = (command: string) => {
  const result = dft([command, "--help"]);

  expect(result.status).toBe(0);

  return result.stdout.replaceAll(/\s+/gu, " ");
};

const byLine = (help: string, flag: string) => {
  const start = help.indexOf(`${flag} choice`);

  const choices = help.indexOf("(choices:", start);

  expect(start).toBeGreaterThanOrEqual(0);
  expect(choices).toBeGreaterThan(start);

  return help.slice(start, choices);
};

describe("dft mcp", () => {
  it("introduces itself as dft with the CLI version", () => {
    const result = dft(["mcp"], `${JSON.stringify(initialize)}\n`);

    const line = result.stdout
      .split("\n")
      .find((candidate) => candidate.includes('"id":1'));

    expect(line).toBeDefined();
    expect(decodeInitialize(line ?? "").result.serverInfo).toEqual({
      name: "dft",
      version: VERSION,
    });
    expect(result.stdout).not.toContain("rat-stack");
    expect(readdirSync(home)).toEqual([]);
  });
});

describe("dft --by help", () => {
  it.each([
    ["usage", "--by"],
    ["history", "--group-by"],
  ])("%s %s lists every dimension it accepts", (command, flag) => {
    const description = byLine(helpOf(command), flag);

    for (const choice of USAGE_BY_CHOICES) {
      expect(description).toMatch(new RegExp(`\\b${choice}\\b`, "u"));
    }
  });
});
