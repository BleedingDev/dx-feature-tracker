// @effect-diagnostics nodeBuiltinImport:off -- This test owns a temporary DFT_HOME and reads the file modes dft leaves on its store, backups and config.
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { writeLiveConfig } from "../../src/dx/live/config.js";
import { backupsDir, configPath, liveHome } from "../../src/dx/live/home.js";
import { resetStore } from "../../src/dx/live/store-admin.js";
import { openSqliteEventStore } from "../../src/dx/storage/sqlite-event-store.js";

const scratch = mkdtempSync(path.join(os.tmpdir(), "dft-private-files-"));

afterAll(() => {
  rmSync(scratch, { force: true, recursive: true });
});

const modeOf = (file: string): string =>
  (statSync(file).mode % 0o1000).toString(8);

const fixtureBatch = {
  coverage: {
    adapterId: "fixture",
    expectedItems: null,
    gaps: [],
    observedItems: 0,
    state: "complete" as const,
    watermark: null,
    windowFrom: null,
    windowTo: null,
  },
  cursor: null,
  events: [],
};

const touchStore = (storePath: string) =>
  Effect.acquireUseRelease(
    openSqliteEventStore({ kind: "live", path: storePath }),
    (opened) => opened.service.append(fixtureBatch),
    (opened) =>
      Effect.sync(() => {
        opened.close();
      })
  );

const storeFiles = (storePath: string): readonly string[] =>
  ["", "-wal", "-shm"].flatMap((suffix) => {
    const file = `${storePath}${suffix}`;

    return existsSync(file) ? [file] : [];
  });

describe("dft keeps its data private to the user", () => {
  it.effect("creates a fresh home and store that only the owner can read", () =>
    Effect.gen(function* fresh() {
      const home = liveHome(path.join(scratch, "fresh", ".dft"));

      yield* touchStore(home.storePath);
      yield* writeLiveConfig(home, { cursorUsageImport: false, repos: [] });

      expect(modeOf(home.dftHome)).toBe("700");
      expect(storeFiles(home.storePath).map(modeOf)).toEqual(
        storeFiles(home.storePath).map(() => "600")
      );
      expect(modeOf(configPath(home))).toBe("600");
    })
  );

  it.effect("tightens a store an older dft left readable by others", () =>
    Effect.gen(function* older() {
      const home = liveHome(path.join(scratch, "older"));

      yield* touchStore(home.storePath);

      for (const file of storeFiles(home.storePath)) {
        chmodSync(file, 0o644);
      }

      yield* touchStore(home.storePath);

      expect(storeFiles(home.storePath).map(modeOf)).toEqual(
        storeFiles(home.storePath).map(() => "600")
      );
    })
  );

  it.effect("keeps store backups private", () =>
    Effect.gen(function* backups() {
      const home = liveHome(path.join(scratch, "backups"));

      yield* touchStore(home.storePath);

      const reset = yield* resetStore(home, "reset");
      const dir = backupsDir(home);

      expect(modeOf(dir)).toBe("700");
      expect(modeOf(reset.backup.path)).toBe("600");
      expect(
        readdirSync(dir).map((name) => modeOf(path.join(dir, name)))
      ).toEqual(readdirSync(dir).map(() => "600"));
    })
  );
});
