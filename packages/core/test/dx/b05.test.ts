// @effect-diagnostics nodeBuiltinImport:off -- Process-spawning test: it creates a scratch git repo and hook spool directories on disk.
// @effect-diagnostics globalDate:off -- The hook handler contract takes a plain capture Date supplied by the hook process.
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { afterAll, describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { cursorCliCollector } from "../../src/dx/collectors/cursor-cli/collector.js";
import {
  cursorHooksCollector,
  cursorHooksDescriptor,
} from "../../src/dx/collectors/cursor-hooks/collector.js";
import type { GitResolver } from "../../src/dx/collectors/cursor-hooks/handler.js";
import {
  handleCursorHook,
  resolveGitContext,
} from "../../src/dx/collectors/cursor-hooks/handler.js";
import { sanitizeHookPayload } from "../../src/dx/collectors/cursor-hooks/sanitize.js";
import type { CollectInput } from "../../src/dx/contracts/services.js";
import { withCollectorBlocks } from "../../src/dx/harness/collector-blocks.js";
import { accountAiUsage } from "../../src/dx/metrics/ai-usage/ledger.js";
import type { AiUsageAccount } from "../../src/dx/metrics/ai-usage/ledger.js";
import type { DxEventEnvelope } from "../../src/dx/model/event.js";
import { emptyFlightContext } from "../../src/dx/model/event.js";
import { EventIdSchema } from "../../src/dx/model/ids.js";

const fixtureDir = path.join(import.meta.dirname, "fixtures", "b05");

const scratchRoot = mkdtempSync(path.join(tmpdir(), "dft-b05-"));

afterAll(() => {
  rmSync(scratchRoot, { force: true, recursive: true });
});

const fixedGit: GitResolver = () => ({
  branch: "feature/fixture",
  headSha: "0000000000000000000000000000000000000001",
  repoCommonDir: "/fixture/workspace/.git",
  worktreePath: "/fixture/workspace",
});

const binOf = (command: string): string | null =>
  sanitizeHookPayload({
    command,
    hook_event_name: "afterShellExecution",
  })?.commandBin ?? null;

let counter = 0;

const freshSpool = (label: string): string => {
  counter += 1;

  return path.join(scratchRoot, `${label}-${counter}`);
};

const spoolFixture = (fixture: string, spoolDir: string) => {
  const lines = readFileSync(path.join(fixtureDir, fixture), "utf-8")
    .split("\n")
    .filter((line) => line !== "");

  return lines.map((line, index) =>
    handleCursorHook(line, {
      cwd: "/fixture/workspace",
      now: new Date(Date.UTC(2026, 8, 30, 12, 0, index)),
      resolveGit: fixedGit,
      spoolDirFor: () => spoolDir,
    })
  );
};

const spoolLines = (lines: readonly object[], spoolDir: string) =>
  lines.map((line, index) =>
    handleCursorHook(JSON.stringify(line), {
      cwd: "/fixture/workspace",
      now: new Date(Date.UTC(2026, 8, 30, 13, 0, index)),
      resolveGit: fixedGit,
      spoolDirFor: () => spoolDir,
    })
  );

const A07_SESSION = "487a09d4-1638-4add-a548-db653635a61b";

const A07_REQUEST = "6cae283f-4b57-4449-ba6f-33ed59ec5506";

const A07_STREAM = path.join(
  import.meta.dirname,
  "integration",
  "fixtures",
  "a07-live",
  "cursor-cli.stream.jsonl"
);

const stopLine = (fields: Readonly<Record<string, number | string>>) => ({
  conversation_id: "real-shape-conv",
  cursor_version: "2026.09.28-64d2043",
  hook_event_name: "stop",
  loop_count: 0,
  model: "default",
  status: "completed",
  workspace_roots: ["/fixture/workspace"],
  ...fields,
});

const usageEvents = (events: readonly DxEventEnvelope[]) =>
  events.filter((event) => event.kind === "ai.usage");

const tokenTotal = (account: AiUsageAccount, category: string) =>
  account.totals.find(
    (row) => row.ledger === "tokens" && row.category === category
  )?.value ?? null;

const collectInput = (spoolDir: string | null): CollectInput => ({
  adapterId: "cursor-hooks",
  context: emptyFlightContext,
  cursor: null,
  origin: "fixture",
  scratchDir: null,
  selectedInput: spoolDir,
});

describe("B05 cursor hooks collector", () => {
  it.effect("decodes agent turns, tool calls and edits per branch", () =>
    Effect.gen(function* agentTurns() {
      const spoolDir = freshSpool("agent");
      const results = spoolFixture("agent-turns.jsonl", spoolDir);

      expect(
        results.every((result) => result.outcome.state === "spooled")
      ).toBe(true);

      const batch = yield* cursorHooksCollector.collect(collectInput(spoolDir));
      const kinds = batch.events.map((event) => event.kind);

      expect(kinds.filter((kind) => kind === "ai.turn")).toHaveLength(2);
      expect(kinds.filter((kind) => kind === "ai.request")).toHaveLength(2);
      expect(kinds.filter((kind) => kind === "ai.session")).toHaveLength(2);
      expect(
        batch.events.filter((event) => event.payload.toolCall === true)
      ).toHaveLength(2);
      expect(batch.events.every((event) => event.origin === "fixture")).toBe(
        true
      );
      expect(
        batch.events.every(
          (event) => event.context.branch === "feature/fixture"
        )
      ).toBe(true);

      const edit = batch.events.find((event) => event.kind === "ai.tool-edit");

      expect(edit?.payload.linesAdded).toBe(4);
      expect(edit?.payload.linesRemoved).toBe(2);

      const turn = batch.events.find(
        (event) =>
          event.kind === "ai.turn" && event.payload.status === "aborted"
      );

      expect(turn?.identity.turnId).toBe("fixture-conv-1:fixture-gen-2");
      expect(batch.events.some((event) => event.kind === "ai.usage")).toBe(
        false
      );
      expect(batch.coverage.state).toBe("complete");
      expect(batch.coverage.observedItems).toBe(11);
    })
  );

  it("never spools prompt, response, output, command text or email", () => {
    const spoolDir = freshSpool("privacy");

    spoolFixture("agent-turns.jsonl", spoolDir);

    const spooled = readdirSync(spoolDir)
      .map((name) => readFileSync(path.join(spoolDir, name), "utf-8"))
      .join("\n");

    expect(spooled).not.toContain("FIXTURE PROMPT SECRET");
    expect(spooled).not.toContain("FIXTURE RESPONSE BODY");
    expect(spooled).not.toContain("FIXTURE OUTPUT");
    expect(spooled).not.toContain("FIXTURE_SECRET");
    expect(spooled).not.toContain("fixture@example.invalid");
    expect(spooled).toContain('"commandBin":"pnpm"');
  });

  it("keeps only the executable name when a shell command starts with secrets", () => {
    const secret = ["fixture", "Secret", "Value"].join("");

    expect(binOf(`GITHUB_TOKEN=${secret} gh pr list`)).toBe("gh");
    expect(binOf(`PGPASSWORD=${secret} PGHOST=db psql -c 'select 1'`)).toBe(
      "psql"
    );
    expect(binOf(`AWS_SECRET_ACCESS_KEY=a/${secret} aws s3 ls`)).toBe("aws");
    expect(binOf(`TOKEN="one ${secret} two" ./deploy.sh`)).toBe("deploy.sh");
    expect(binOf(`env -i API_KEY=${secret} /usr/bin/curl x`)).toBe("curl");
    expect(binOf(`sudo LOGIN=${secret} make`)).toBe("make");
    expect(binOf(`"${secret} x"`)).toBeNull();
    expect(binOf(`$(${secret})`)).toBeNull();
  });

  it("skips wrapper options and their values to reach the executable", () => {
    const secret = ["fixture", "Secret", "Value"].join("");

    const cases: readonly (readonly [string, string | null])[] = [
      ["sudo -u root gh pr list", "gh"],
      ["sudo -uroot gh", "gh"],
      ["sudo -Eu root gh", "gh"],
      ["sudo -E -H -u deploy -g staff make build", "make"],
      ["sudo --user=root gh", "gh"],
      ["sudo --user root gh", "gh"],
      ["sudo -D /srv -C 4 -T 30 -h host-a ls", "ls"],
      [`sudo -p ${secret} ls`, "ls"],
      ["sudo -- gh", "gh"],
      ["/usr/bin/sudo -n -u root /usr/bin/gh", "gh"],
      ["doas -u root gh", "gh"],
      ["doas -n -u root -- pnpm test", "pnpm"],
      [`env -u ${secret} gh`, "gh"],
      [`env --unset=${secret} gh`, "gh"],
      [`env --unset ${secret} gh`, "gh"],
      ["env -C /srv/app pnpm install", "pnpm"],
      ["env --chdir /srv/app pnpm install", "pnpm"],
      [`env -i -u HOME API_KEY=${secret} node app.js`, "node"],
      ["env -- gh", "gh"],
      [`sudo -u root env -u ${secret} nice -n 10 gh`, "gh"],
      ["nice -n 5 make", "make"],
      ["nice -5 make", "make"],
      ["nice --adjustment=5 make", "make"],
      ["time -p make", "make"],
      ["exec -a renamed node server.js", "node"],
      ["command -p ls", "ls"],
      ["nohup node server.js", "node"],
      ["timeout 30 gh pr list", "gh"],
      ["timeout -s KILL -k 5 30s pnpm test", "pnpm"],
      ["timeout --signal=TERM 1m pnpm test", "pnpm"],
      ["sudo -u root", null],
      ["sudo -l", null],
      ["env", null],
    ];

    for (const [command, expected] of cases) {
      expect(binOf(command), command).toBe(expected);
    }
  });

  it.effect("collapses duplicate stop emissions for one turn", () =>
    Effect.gen(function* duplicateStop() {
      const spoolDir = freshSpool("dup");

      spoolFixture("duplicate-stop.jsonl", spoolDir);

      const batch = yield* cursorHooksCollector.collect(collectInput(spoolDir));

      expect(batch.coverage.observedItems).toBe(2);
      expect(batch.events).toHaveLength(1);
      expect(batch.events[0]?.kind).toBe("ai.turn");
    })
  );

  it.effect("marks Tab edits with the tab surface", () =>
    Effect.gen(function* tabEdit() {
      const spoolDir = freshSpool("tab");

      spoolFixture("tab-edit.jsonl", spoolDir);

      const batch = yield* cursorHooksCollector.collect(collectInput(spoolDir));

      expect(batch.events).toHaveLength(1);
      expect(batch.events[0]?.payload.surface).toBe("tab");
      expect(batch.events[0]?.payload.linesAdded).toBe(2);
    })
  );

  it.effect("keeps stop-hook usage raw and unverified", () =>
    Effect.gen(function* rawUsage() {
      const spoolDir = freshSpool("usage");

      spoolFixture("stop-usage-raw.jsonl", spoolDir);

      const batch = yield* cursorHooksCollector.collect(collectInput(spoolDir));
      const usage = batch.events.find((event) => event.kind === "ai.usage");

      expect(usage?.payload.semanticsVerified).toBe(false);
      expect(usage?.payload.normalizedCategories).toBeNull();
      expect(usage?.payload.rawUsage).toEqual({
        cost_usd: 0.0123,
        "usage.cache_read_tokens": 800,
        "usage.input_tokens": 1200,
        "usage.output_tokens": 340,
      });
      expect(
        usage?.fieldSemantics.every((field) =>
          (field.note ?? "").includes("unverified")
        )
      ).toBe(true);
    })
  );

  it.effect(
    "promotes exact stop-hook tokens for completed, aborted and error turns",
    () =>
      Effect.gen(function* exactTokens() {
        const spoolDir = freshSpool("exact");

        spoolLines(
          [
            stopLine({
              cache_read_tokens: 800,
              cache_write_tokens: 100,
              generation_id: "gen-completed",
              input_tokens: 1500,
              output_tokens: 340,
            }),
            stopLine({
              cache_read_tokens: 800,
              cache_write_tokens: 100,
              generation_id: "gen-completed",
              input_tokens: 1500,
              output_tokens: 340,
            }),
            stopLine({
              cache_read_tokens: 0,
              cache_write_tokens: 0,
              generation_id: "gen-aborted",
              input_tokens: 200,
              model: "gpt-5.5-high",
              output_tokens: 5,
              status: "aborted",
            }),
            stopLine({
              cache_read_tokens: 900,
              cache_write_tokens: 50,
              generation_id: "gen-error",
              input_tokens: 700,
              output_tokens: 0,
              status: "error",
            }),
          ],
          spoolDir
        );

        const batch = yield* cursorHooksCollector.collect(
          collectInput(spoolDir)
        );

        const usage = usageEvents(batch.events);

        expect(batch.coverage.observedItems).toBe(4);
        expect(batch.events).toHaveLength(6);
        expect(
          usage.map((event) => [
            event.identity.generationId,
            event.payload.status,
            event.payload.model,
            event.payload.semanticsVerified,
            event.payload.freshInputClamped,
            event.payload.normalizedCategories,
          ])
        ).toEqual([
          [
            "gen-completed",
            "completed",
            "default",
            true,
            false,
            { cacheWrite: 100, cachedInput: 800, input: 600, output: 340 },
          ],
          [
            "gen-aborted",
            "aborted",
            "gpt-5.5-high",
            true,
            false,
            { cacheWrite: 0, cachedInput: 0, input: 200, output: 5 },
          ],
          [
            "gen-error",
            "error",
            "default",
            true,
            true,
            { cacheWrite: 50, cachedInput: 900, input: 0, output: 0 },
          ],
        ]);

        const clamped = usage[2]?.fieldSemantics.find(
          (field) => field.field === "payload.normalizedCategories.input"
        );

        expect(clamped?.method).toBe("derived");
        expect(clamped?.note).toContain("clamped to 0");

        const account = accountAiUsage(batch.events);

        expect(account.uncovered).toEqual([]);
        expect(account.requestCount).toBe(3);
        expect(
          ["input", "cached-input", "cache-write", "output"].map((category) =>
            tokenTotal(account, category)
          )
        ).toEqual([800, 1700, 150, 345]);
      })
  );

  it.effect(
    "reconciles a stop hook with the a07 cursor-cli result.usage of the same run",
    () =>
      Effect.gen(function* reconcile() {
        const spoolDir = freshSpool("reconcile");

        spoolLines(
          [
            stopLine({
              cache_read_tokens: 66_304,
              cache_write_tokens: 0,
              conversation_id: A07_SESSION,
              generation_id: A07_REQUEST,
              input_tokens: 34_384 + 66_304,
              output_tokens: 710,
            }),
          ],
          spoolDir
        );

        const hooks = yield* cursorHooksCollector.collect(
          collectInput(spoolDir)
        );

        const cli = yield* cursorCliCollector.collect({
          ...collectInput(A07_STREAM),
          adapterId: "cursor-cli",
        });

        const [hookUsage] = usageEvents(hooks.events);
        const [cliUsage] = usageEvents(cli.events);

        expect(cliUsage?.payload.tokens).toMatchObject({
          "cached-input": 66_304,
          input: 34_384,
          output: 710,
        });
        expect(hookUsage?.payload.normalizedCategories).toEqual({
          cacheWrite: 0,
          cachedInput: 66_304,
          input: 34_384,
          output: 710,
        });

        const account = accountAiUsage([...hooks.events, ...cli.events]);

        expect(account.requestCount).toBe(1);
        expect(
          ["input", "cached-input", "cache-write", "output"].map((category) =>
            tokenTotal(account, category)
          )
        ).toEqual([34_384, 66_304, 0, 710]);
        expect(account.groups.map((group) => group.reason)).toEqual([
          "same request/turn reported by cursor-cli, hooks-stop; per-field source precedence applied",
        ]);

        const dashboard = usageEvents(cli.events).map(
          (event): DxEventEnvelope =>
            withCollectorBlocks({
              ...event,
              adapterId: "cursor-dashboard-response",
              eventId: EventIdSchema.make("dashboard-row"),
              identity: {
                ...event.identity,
                requestId: A07_REQUEST,
                sessionId: null,
              },
              payload: {
                requestKey: `request:${A07_REQUEST}`,
                sourceKind: "dashboard-json",
                tokens: { "cached-input": 66_000, input: 34_000, output: 700 },
              },
            })
        );

        const billed = accountAiUsage([
          ...hooks.events,
          ...cli.events,
          ...dashboard,
        ]);

        expect(billed.requestCount).toBe(1);
        expect(
          ["input", "cached-input", "cache-write", "output"].map((category) =>
            tokenTotal(billed, category)
          )
        ).toEqual([34_000, 66_000, 0, 700]);
      }).pipe(Effect.provide(NodeServices.layer))
  );

  it.effect(
    "sums legacy stop-hook usage stored before semantics were verified",
    () =>
      Effect.gen(function* legacy() {
        const spoolDir = freshSpool("legacy");

        spoolLines(
          [
            stopLine({
              cache_read_tokens: 10,
              cache_write_tokens: 5,
              cost_usd: 0.5,
              generation_id: "gen-legacy",
              input_tokens: 40,
              output_tokens: 7,
            }),
          ],
          spoolDir
        );

        const batch = yield* cursorHooksCollector.collect(
          collectInput(spoolDir)
        );

        const legacyEvents = batch.events.map((event) =>
          event.kind === "ai.usage"
            ? {
                ...event,
                fieldSemantics: [],
                payload: {
                  hookEvent: "stop",
                  model: event.payload.model,
                  normalizedCategories: null,
                  rawUsage: event.payload.rawUsage,
                  semanticsVerified: false,
                  sourceKind: "hooks-stop",
                },
              }
            : event
        );

        for (const events of [batch.events, legacyEvents]) {
          const account = accountAiUsage(events);

          expect(
            ["input", "cached-input", "cache-write", "output"].map((category) =>
              tokenTotal(account, category)
            )
          ).toEqual([25, 10, 5, 7]);
          expect(account.uncovered.map((entry) => entry.fields)).toEqual([
            ["cost_usd"],
          ]);
          expect(
            account.totals.find((row) => row.category === "input")?.methods
          ).toEqual(["derived"]);
        }
      })
  );

  it.effect(
    "reports malformed and unknown hooks instead of empty success",
    () =>
      Effect.gen(function* malformed() {
        const spoolDir = freshSpool("bad");
        const results = spoolFixture("malformed.jsonl", spoolDir);

        expect(results.map((result) => result.outcome.state)).toEqual([
          "skipped",
          "skipped",
          "spooled",
        ]);
        expect(results[0]?.stdout).toBe("{}");

        const batch = yield* cursorHooksCollector.collect(
          collectInput(spoolDir)
        );

        expect(batch.coverage.state).toBe("partial");
        expect(batch.coverage.gaps.map((gap) => gap.code)).toContain(
          "unknown-hook-event"
        );
      })
  );

  it.effect("resumes from its cursor without re-emitting old records", () =>
    Effect.gen(function* resume() {
      const spoolDir = freshSpool("cursor");

      spoolFixture("duplicate-stop.jsonl", spoolDir);

      const first = yield* cursorHooksCollector.collect(collectInput(spoolDir));

      const second = yield* cursorHooksCollector.collect({
        ...collectInput(spoolDir),
        cursor: first.cursor,
      });

      expect(second.events).toHaveLength(0);
      expect(second.coverage.state).toBe("none");
    })
  );

  it.effect("fails visibly for missing spool or input", () =>
    Effect.gen(function* missing() {
      const noDir = yield* Effect.flip(
        cursorHooksCollector.collect(
          collectInput(path.join(scratchRoot, "absent"))
        )
      );

      const noInput = yield* Effect.flip(
        cursorHooksCollector.collect(collectInput(null))
      );

      expect(noDir._tag).toBe("SourceUnavailable");
      expect(noInput._tag).toBe("InvalidInput");
    })
  );

  it("answers permission hooks without blocking", () => {
    const spoolDir = freshSpool("perm");

    const result = handleCursorHook(
      JSON.stringify({
        command: "ls",
        conversation_id: "c",
        generation_id: "g",
        hook_event_name: "beforeShellExecution",
      }),
      {
        cwd: scratchRoot,
        now: new Date(),
        resolveGit: fixedGit,
        spoolDirFor: () => spoolDir,
      }
    );

    expect(JSON.parse(result.stdout)).toEqual({ permission: "allow" });
  });

  it("resolves the real git branch of the hook workspace", () => {
    const repo = path.join(scratchRoot, "repo");

    mkdirSync(repo);
    execFileSync("git", ["init", "-q", "-b", "feature/b05-demo", repo]);
    execFileSync("git", [
      "-C",
      repo,
      "-c",
      "user.email=b05@example.invalid",
      "-c",
      "user.name=b05",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    ]);

    const git = resolveGitContext(repo);

    expect(git.branch).toBe("feature/b05-demo");
    expect(git.headSha).toMatch(/^[0-9a-f]{40}$/u);
    expect(git.worktreePath).toBe(
      execFileSync("git", ["-C", repo, "rev-parse", "--show-toplevel"], {
        encoding: "utf-8",
      }).trim()
    );
  });

  it("describes itself honestly", () => {
    expect(cursorHooksDescriptor.readiness).toBe("degraded");
    expect(cursorHooksDescriptor.gaps.map((gap) => gap.code)).toContain(
      "stop-usage-partially-verified"
    );
  });
});
