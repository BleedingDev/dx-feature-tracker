// @effect-diagnostics nodeBuiltinImport:off -- dft install copies the dx-feature-tracker checkout's Cursor skills into the target project with synchronous node:fs reads.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

export interface DftSkill {
  readonly body: string;
  readonly name: string;
}

export const skillsSourceDir = (): string => {
  const bundled = path.resolve(import.meta.dirname, "skills");

  return existsSync(bundled)
    ? bundled
    : path.resolve(import.meta.dirname, "..", "..", "..", ".cursor", "skills");
};

export const loadSkills = (
  dir: string = skillsSourceDir()
): readonly DftSkill[] => {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name, "SKILL.md"))
      .filter((file) => existsSync(file))
      .map((file) => ({
        body: readFileSync(file, "utf-8"),
        name: path.basename(path.dirname(file)),
      }));
  } catch {
    return [];
  }
};

export const skillDigest = (body: string): string =>
  createHash("sha256").update(body).digest("hex");

export const RELEASED_SKILL_DIGESTS: ReadonlySet<string> = new Set([
  "1456a2d72b016fd7b20eccd84db9d84b5b8ba497ad9631520189048b0a2d3a43",
  "2b9393c62396f02a2ae9a3d79c368a9b0ebc9e734f699875437438eec71c6005",
  "36a8844fe0d10800f13a055172df07b185802fa02d5048b8ebc746c1f6cbe5f1",
  "3fd07f5c2fb397e8a793e23b9a5b8739a2407a9dde797e716e0addffbfb2552f",
  "744c71e6f2e6e3f6a1b97fe7786350f58c29c5b4ad1ef65f205a82033d9f04fd",
  "7c8f428c1eb65e57130be09dec64e3186838a5ca30cbd900a0ada3c2ae72c394",
  "8d1fa57e3b25d7ef1365ec293e8104c3863aeba9db681120b2884f02df96bdd9",
  "bc5c197c2b5b88a89fc4d0ff64e64397f8588d1338d7d186a53cc23a24bdab36",
]);
