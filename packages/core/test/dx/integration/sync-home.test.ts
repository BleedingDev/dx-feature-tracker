// @effect-diagnostics nodeBuiltinImport:off -- This test owns a temporary home with a Git repository, a Cursor transcript folder and a SQLite store.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { afterAll, describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  CURSOR_ACCOUNT_OFF_REASON,
  CURSOR_ACCOUNT_SOURCE,
} from "../../../src/dx/composition.js";
import { cursorProjectSlug } from "../../../src/dx/harness/cursor/sources.js";
import { allCollectors } from "../../../src/dx/registry/registry.js";
import { autoSync } from "../../../src/dx/registry/sync.js";
import { openSqliteEventStore } from "../../../src/dx/storage/sqlite-event-store.js";

const scratch = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "dft-sync-home-"))
);

afterAll(() => {
  fs.rmSync(scratch, { force: true, recursive: true });
});

const repo = path.join(scratch, "work", "app");

const git = (...args: readonly string[]): string =>
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8" });

fs.mkdirSync(repo, { recursive: true });

git("init", "-q", "-b", "main");

git("config", "user.email", "fixture@example.invalid");

git("config", "user.name", "fixture");

fs.writeFileSync(path.join(repo, "a.txt"), "a\n");

git("add", ".");

git("commit", "-qm", "init");

const transcripts = path.join(
  scratch,
  ".cursor",
  "projects",
  cursorProjectSlug(repo),
  "agent-transcripts"
);

fs.mkdirSync(transcripts, { recursive: true });

fs.copyFileSync(
  path.join(
    import.meta.dirname,
    "..",
    "fixtures",
    "b07",
    "projects",
    "demo",
    "agent-transcripts",
    "comp-T.txt"
  ),
  path.join(transcripts, "comp-T.txt")
);

describe("sync reads tools from the home it is given", () => {
  it.effect(
    "finds the transcript under the given home and never looks in the user's home",
    () =>
      Effect.gen(function* syncSandbox() {
        const storePath = path.join(scratch, "dft", "dft.db");
        fs.mkdirSync(path.dirname(storePath), { recursive: true });

        const opened = yield* openSqliteEventStore({
          kind: "live",
          path: storePath,
        });

        const report = yield* autoSync(opened.service, allCollectors, {
          cwd: repo,
          dftHome: path.join(scratch, "dft"),
          home: scratch,
          repo,
          storePath,
        });

        opened.close();

        const transcript = report.steps.find(
          (step) => step.source === "collector.cursor-transcripts"
        );

        expect(transcript?.input).toBe(path.join(transcripts, "comp-T.txt"));
        expect(transcript?.status).toBe("synced");

        const outside = report.steps.flatMap((step) =>
          step.input === null ||
          step.input.startsWith(scratch) ||
          step.input.startsWith("https://")
            ? []
            : [step.input]
        );

        expect(outside).toStrictEqual([]);

        expect(
          report.steps.filter(
            (step) => step.source === CURSOR_ACCOUNT_SOURCE.source
          )
        ).toStrictEqual([
          {
            duplicates: null,
            input: CURSOR_ACCOUNT_SOURCE.input,
            inserted: null,
            reason: CURSOR_ACCOUNT_OFF_REASON,
            source: CURSOR_ACCOUNT_SOURCE.source,
            status: "unavailable",
          },
        ]);
      }).pipe(Effect.provide(NodeServices.layer))
  );
});
