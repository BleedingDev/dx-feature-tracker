// @effect-diagnostics nodeBuiltinImport:off -- The usage command test seeds a throwaway store and spawns the built dft binary against it.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { afterAll, describe, expect, it } from "@effect/vitest";
import { EventIdSchema, openSqliteEventStore } from "@rat-stack/core/dx";
import type {
  DxEventEnvelope,
  DxUsageOutputType,
  HarnessId,
} from "@rat-stack/core/dx";
import { Effect, Layer, Schema } from "effect";

import { usageText } from "../src/dft-usage.js";

const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "dft-usage-")));

afterAll(() => {
  rmSync(scratch, { force: true, recursive: true });
});

const repo = path.join(scratch, "app");

const storePath = path.join(scratch, "dft-home", "dft.db");

const cliPath = path.resolve(import.meta.dirname, "../dist/dft-main.js");

const git = (...args: readonly string[]) =>
  execFileSync("git", ["-C", repo, "-c", "core.hooksPath=/dev/null", ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  });

const makeRepo = () => {
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "fixture");
  writeFileSync(path.join(repo, "a.txt"), "app\n");
  git("add", ".");
  git("commit", "-q", "--no-gpg-sign", "-m", "init");
};

makeRepo();

const commonDir = path.join(repo, ".git");

const request = (
  id: string,
  harness: HarnessId,
  model: string,
  occurredAt: string,
  output: number
): DxEventEnvelope => ({
  acquisition: "file-import",
  adapterId: `harness.${harness}`,
  adapterVersion: "fixture",
  ai: {
    agentId: null,
    agentType: null,
    branchSource: "harness-recorded",
    channel: "session-file",
    cwd: repo,
    effort: null,
    effortSource: null,
    harness,
    harnessVersion: "1.0.0",
    model,
    modelRaw: model,
    parentSessionId: null,
    provider: harness === "codex" ? "openai" : "anthropic",
    sessionId: `${harness}-session`,
    via: null,
  },
  context: {
    branch: "main",
    flightId: null,
    headSha: null,
    repoCommonDir: commonDir,
    worktreePath: repo,
  },
  eventId: EventIdSchema.make(id),
  evidence: { bounded: true, hash: null, ref: `fixture:${id}` },
  fieldSemantics: [],
  identity: {
    commitSha: null,
    generationId: null,
    githubAttempt: null,
    githubRunId: null,
    prNumber: null,
    requestId: id,
    sessionId: `${harness}-session`,
    turnId: null,
  },
  kind: "ai.request",
  observedAt: "2026-09-30T12:00:00.000Z",
  occurredAt,
  occurredAtPrecision: "exact",
  origin: "fixture",
  payload: {},
  schemaVersion: "dx.event.v2",
  sourceVersion: null,
  upstreamKey: id,
  usage: {
    premiumRequests: null,
    requestKey: id,
    serviceTier: null,
    speed: null,
    tokens: {
      cacheRead: null,
      cacheWrite: null,
      cacheWrite1h: null,
      cacheWrite5m: null,
      inputFresh: 1000,
      output,
      reasoning: null,
      total: null,
    },
    toolFigure: null,
  },
});

const seed = Effect.acquireUseRelease(
  openSqliteEventStore({ kind: "live", path: storePath }),
  (opened) =>
    opened.service.append({
      coverage: {
        adapterId: "fixture",
        expectedItems: null,
        gaps: [],
        observedItems: 3,
        state: "complete",
        watermark: null,
        windowFrom: null,
        windowTo: null,
      },
      cursor: null,
      events: [
        request(
          "cc-1",
          "claude-code",
          "claude-sonnet-5",
          "2026-09-29T22:30:00.000Z",
          100
        ),
        request(
          "cc-2",
          "claude-code",
          "claude-opus-5",
          "2026-09-30T08:00:00.000Z",
          50
        ),
        request("cx-1", "codex", "gpt-5.5", "2026-09-30T09:00:00.000Z", 10),
      ],
    }),
  (opened) =>
    Effect.sync(() => {
      opened.close();
    })
);

const dft = (args: readonly string[]) =>
  spawnSync(
    process.execPath,
    [cliPath, ...args, "--no-sync", "--db", storePath],
    {
      cwd: repo,
      encoding: "utf-8",
      env: {
        ...process.env,
        DFT_CURSOR_USAGE: "off",
        DFT_HOME: path.join(scratch, "dft-home"),
        HOME: scratch,
      },
    }
  );

const UsageJson = Schema.fromJsonString(
  Schema.Struct({
    groups: Schema.Array(
      Schema.Struct({
        key: Schema.String,
        values: Schema.Record(Schema.String, Schema.NullOr(Schema.Number)),
      })
    ),
    total: Schema.Struct({
      values: Schema.Record(Schema.String, Schema.NullOr(Schema.Number)),
    }),
  })
);

const decodeUsage = Schema.decodeUnknownSync(UsageJson);

it.layer(Layer.effectDiscard(seed).pipe(Layer.provide(NodeServices.layer)))(
  "dft usage",
  (test) => {
    test.effect("groups every tool's requests", () =>
      Effect.sync(() => {
        const byTool = dft(["usage", "--by", "tool", "--json", "--tz", "UTC"]);

        expect(byTool.status).toBe(0);
        expect(
          decodeUsage(byTool.stdout).groups.map((group) => [
            group.key,
            group.values.requests,
            group.values.tokens,
          ])
        ).toEqual([
          ["claude-code", 2, 2150],
          ["codex", 1, 1010],
        ]);
      })
    );

    test.effect("narrows requests by tool", () =>
      Effect.sync(() => {
        const codex = dft(["usage", "--by", "model", "--tool", "codex"]);

        expect(codex.status).toBe(0);
        expect(codex.stdout).toContain("gpt-5.5");
        expect(codex.stdout).not.toContain("claude-sonnet-5");
        expect(codex.stdout).toMatch(/^Total\s+1k\s+1\s/mu);
        expect(codex.stdout).not.toMatch(/[–—]/u);
      })
    );

    test.effect("groups requests by day in the asked time zone", () =>
      Effect.sync(() => {
        const prague = dft([
          "usage",
          "--by",
          "day",
          "--tz",
          "Europe/Prague",
          "--metric",
          "requests",
          "--json",
        ]);

        expect(
          decodeUsage(prague.stdout).groups.map((group) => [
            group.key,
            group.values.requests,
          ])
        ).toEqual([["2026-09-30", 3]]);
      })
    );

    test.effect("narrows requests by the UTC window", () =>
      Effect.sync(() => {
        const window = dft([
          "usage",
          "--since",
          "2026-09-30",
          "--until",
          "2026-10-01",
          "--tz",
          "UTC",
          "--json",
        ]);

        expect(decodeUsage(window.stdout).total.values.requests).toBe(2);
      })
    );

    test.effect("rejects an invalid time zone", () =>
      Effect.sync(() => {
        const badZone = dft(["usage", "--tz", "Mars/Olympus"]);

        expect(badZone.status).not.toBe(0);
      })
    );

    test("answers dft history --group-by with the usage query of this repo", () => {
      const history = dft(["history", "--group-by", "model", "--json"]);

      expect(history.status).toBe(0);
      expect(
        decodeUsage(history.stdout).groups.map((group) => group.key)
      ).toEqual(["claude-sonnet-5", "claude-opus-5", "gpt-5.5"]);
    });
  }
);

const row = (key: string, tokens: number | null, billed: number | null) => ({
  facts: 1,
  key,
  values: { billed, estimate: 0.5, tokens },
});

const output: DxUsageOutputType = {
  asOf: "2026-10-01T12:00:00.000Z",
  bucket: "day",
  contractVersion: "dx.usage.v1",
  coverage: {
    accountBuckets: { facts: 0, key: "account-bucket", values: {} },
    derivationVersion: 2,
    derivedAt: "2026-10-01T12:00:00.000Z",
    disagreements: [{ count: 2, field: "tokens.output", tool: "codex" }],
    facts: 5,
    matched: 5,
    tools: ["codex"],
    unpriced: 0,
    unresolved: 0,
    withoutTime: 0,
  },
  groupBy: "repo",
  groups: [
    row("/home/user/a/repo/.git", 3000, null),
    row("/home/user/b/repo/.git", 2000, 1.25),
  ],
  limit: 2,
  metrics: ["tokens", "estimate", "billed"],
  notes: ["Estimate note.", "Second note."],
  other: { ...row("(other)", 100, null), groups: 2 },
  series: [],
  sortBy: "tokens",
  stackBy: "tool",
  total: row("total", 5200, 1.25),
  unattributed: row("(unattributed)", 100, null),
  window: {
    since: "2026-09-01T00:00:00.000Z",
    tz: "UTC",
    until: null,
  },
};

describe("dft usage text", () => {
  it("names same-named repos by their folder and keeps Other, unattributed and Total apart", () => {
    const text = usageText(output, { verbose: true });

    expect(text).toContain("AI usage, 2026-09-01 to now (UTC), by repo");
    expect(text).toMatch(/^a\/repo\s+3k\s+\$0\.50\s+-$/mu);
    expect(text).toMatch(/^b\/repo\s+2k\s+\$0\.50\s+\$1\.25$/mu);
    expect(text).toMatch(/^Other \(2\)\s+100/mu);
    expect(text).toMatch(/^\(unattributed\)\s+100/mu);
    expect(text).toMatch(/^Total\s+5\.2k/mu);
    expect(text).toContain("Sources disagreed on codex 2 field(s)");
    expect(text).not.toMatch(/[\u2013\u2014]/u);
  });

  it("dates the heading in the asked time zone and names the last day the window holds", () => {
    const prague = usageText(
      {
        ...output,
        window: {
          since: "2026-09-29T22:00:00.000Z",
          tz: "Europe/Prague",
          until: "2026-09-30T22:00:00.000Z",
        },
      },
      { verbose: false }
    );

    const week = usageText(
      {
        ...output,
        window: {
          since: "2026-09-24T22:00:00.000Z",
          tz: "Europe/Prague",
          until: "2026-10-01T10:30:00.000Z",
        },
      },
      { verbose: false }
    );

    expect(prague).toContain("AI usage, 2026-09-30 (Europe/Prague), by repo");
    expect(week).toContain(
      "AI usage, 2026-09-25 to 2026-10-01 (Europe/Prague), by repo"
    );
  });
});
