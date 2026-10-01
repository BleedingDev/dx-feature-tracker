// @effect-diagnostics nodeBuiltinImport:off -- The extension test writes the generated Pi extension, a fake Pi runner and a recorder into an owned temp folder and runs them with node.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "@effect/vitest";
import { DateTime, Effect, Schema } from "effect";

import { everywhere } from "../../../src/dx/harness/contract.js";
import { HOOK_DECODERS } from "../../../src/dx/harness/hook-decoders.js";
import {
  hookSpoolRefs,
  readHookSpool,
  recordHook,
} from "../../../src/dx/harness/hook-spool.js";
import {
  PI_EXTENSION_MARKER,
  piExtensionSource,
} from "../../../src/dx/harness/pi/index.js";

const temp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "dft-pi-hook-")));

afterAll(() => {
  rmSync(temp, { force: true, recursive: true });
});

const recorded = path.join(temp, "calls.jsonl");

const recorder = path.join(temp, "recorder.mjs");

const extension = path.join(temp, "dft-observer.mjs");

const runner = path.join(temp, "fake-pi.mjs");

writeFileSync(
  recorder,
  [
    'import { appendFileSync } from "node:fs";',
    'let stdin = "";',
    'process.stdin.on("data", (chunk) => { stdin += chunk; });',
    `process.stdin.on("end", () => { appendFileSync(${JSON.stringify(recorded)}, JSON.stringify({ argv: process.argv.slice(2), stdin }) + "\\n"); });`,
  ].join("\n")
);

writeFileSync(extension, piExtensionSource([process.execPath, recorder]));

writeFileSync(
  runner,
  [
    `import observer from ${JSON.stringify(`./${path.basename(extension)}`)};`,
    "const handlers = [];",
    "observer({ on: (event, run) => handlers.push({ event, run }) });",
    "const ctx = {",
    '  cwd: "/home/user/projects/demo",',
    '  model: { id: "gpt-5.6-luna", provider: "cliproxy" },',
    "  sessionManager: {",
    '    getHeader: () => ({ parentSession: "/home/user/.pi/agent/sessions/x/2026-10-01T10-00-00-000Z_parent-1.jsonl" }),',
    '    getSessionFile: () => "/home/user/.pi/agent/sessions/x/s.jsonl",',
    '    getSessionId: () => "session-1",',
    "  },",
    '  thinkingLevel: "low",',
    "};",
    'const event = { message: { model: "gpt-5.6-luna", provider: "cliproxy", responseId: "resp-1", role: "assistant", thinkingLevel: "high" }, messageEntryId: "entry-1", reason: "startup" };',
    "for (const handler of handlers) handler.run(event, ctx);",
    'process.stdout.write(handlers.map((handler) => handler.event).join(","));',
  ].join("\n")
);

const CallSchema = Schema.Struct({
  argv: Schema.Array(Schema.String),
  stdin: Schema.String,
});

const decodeCall = Schema.decodeUnknownSync(Schema.fromJsonString(CallSchema));

const recordedCalls = () =>
  existsSync(recorded)
    ? readFileSync(recorded, "utf-8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => decodeCall(line))
    : [];

const waitForCalls = (count: number) =>
  Effect.gen(function* waitCalls() {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (recordedCalls().length >= count) {
        return recordedCalls();
      }

      yield* Effect.sleep("50 millis");
    }

    return recordedCalls();
  });

const byText = (a: string, b: string) => a.localeCompare(b);

describe("pi live capture", () => {
  it("maps Pi's extension events to event kinds", () => {
    expect(HOOK_DECODERS.pi.kind("session_start")).toBe("ai.session");
    expect(HOOK_DECODERS.pi.kind("turn_end")).toBe("ai.turn");
    expect(HOOK_DECODERS.pi.kind("message_end")).toBe("ai.request");
    expect(HOOK_DECODERS.pi.kind("agent_end")).toBe("other");
    expect(piExtensionSource(["dft"])).toContain(PI_EXTENSION_MARKER);
  });

  it.live("sends session, request and turn observations to dft hook pi", () =>
    Effect.gen(function* observe() {
      const subscribed = execFileSync(process.execPath, [runner], {
        cwd: temp,
        encoding: "utf-8",
      });

      expect(subscribed).toBe("session_start,message_end,turn_end");

      const calls = yield* waitForCalls(3);

      expect(
        calls.map((call) => call.argv.join(" ")).toSorted(byText)
      ).toStrictEqual([
        "hook pi message_end",
        "hook pi session_start",
        "hook pi turn_end",
      ]);

      const dftHome = path.join(temp, "dft-home");

      const now = DateTime.toDateUtc(
        DateTime.makeUnsafe("2026-10-01T10:00:00.000Z")
      );

      for (const call of calls) {
        recordHook({
          cwd: "/home/user/projects/demo",
          decoder: HOOK_DECODERS.pi,
          dftHome,
          event: call.argv[2] ?? "unknown",
          now,
          resolveGit: () => ({
            branch: "feat/live",
            headSha: null,
            repoCommonDir: "/home/user/projects/demo/.git",
            worktreePath: "/home/user/projects/demo",
          }),
          stdinText: call.stdin,
          tool: "pi",
        });
      }

      const [ref] = hookSpoolRefs(
        { ...everywhere, dftHome },
        "pi",
        "extension"
      );

      const events =
        ref === undefined
          ? []
          : readHookSpool(ref, HOOK_DECODERS.pi, "live").events;

      const request = events.find((event) => event.kind === "ai.request");

      expect(ref?.channel).toBe("extension");
      expect(events.map((event) => event.kind).toSorted(byText)).toStrictEqual([
        "ai.request",
        "ai.session",
        "ai.turn",
      ]);
      expect(request?.ai).toMatchObject({
        branchSource: "hook",
        channel: "extension",
        effort: "high",
        model: "gpt-5.6-luna",
        parentSessionId: "parent-1",
        provider: "openai",
        sessionId: "session-1",
        via: "cliproxy",
      });
      expect(request?.identity.turnId).toBe("resp-1");
    })
  );
});
