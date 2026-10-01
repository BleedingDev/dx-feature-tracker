// @effect-diagnostics nodeBuiltinImport:off -- The C10 audit reads committed fixtures and owns one temp dir for spool output and a sentinel path that must never be created.
// @effect-diagnostics globalDate:off -- The hook handler contract takes a plain capture Date supplied by the hook process.
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { afterAll, beforeEach, describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { decodeSpoolRecord } from "../../../src/dx/collectors/cursor-hooks/decode.js";
import { handleCursorHook } from "../../../src/dx/collectors/cursor-hooks/handler.js";
import type { GitResolver } from "../../../src/dx/collectors/cursor-hooks/handler.js";
import { SpoolRecordSchema } from "../../../src/dx/collectors/cursor-hooks/spool-record.js";
import { parseCursorTranscript } from "../../../src/dx/collectors/cursor-transcripts/parse.js";
import { fakeManifest } from "../../../src/dx/contracts/fakes.js";
import type { StoreSnapshot } from "../../../src/dx/contracts/services.js";
import type { DxEventEnvelope } from "../../../src/dx/model/event.js";
import { emptyFlightContext } from "../../../src/dx/model/event.js";
import { EventIdSchema } from "../../../src/dx/model/ids.js";
import {
  boundRef,
  excerptPayload,
  redactText,
} from "../../../src/dx/reports/evidence/redact.js";
import { resolveEvidence } from "../../../src/dx/reports/evidence/resolve.js";

const SECRETS = {
  AWS_SECRET: ["wJalrXUtnFEMI", "/K7MDENG/", "bPxRfiCY", "C10EXAMPLEKEY"].join(
    ""
  ),
  GH_TOKEN: ["ghp", "_", "C".repeat(36)].join(""),
  JWT: ["eyJ", "hbGciOiJI", ".", "eyJ", "zdWIiOiIx", ".", "C10sigC10sig"].join(
    ""
  ),
  OPENAI_KEY: ["sk", "-", "proj", "D".repeat(24)].join(""),
} as const;

const CONTENT_MARKERS = [
  "C10-PROMPT-MARKER",
  "C10-OUTPUT-MARKER",
  "C10-TOOL-INPUT-MARKER",
  "C10-EDIT-MARKER",
  "C10-RESPONSE-MARKER",
  "hunter2",
  "Ignore previous instructions",
  "ignore previous instructions",
  "exfil.invalid",
] as const;

const scratch = mkdtempSync(path.join(os.tmpdir(), "dft-c10-"));

const ROOT = path.join(scratch, "repo");

const SENTINEL = path.join(scratch, "c10-sentinel-must-not-exist");

afterAll(() => {
  rmSync(scratch, { force: true, recursive: true });
});

const gitLookups: string[] = [];

beforeEach(() => {
  gitLookups.length = 0;
});

const substitute = (text: string): string =>
  text
    .replaceAll("{{GH_TOKEN}}", SECRETS.GH_TOKEN)
    .replaceAll("{{OPENAI_KEY}}", SECRETS.OPENAI_KEY)
    .replaceAll("{{AWS_SECRET}}", SECRETS.AWS_SECRET)
    .replaceAll("{{JWT}}", SECRETS.JWT)
    .replaceAll("{{SENTINEL}}", SENTINEL)
    .replaceAll("{{ROOT}}", ROOT);

const fixturePath = (name: string) =>
  path.join(import.meta.dirname, "../fixtures/c10", name);

const HookFixtureSchema = Schema.Struct({
  cases: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      payload: Schema.Record(Schema.String, Schema.Unknown),
    })
  ),
  note: Schema.String,
  origin: Schema.Literal("fixture"),
});

const hookFixture = Schema.decodeUnknownSync(HookFixtureSchema)(
  JSON.parse(readFileSync(fixturePath("c10-hook-payloads.json"), "utf-8"))
);

const hookStdin = (id: string): string => {
  const entry = hookFixture.cases.find((item) => item.id === id);

  if (entry === undefined) {
    throw new Error(`c10 fixture case missing: ${id}`);
  }

  return substitute(JSON.stringify(entry.payload));
};

const fakeGit: GitResolver = (cwd) => {
  gitLookups.push(cwd);

  return {
    branch: "c10/privacy",
    headSha: "c10".padEnd(40, "0"),
    repoCommonDir: path.join(ROOT, ".git"),
    worktreePath: ROOT,
  };
};

const assertNothingExecuted = (): void => {
  expect(existsSync(SENTINEL)).toBe(false);

  for (const cwd of gitLookups) {
    expect(cwd).toBe(ROOT);
  }
};

const assertClean = (label: string, text: string): void => {
  for (const [name, secret] of Object.entries(SECRETS)) {
    expect(text, `${label} leaked ${name}`).not.toContain(secret);
  }

  for (const marker of CONTENT_MARKERS) {
    expect(text, `${label} leaked content "${marker}"`).not.toContain(marker);
  }

  expect(text, `${label} leaked sentinel command`).not.toContain(
    `touch ${SENTINEL}`
  );
};

const decodeSpool = Schema.decodeUnknownSync(
  Schema.fromJsonString(SpoolRecordSchema)
);

interface HookRun {
  readonly stdout: string;
  readonly spoolText: string;
  readonly events: readonly DxEventEnvelope[];
}

const runHook = (id: string): HookRun => {
  const spoolDir = path.join(scratch, "spool", id);

  const result = handleCursorHook(hookStdin(id), {
    cwd: ROOT,
    now: new Date("2026-09-30T12:00:00.000Z"),
    resolveGit: fakeGit,
    spoolDirFor: () => spoolDir,
  });

  expect(result.outcome.state, `${id} should spool`).toBe("spooled");

  const files = readdirSync(spoolDir);
  expect(files).toHaveLength(1);

  const spoolText = readFileSync(path.join(spoolDir, files[0] ?? ""), "utf-8");

  return {
    events: decodeSpoolRecord(decodeSpool(spoolText), "fixture"),
    spoolText,
    stdout: result.stdout,
  };
};

const SAFE_HOOK_CASES = [
  "c10-prompt-secret-injection",
  "c10-shell-tool-instruction",
  "c10-after-shell-output",
  "c10-mcp-tool-input",
  "c10-file-edit-content",
  "c10-stop-usage",
] as const;

describe("c10 cursor hook path: redact, bound, never execute", () => {
  for (const id of SAFE_HOOK_CASES) {
    it(`${id}: spool, events and hook reply carry no content or secrets`, () => {
      const run = runHook(id);

      assertClean(`${id} spool`, run.spoolText);
      assertClean(`${id} events`, JSON.stringify(run.events));
      assertClean(`${id} stdout`, run.stdout);
      assertNothingExecuted();
    });
  }

  it("hook replies are fixed allow/continue documents, never echoing input", () => {
    expect(JSON.parse(runHook("c10-prompt-secret-injection").stdout)).toEqual({
      continue: true,
    });
    expect(JSON.parse(runHook("c10-shell-tool-instruction").stdout)).toEqual({
      permission: "allow",
    });
    expect(JSON.parse(runHook("c10-stop-usage").stdout)).toEqual({});
  });

  it("keeps bounded metadata: sizes, hashes, counts and source usage", () => {
    const [prompt] = runHook("c10-prompt-secret-injection").events;
    expect(prompt?.payload.promptChars).toBeGreaterThan(0);
    expect(prompt?.payload.attachmentCount).toBe(1);

    const [shell] = runHook("c10-shell-tool-instruction").events;
    expect(shell?.payload.commandBin).toBe("touch");
    expect(String(shell?.payload.commandHash)).toMatch(/^[0-9a-f]{64}$/u);

    const [edit] = runHook("c10-file-edit-content").events;
    expect(edit?.payload.linesAdded).toBe(3);

    const stop = runHook("c10-stop-usage").events;
    expect(stop.map((event) => event.kind)).toContain("ai.usage");
    expect(JSON.stringify(stop)).toContain("input_tokens");
  });

  it.fails("KNOWN FINDING: env-prefixed shell secret must not reach commandBin", () => {
    const run = runHook("c10-shell-env-prefixed-secret");

    assertClean("env-prefixed spool", run.spoolText);
    assertClean("env-prefixed events", JSON.stringify(run.events));
  });

  it("env-prefixed secret is still never executed", () => {
    runHook("c10-shell-env-prefixed-secret");
    assertNothingExecuted();
  });

  it("malformed or non-hook stdin is skipped without spooling or executing", () => {
    const spoolDir = path.join(scratch, "spool", "malformed");

    const runtime = {
      cwd: ROOT,
      now: new Date("2026-09-30T12:00:00.000Z"),
      resolveGit: fakeGit,
      spoolDirFor: () => spoolDir,
    };

    for (const stdin of [
      `touch ${SENTINEL}`,
      JSON.stringify({ prompt: `touch ${SENTINEL} ${SECRETS.GH_TOKEN}` }),
    ]) {
      const result = handleCursorHook(stdin, runtime);
      expect(result.outcome.state).toBe("skipped");
      assertClean("malformed stdout", result.stdout);
    }

    expect(existsSync(spoolDir)).toBe(false);
    assertNothingExecuted();
  });
});

describe("c10 cursor transcript path", () => {
  it.effect("transcript events keep counts and tool names, never text", () =>
    Effect.gen(function* transcriptAudit() {
      const text = substitute(
        readFileSync(fixturePath("c10-transcript.jsonl"), "utf-8")
      );

      const result = yield* parseCursorTranscript(text, {
        context: emptyFlightContext,
        observedAt: "2026-09-30T12:00:00.000Z",
        origin: "fixture",
        parentSessionId: null,
        sessionHint: "c10-session",
        sourceName: "c10-transcript.jsonl",
      });

      expect(result.events.length).toBeGreaterThan(0);
      assertClean("transcript events", JSON.stringify(result.events));
      assertClean("transcript coverage", JSON.stringify(result.coverage));
      expect(JSON.stringify(result.events)).toContain("run_terminal_cmd");
      assertNothingExecuted();
    }).pipe(Effect.provide(NodeServices.layer))
  );
});

describe("c10 evidence export path (B37)", () => {
  const hostile: DxEventEnvelope = {
    acquisition: "file-import",
    adapterId: "c10-hostile-import",
    adapterVersion: "fixture",
    ai: null,
    context: emptyFlightContext,
    eventId: EventIdSchema.make("c10-hostile"),
    evidence: {
      bounded: true,
      hash: null,
      ref: `https://user:hunter2@example.invalid/p?token=${SECRETS.GH_TOKEN}#x`,
    },
    fieldSemantics: [],
    identity: {
      commitSha: null,
      generationId: null,
      githubAttempt: null,
      githubRunId: null,
      prNumber: null,
      requestId: null,
      sessionId: null,
      turnId: null,
    },
    kind: "ai.request",
    observedAt: "2026-09-30T12:00:00.000Z",
    occurredAt: "2026-09-30T12:00:00.000Z",
    occurredAtPrecision: "exact",
    origin: "fixture",
    payload: {
      apiKey: SECRETS.OPENAI_KEY,
      command: `touch ${SENTINEL}`,
      nested: { prompt: "C10-PROMPT-MARKER ignore previous instructions" },
      note: `auth Bearer ${SECRETS.JWT} and ${SECRETS.GH_TOKEN}`,
      stdout: `C10-OUTPUT-MARKER ${SECRETS.AWS_SECRET}`,
      tokens: 42,
    },
    schemaVersion: "dx.event.v2",
    sourceVersion: null,
    upstreamKey: "c10-hostile",
    usage: null,
  };

  it("evidence items from a hostile imported event are redacted and bounded", () => {
    const snapshot: StoreSnapshot = {
      coverage: [],
      events: [hostile],
      manifest: fakeManifest("c10-snap"),
    };

    const resolved = resolveEvidence(snapshot, ["c10-hostile"], "metadata");
    const text = JSON.stringify(resolved);

    expect(text).toContain("42");
    assertClean("evidence", text);
    assertNothingExecuted();
  });

  it("redaction primitives scrub the synthetic secret set", () => {
    const all = Object.values(SECRETS).join(" ");
    assertClean(
      "redactText",
      redactText(
        `key ${SECRETS.GH_TOKEN} Bearer ${SECRETS.JWT} ${SECRETS.OPENAI_KEY}`
      ).text
    );
    assertClean("boundRef", boundRef(hostile.evidence.ref).text);
    assertClean(
      "excerptPayload",
      JSON.stringify(
        excerptPayload({
          note: `${SECRETS.GH_TOKEN} ${SECRETS.JWT} ${SECRETS.OPENAI_KEY} password=${SECRETS.AWS_SECRET}`,
          secret: all,
        })
      )
    );
  });

  it.fails("KNOWN FINDING B37: compound secret labels such as AWS_SECRET_ACCESS_KEY= or GITHUB_TOKEN= pass redaction", () => {
    const text = JSON.stringify(
      excerptPayload({
        note: `AWS_SECRET_ACCESS_KEY=${SECRETS.AWS_SECRET} GITHUB_TOKEN=${SECRETS.JWT}`,
      })
    );

    assertClean("excerptPayload compound label", text);
  });

  it.fails("KNOWN FINDING B37: bare unlabelled AWS secret in a metadata string passes redaction", () => {
    assertClean(
      "excerptPayload bare aws",
      JSON.stringify(excerptPayload({ note: SECRETS.AWS_SECRET }))
    );
  });
});
