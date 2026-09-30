// @effect-diagnostics nodeBuiltinImport:off -- dft install copies the dx-feature-tracker checkout's Cursor skills into the target project with synchronous node:fs reads.
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
