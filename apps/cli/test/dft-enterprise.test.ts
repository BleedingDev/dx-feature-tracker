// @effect-diagnostics nodeBuiltinImport:off -- Black-box checks of the built dft binary: they spawn dist/dft-main.js in a throwaway git repo and read stdout.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "@effect/vitest";

import { liveDashboardPage } from "../src/dft-live-page.js";
import {
  ENTERPRISE_EMAIL,
  ENTERPRISE_LINKEDIN,
  enterpriseLine,
  withEnterpriseLine,
} from "../src/dft-render.js";

const dftMain = path.resolve(import.meta.dirname, "..", "dist", "dft-main.js");

const scratch = mkdtempSync(path.join(tmpdir(), "dft-enterprise-"));

const home = path.join(scratch, "home");

const repo = path.join(scratch, "repo");

mkdirSync(home);

execFileSync("git", ["init", "-q", "-b", "main", repo]);

execFileSync(
  "git",
  [
    "-c",
    "user.name=dft",
    "-c",
    "user.email=dft@example.invalid",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init",
  ],
  { cwd: repo }
);

afterAll(() => {
  rmSync(scratch, { force: true, recursive: true });
});

const dft = (...args: string[]): string => {
  const result = spawnSync(process.execPath, [dftMain, ...args], {
    cwd: repo,
    encoding: "utf-8",
    env: { ...process.env, DFT_HOME: home, HOME: home, NO_COLOR: "1" },
  });

  expect(result.status).toBe(0);

  return result.stdout;
};

const PLAIN = enterpriseLine();

describe("dft enterprise line", () => {
  it("names both contacts with plain URLs and dims only on request", () => {
    expect(PLAIN).toBe(
      `Want it for your whole company? All repos, all features, all people. Write me: LinkedIn ${ENTERPRISE_LINKEDIN} or email ${ENTERPRISE_EMAIL}`
    );
    expect(PLAIN).not.toMatch(/[–—]/u);
    expect(enterpriseLine(true)).toBe(`\u001B[2m${PLAIN}\u001B[22m`);
    expect(withEnterpriseLine("table")).toBe(`table\n\n${PLAIN}`);
  });

  it("ends top-level help, and only top-level help", () => {
    expect(dft("--help").trimEnd().endsWith(PLAIN)).toBe(true);
    expect(dft().trimEnd().endsWith(PLAIN)).toBe(true);
    expect(dft("history", "--help")).not.toContain("whole company");
  });

  it("follows history text but never json, oneline or line output", () => {
    expect(dft("history", "--no-sync").trimEnd().endsWith(PLAIN)).toBe(true);
    expect(dft("history", "--no-sync", "--json")).not.toContain(
      "whole company"
    );
    expect(dft("history", "--no-sync", "--oneline")).not.toContain(
      "whole company"
    );
    expect(dft("line", "--no-sync")).not.toContain("whole company");
  });

  it("puts one quiet footer link pair in the live dashboard", () => {
    const html = liveDashboardPage("token");

    const footer = html.slice(
      html.indexOf('<footer class="foot">'),
      html.indexOf("</footer>")
    );

    expect(html.match(/whole company/gu)).toHaveLength(1);
    expect(footer).toContain("whole company");
    expect(footer).toContain(
      `<a href="${ENTERPRISE_LINKEDIN}" target="_blank" rel="noopener">LinkedIn</a>`
    );
    expect(footer).toContain(
      `<a href="mailto:${ENTERPRISE_EMAIL}" target="_blank" rel="noopener">email</a>`
    );
  });
});
