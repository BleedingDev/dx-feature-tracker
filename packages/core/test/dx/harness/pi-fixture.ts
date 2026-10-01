// @effect-diagnostics nodeBuiltinImport:off -- The fixture home is copied into an owned temp folder with synchronous node:fs before any layer is built.
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { Layer } from "effect";

import type { MemoryRepo } from "../../../src/dx/harness/git.js";
import { GitRunner } from "../../../src/dx/harness/git.js";
import { HarnessHome } from "../../../src/dx/harness/home.js";
import { PiHarness, PiStore } from "../../../src/dx/harness/pi/index.js";

export const PI_FIXTURE_HOME = path.resolve(
  import.meta.dirname,
  "..",
  "fixtures",
  "harness",
  "pi",
  "home"
);

const FIXTURE_USER_HOME = "/home/user";

const filesUnder = (dir: string): readonly string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true }).flatMap((entry) =>
    entry.isFile() ? [path.join(entry.parentPath, entry.name)] : []
  );

export interface PiFixtureHome {
  readonly home: string;
  readonly remove: () => void;
}

export const installPiFixtureHome = (): PiFixtureHome => {
  const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), "dft-pi-")));

  cpSync(PI_FIXTURE_HOME, home, { recursive: true });

  for (const file of filesUnder(home)) {
    writeFileSync(
      file,
      readFileSync(file, "utf-8").replaceAll(FIXTURE_USER_HOME, home)
    );
  }

  return {
    home,
    remove: () => {
      rmSync(home, { force: true, recursive: true });
    },
  };
};

export const piFixtureRepos = (home: string): readonly MemoryRepo[] => [
  {
    repoCommonDir: path.join(home, "projects", "pi-demo", ".git"),
    worktrees: [
      {
        branch: "feat/pi-switch",
        headSha: null,
        path: path.join(home, "projects", "pi-demo"),
      },
      {
        branch: "feat/pi-two",
        headSha: null,
        path: path.join(home, "projects", "pi-demo-two"),
      },
    ],
  },
];

export const piFixtureHarness = (home: string) =>
  PiHarness.layer.pipe(
    Layer.provide(PiStore.layer),
    Layer.provide(
      Layer.mergeAll(
        HarnessHome.at(home),
        GitRunner.memory(piFixtureRepos(home))
      )
    ),
    Layer.provide(NodeServices.layer)
  );
