// @effect-diagnostics nodeBuiltinImport:off -- The test scripts a throwaway git repo and DFT_HOME, spawns the built dft binary and reads the file modes it leaves behind.
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "@effect/vitest";

const scratch = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "dft-private-home-"))
);

afterAll(() => {
  fs.rmSync(scratch, { force: true, recursive: true });
});

const dftHome = path.join(scratch, "dft-home");

const repo = path.join(scratch, "app");

const cliPath = path.resolve(import.meta.dirname, "../dist/dft-main.js");

const git = (...args: readonly string[]) =>
  execFileSync("git", ["-C", repo, "-c", "core.hooksPath=/dev/null", ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  });

const makeRepo = () => {
  fs.mkdirSync(repo);
  git("init", "-q", "-b", "main");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "fixture");
  fs.writeFileSync(path.join(repo, "a.txt"), "app\n");
  git("add", ".");
  git("commit", "-q", "--no-gpg-sign", "-m", "init");
};

makeRepo();

const dft = (...args: readonly string[]) =>
  spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repo,
    encoding: "utf-8",
    env: {
      ...process.env,
      DFT_CURSOR_USAGE: "off",
      DFT_HOME: dftHome,
      DFT_PRICE_CATALOG: "off",
      HOME: scratch,
    },
  });

const modeOf = (file: string): string =>
  (fs.statSync(file).mode % 0o1000).toString(8);

describe("dft home privacy", () => {
  it("tightens a home an older dft left readable and saves pages privately", () => {
    fs.mkdirSync(dftHome, { mode: 0o755 });
    fs.chmodSync(dftHome, 0o755);

    const saved = dft("dashboard", "--one-time", "--no-open", "--json");

    expect(saved.status).toBe(0);
    expect(modeOf(dftHome)).toBe("700");
    expect(modeOf(path.join(dftHome, "dft.db"))).toBe("600");
    expect(modeOf(path.join(dftHome, "dashboard.html"))).toBe("600");
  });
});
