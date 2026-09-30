// @effect-diagnostics nodeBuiltinImport:off -- The C08 audit launches the built CLI MCP server as a real child process over stdio and owns one temp dir (Git repo, store, HOME, DFT_HOME) and waits for every awaited response before closing stdin.
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";

import {
  AnalyzeReportSchema,
  ExplainTimelineSchema,
  StatusReportSchema,
} from "../../../src/dx/model/report.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../../..");

const CLI = path.join(REPO_ROOT, "apps/cli/dist/cli.js");

const cliBuilt = fs.existsSync(CLI);

const DX_TOOLS = [
  "dx_analyze",
  "dx_collect",
  "dx_evidence",
  "dx_explain",
  "dx_mark",
  "dx_status",
] as const;

const INTERRUPTED_ON_STDIN_EOF = 130;

const SESSION_DEADLINE = "45 seconds";

const FrameSchema = Schema.Struct({
  error: Schema.optional(
    Schema.Struct({ code: Schema.Finite, message: Schema.String })
  ),
  id: Schema.optional(
    Schema.Union([Schema.Finite, Schema.String, Schema.Null])
  ),
  jsonrpc: Schema.Literal("2.0"),
  method: Schema.optional(Schema.String),
  result: Schema.optional(Schema.Unknown),
});

type Frame = typeof FrameSchema.Type;

const decodeFrameLine = Schema.decodeUnknownOption(
  Schema.fromJsonString(FrameSchema)
);

const decodeToolResult = Schema.decodeUnknownOption(
  Schema.Struct({
    isError: Schema.optional(Schema.Boolean),
    structuredContent: Schema.optional(Schema.Unknown),
  })
);

const decodeInitialize = Schema.decodeUnknownOption(
  Schema.Struct({ protocolVersion: Schema.String })
);

const decodeToolsList = Schema.decodeUnknownOption(
  Schema.Struct({
    tools: Schema.Array(
      Schema.Struct({ inputSchema: Schema.Unknown, name: Schema.String })
    ),
  })
);

const decodeAnalyze = Schema.decodeUnknownOption(AnalyzeReportSchema);

const decodeExplain = Schema.decodeUnknownOption(ExplainTimelineSchema);

const decodeStatus = Schema.decodeUnknownOption(StatusReportSchema);

const isToolError = (frame: Frame | undefined) =>
  frame === undefined ||
  frame.error !== undefined ||
  Option.exists(
    decodeToolResult(frame.result),
    (result) => result.isError === true
  );

const structured = (frame: Frame | undefined) =>
  Option.map(
    decodeToolResult(frame?.result),
    (result) => result.structuredContent
  );

const check = <A>(assertions: (value: A) => void) => Effect.map(assertions);

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "dxfr-c08-"));

afterAll(() => {
  fs.rmSync(scratch, { force: true, recursive: true });
});

const repo = path.join(scratch, "repo");

const home = path.join(scratch, "home");

const dftHome = path.join(scratch, "dft");

const storePath = path.join(scratch, "store", "dx.sqlite");

const git = (...args: readonly string[]) =>
  execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });

fs.mkdirSync(repo);

fs.mkdirSync(home);

fs.mkdirSync(dftHome);

fs.mkdirSync(path.dirname(storePath));

git("init", "-q", "-b", "main");

git("config", "user.email", "fixture@example.invalid");

git("config", "user.name", "fixture");

git("config", "commit.gpgsign", "false");

fs.writeFileSync(path.join(repo, "a.txt"), "one\n");

git("add", "a.txt");

git("commit", "-q", "-m", "c08 base");

git("checkout", "-q", "-b", "feature/c08-audit");

for (const index of [1, 2, 3]) {
  fs.writeFileSync(path.join(repo, `f${index}.txt`), `line ${index}\nmore\n`);

  git("add", `f${index}.txt`);

  git("commit", "-q", "-m", `c08 commit ${index}`);
}

const request = (id: number, method: string, params: Schema.JsonObject) => ({
  id,
  jsonrpc: "2.0",
  method,
  params,
});

const notification = (method: string, params: Schema.JsonObject) => ({
  jsonrpc: "2.0",
  method,
  params,
});

const toolCall = (id: number, name: string, args: Schema.JsonObject) =>
  request(id, "tools/call", { arguments: args, name });

const HANDSHAKE = [
  request(1, "initialize", {
    capabilities: {},
    clientInfo: { name: "c08-audit", version: "0.0.0" },
    protocolVersion: "2025-06-18",
  }),
  notification("notifications/initialized", {}),
];

const decodeRequestId = Schema.decodeUnknownOption(
  Schema.Struct({ id: Schema.Finite })
);

const requestIds = (messages: readonly Schema.JsonObject[]) =>
  messages.flatMap((message) =>
    Option.toArray(Option.map(decodeRequestId(message), ({ id }) => id))
  );

interface Session {
  readonly byId: (id: number) => Frame | undefined;
  readonly nonProtocol: readonly string[];
  readonly signal: NodeJS.Signals | null;
  readonly status: number | null;
}

const toSession = (
  stdout: string,
  status: number | null,
  signal: NodeJS.Signals | null
): Session => {
  const lines = stdout.split("\n").filter((line) => line.length > 0);

  const frames = lines.flatMap((line) => Option.toArray(decodeFrameLine(line)));

  return {
    byId: (id: number) => frames.find((frame) => frame.id === id),
    nonProtocol: lines.filter((line) => Option.isNone(decodeFrameLine(line))),
    signal,
    status,
  };
};

const runSession = (
  messages: readonly Schema.JsonObject[],
  awaitIds: readonly number[] = requestIds([...HANDSHAKE, ...messages])
) =>
  Effect.callback<Session>((resume) => {
    const child = spawn(process.execPath, [CLI, "mcp"], {
      cwd: repo,
      env: {
        DFT_CURSOR_USAGE: "off",
        DFT_HOME: dftHome,
        DX_REPO: repo,
        DX_STORE: storePath,
        HOME: home,
        PATH: process.env.PATH ?? "",
      },
      stdio: ["pipe", "pipe", "ignore"],
    });

    const pending = new Set<Frame["id"]>(awaitIds);

    let stdout = "";

    const closeInput = () => {
      if (!child.stdin.writableEnded) {
        child.stdin.end();
      }
    };

    child.stdout.setEncoding("utf-8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;

      for (const line of stdout.split("\n")) {
        for (const frame of Option.toArray(decodeFrameLine(line))) {
          pending.delete(frame.id);
        }
      }

      if (pending.size === 0) {
        closeInput();
      }
    });

    child.on("error", (error) => {
      resume(Effect.die(error));
    });

    child.on("close", (status, signal) => {
      resume(Effect.succeed(toSession(stdout, status, signal)));
    });

    child.stdin.write(
      [...HANDSHAKE, ...messages]
        .map((message) => `${JSON.stringify(message)}\n`)
        .join("")
    );

    return Effect.sync(() => {
      child.kill("SIGKILL");
    });
  }).pipe(Effect.timeout(SESSION_DEADLINE));

describe.skipIf(!cliBuilt)("C08 MCP launch audit (built CLI stdio)", () => {
  it.live(
    "launches, negotiates 2025-06-18 and lists the six dx tools with schemas",
    () =>
      runSession([
        request(2, "tools/list", {}),
        toolCall(3, "dx_status", {}),
      ]).pipe(
        check((session) => {
          expect(
            Option.map(
              decodeInitialize(session.byId(1)?.result),
              (init) => init.protocolVersion
            )
          ).toStrictEqual(Option.some("2025-06-18"));

          const { tools } = Option.getOrThrow(
            decodeToolsList(session.byId(2)?.result)
          );

          expect(tools.map((tool) => tool.name)).toStrictEqual(
            expect.arrayContaining([...DX_TOOLS])
          );

          expect(
            Option.isSome(
              Option.flatMap(structured(session.byId(3)), decodeStatus)
            )
          ).toBe(true);

          expect(session.nonProtocol).toStrictEqual([]);

          expect(session.signal).toBeNull();

          expect(session.status).toBe(INTERRUPTED_ON_STDIN_EOF);
        })
      ),
    60_000
  );

  it.live(
    "keeps stdout protocol-only across writes, reads, tool errors and malformed calls",
    () =>
      runSession([
        toolCall(2, "dx_collect", { repo, source: "git-history" }),
        toolCall(3, "dx_mark", { kind: "start", label: "c08", repo }),
        toolCall(4, "dx_analyze", { repo }),
        toolCall(5, "dx_explain", { snapshotId: "snap_does_not_exist_c08" }),
        toolCall(6, "dx_not_a_tool", {}),
        request(7, "tools/call", { name: 42 }),
      ]).pipe(
        check((session) => {
          expect(
            [2, 3, 4].map((id) => isToolError(session.byId(id)))
          ).toStrictEqual([false, false, false]);

          expect(
            [5, 6, 7].map((id) => session.byId(id) !== undefined)
          ).toStrictEqual([true, true, true]);

          expect(
            [5, 6, 7].map((id) => isToolError(session.byId(id)))
          ).toStrictEqual([true, true, true]);

          expect(session.nonProtocol).toStrictEqual([]);
        })
      ),
    60_000
  );

  it.live(
    "honours notifications/cancelled without crashing and keeps serving",
    () =>
      runSession(
        [
          toolCall(2, "dx_analyze", { repo }),
          notification("notifications/cancelled", {
            reason: "c08 audit cancellation",
            requestId: 2,
          }),
          notification("notifications/cancelled", {
            reason: "c08 unknown id",
            requestId: 999_999,
          }),
          request(3, "ping", {}),
          toolCall(4, "dx_status", {}),
        ],
        [1, 3, 4]
      ).pipe(
        check((session) => {
          expect(session.byId(3)?.error).toBeUndefined();

          expect(session.byId(3)).toBeDefined();

          expect(isToolError(session.byId(4))).toBe(false);

          expect(session.nonProtocol).toStrictEqual([]);

          expect(session.signal).toBeNull();
        })
      ),
    60_000
  );

  it.live(
    "bounds explain pagination by limit and snapshot-bound cursor, and evidence batches",
    () =>
      Effect.gen(function* observeExplainPaging() {
        const analyzeSession = yield* runSession([
          toolCall(2, "dx_collect", { repo, source: "git-history" }),
          toolCall(3, "dx_analyze", { repo }),
        ]);

        const { snapshotId } = Option.getOrThrow(
          Option.flatMap(structured(analyzeSession.byId(3)), decodeAnalyze)
        ).snapshot;

        const pageSession = yield* runSession([
          toolCall(2, "dx_explain", { limit: 1, snapshotId }),
          toolCall(3, "dx_explain", { limit: 0, snapshotId }),
          toolCall(4, "dx_explain", { limit: -1, snapshotId }),
          toolCall(5, "dx_explain", { limit: 501, snapshotId }),
          toolCall(6, "dx_explain", { limit: 1.5, snapshotId }),
          toolCall(7, "dx_explain", {
            cursor: "not-a-real-cursor",
            limit: 1,
            snapshotId,
          }),
          toolCall(8, "dx_evidence", {
            evidenceIds: Array.from({ length: 101 }, (_, i) => `ev_${i}`),
            snapshotId,
          }),
          toolCall(9, "dx_evidence", { evidenceIds: [], snapshotId }),
        ]);

        const first = Option.getOrThrow(
          Option.flatMap(structured(pageSession.byId(2)), decodeExplain)
        );

        const secondSession = yield* runSession([
          toolCall(2, "dx_explain", {
            cursor: first.nextCursor,
            limit: 1,
            snapshotId,
          }),
        ]);

        return {
          first,
          nonProtocol: [
            ...analyzeSession.nonProtocol,
            ...pageSession.nonProtocol,
            ...secondSession.nonProtocol,
          ],
          rejected: [3, 4, 5, 6, 7, 8, 9].map((id) =>
            isToolError(pageSession.byId(id))
          ),
          second: Option.flatMap(
            structured(secondSession.byId(2)),
            decodeExplain
          ),
        };
      }).pipe(
        check((observed) => {
          expect(observed.first.entries.length).toBe(1);

          expect(observed.first.total).toBeGreaterThan(1);

          expect(observed.first.nextCursor).not.toBeNull();

          const second = Option.getOrThrow(observed.second);

          expect(second.entries.length).toBe(1);

          expect(second.entries).not.toStrictEqual(observed.first.entries);

          expect(observed.rejected).toStrictEqual([
            true,
            true,
            true,
            true,
            true,
            true,
            true,
          ]);

          expect(observed.nonProtocol).toStrictEqual([]);
        })
      ),
    90_000
  );
});
