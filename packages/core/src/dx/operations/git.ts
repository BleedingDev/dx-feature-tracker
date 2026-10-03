// @effect-diagnostics-next-line nodeBuiltinImport:off -- Git snapshot identity uses a synchronous SHA-256 over bounded captured output.
import { createHash } from "node:crypto";

import { NodeServices } from "@effect/platform-node";
import {
  DateTime,
  Effect,
  Exit,
  Match,
  Predicate,
  Semaphore,
  Stream,
} from "effect";
import type { PlatformError } from "effect";
import { ChildProcess } from "effect/unstable/process";
import type { ChildProcessSpawner } from "effect/unstable/process";

import type { DxCommandEnv } from "../cli/commands/context.js";
import { collectGitHistory } from "../collectors/git-history/git-history.js";
import { buildGitContextBatch } from "../collectors/git-identity/collector.js";
import { resolveGitIdentity } from "../collectors/git-identity/identity.js";
import { collectGitObservation } from "../collectors/git-observation/collector.js";
import { parseStatusPorcelainV2 } from "../collectors/git-observation/parse.js";
import type { AgentStoreFailure } from "../contracts/agent-store.js";
import { AgentError } from "../contracts/error-agent.js";
import { SourceUnavailable } from "../contracts/error-source-unavailable.js";
import type { CollectError, CollectInput } from "../contracts/services.js";
import { parseWorktreePorcelain } from "../correlation/repo/worktree-map.js";
import type { AgentScope } from "../model/agent-common.js";
import type {
  OperationArguments,
  OperationPlan,
  OperationReceipt,
  OperationStep,
} from "../model/agent-operation.js";
import type { EventBatch, FlightContext } from "../model/event.js";
import type { PlannedSource } from "../registry/sync.js";
import { writeSpoolBatch } from "../storage/spool.js";
import { spoolDirFor } from "../storage/store-path.js";
import { operationScopeDigest } from "./digest.js";
import { operationStep } from "./ports.js";
import type { OperationAdapter, OperationWorkContext } from "./ports.js";

export const BOUNDED_GIT_OPERATION_VERSION = "dx.bounded-git.v1";

export const BOUNDED_GIT_SOURCES: readonly string[] = [
  "collector.git-history",
  "collector.git-observation",
  "collector.git-identity",
];

export interface BoundedGitSelectionRequest {
  readonly scope: AgentScope;
  readonly arguments: OperationArguments;
}

export interface BoundedGitEnrollmentRequest extends BoundedGitSelectionRequest {
  readonly receiptIds: readonly string[];
}

export interface BoundedGitOperationOptions {
  readonly env: DxCommandEnv;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly identity?: (
    selected: PlannedSource
  ) => Pick<AgentScope, "repoId" | "worktreeId">;
  readonly selected: (
    request: BoundedGitSelectionRequest
  ) => Effect.Effect<readonly PlannedSource[], AgentStoreFailure>;
  readonly enrollment: (
    request: BoundedGitEnrollmentRequest,
    context: OperationWorkContext
  ) => Effect.Effect<
    Pick<OperationPlan["consent"], "state" | "reason" | "receiptIds">,
    AgentStoreFailure
  >;
}

interface GitOutput {
  readonly exitCode: number;
  readonly stdout: string;
}

interface GitBatchInput {
  readonly bytes: Uint8Array;
  readonly records: number;
}

interface GitRunState {
  readonly gaps: string[];
  failure: AgentStoreFailure | null;
}

interface GitAppendResult {
  readonly duplicates: number;
  readonly inserted: number;
  readonly spooledTo: string | null;
}

type GitSnapshot =
  | { readonly root: string; readonly source: string }
  | {
      readonly context: FlightContext;
      readonly diff: string;
      readonly head: string;
      readonly located: string;
      readonly refs: string;
      readonly status: string;
    };

const gitError = (code: AgentError["code"], message: string): AgentError =>
  new AgentError({
    code,
    currentRevision: null,
    expectedRevision: null,
    message,
    recovery: { action: "replan", ref: null },
    ref: null,
    retryable: false,
  });

const processFailure = (
  error: AgentError | PlatformError.PlatformError
): AgentStoreFailure =>
  Predicate.isTagged(error, "AgentError")
    ? error
    : gitError(
        "source-unavailable",
        `The selected Git command failed: ${error.message}`
      );

const sourceFailure =
  (adapterId: string) =>
  (error: AgentStoreFailure): SourceUnavailable =>
    new SourceUnavailable({ adapterId, message: error.message });

const collectionFailure = (
  error: CollectError | AgentStoreFailure
): AgentStoreFailure =>
  Predicate.isTagged(error, "AgentError") ||
  Predicate.isTagged(error, "StoreBusy") ||
  Predicate.isTagged(error, "StoreError")
    ? error
    : gitError("source-unavailable", error.message);

const GIT_ENV = {
  GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
  GIT_COMMON_DIR: undefined,
  GIT_CONFIG_COUNT: "0",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_PARAMETERS: undefined,
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_DIR: undefined,
  GIT_INDEX_FILE: undefined,
  GIT_OBJECT_DIRECTORY: undefined,
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  GIT_WORK_TREE: undefined,
  LC_ALL: "C",
};

const READ_COMMANDS = new Set([
  "--version",
  "version",
  "rev-parse",
  "symbolic-ref",
  "status",
  "diff",
  "log",
  "reflog",
  "for-each-ref",
  "merge-base",
  "rev-list",
  "ls-files",
  "worktree",
  "remote",
  "hash-object",
  "cat-file",
]);

const METRIC_LIMITATION =
  "Resource bytes measure captured Git stdout, and decoded records are unavailable with conservative raw-byte record units. File units count selected repository acquisitions. Git's internal object and worktree file I/O is unobservable and is outside these source measurements.";

const snapshotDigest = (value: GitSnapshot): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const boundedArgs = (
  args: readonly string[],
  records: number,
  gaps: string[]
): readonly string[] => {
  const [command] = args;

  const declared = args.flatMap((arg, index) => {
    const digits =
      arg === "-n"
        ? args[index + 1]
        : (/^-n(?<count>\d+)$/u.exec(arg)?.groups?.count ??
          /^--max-count=(?<count>\d+)$/u.exec(arg)?.groups?.count);

    return digits !== undefined && /^\d+$/u.test(digits)
      ? [Number(digits)]
      : [];
  });

  const cap = Math.max(1, Math.min(2001, records, ...declared));

  if (command === "log" || command === "reflog" || command === "rev-list") {
    if (command === "rev-list" && args.includes("--count")) {
      return args;
    }

    const trimmed = args.filter((arg, index) => {
      const previous = args[index - 1];

      return (
        arg !== "-n" &&
        previous !== "-n" &&
        !/^-n\d+$/u.test(arg) &&
        !arg.startsWith("--max-count=")
      );
    });

    gaps.push(
      `Git ${command} is limited to ${cap} entries; older entries may remain unread.`
    );

    const restrictions =
      command === "log"
        ? ["--no-ext-diff", "--no-textconv", "--no-show-signature"]
        : [];

    return [
      trimmed[0] ?? "",
      `--max-count=${cap}`,
      ...restrictions,
      ...trimmed.slice(1),
    ];
  }

  if (command === "for-each-ref") {
    const trimmed = args.filter((arg) => !arg.startsWith("--count="));

    return [
      trimmed[0] ?? "",
      `--count=${Math.min(200, cap)}`,
      ...trimmed.slice(1),
    ];
  }

  if (command === "diff") {
    return [
      command,
      "--no-ext-diff",
      "--no-textconv",
      ...args
        .slice(1)
        .filter((arg) => arg !== "--no-ext-diff" && arg !== "--no-textconv"),
    ];
  }

  if (command === "hash-object") {
    return [command, "--no-filters", ...args.slice(1)];
  }

  return args;
};

const validateGitCommand = Effect.fn("boundedGit.validateCommand")(
  function* validateCommand(
    args: readonly string[],
    batchInput: GitBatchInput | undefined
  ) {
    if (
      !READ_COMMANDS.has(args[0] ?? "") ||
      (args[0] === "worktree" && args[1] !== "list") ||
      (args[0] === "remote" && args.length !== 1) ||
      (args[0] === "cat-file" &&
        (args.length !== 2 ||
          args[1] !== "--batch-check" ||
          batchInput === undefined)) ||
      args.includes("--output") ||
      args.some((arg) => arg.startsWith("--output=")) ||
      args.includes("-w")
    ) {
      return yield* gitError(
        "scope-denied",
        "The Git acquisition contains a command outside the fixed read-only command set."
      );
    }

    if (args[0] === "hash-object") {
      const separator = args.indexOf("--");
      const paths = separator === -1 ? [] : args.slice(separator + 1);

      if (
        separator === -1 ||
        paths.length === 0 ||
        paths.some(
          (path) =>
            path.length === 0 ||
            path.startsWith("/") ||
            /(?:^|\/)\.\.(?:\/|$)/u.test(path)
        )
      ) {
        return yield* gitError(
          "scope-denied",
          "Git fingerprint paths must stay inside the selected worktree."
        );
      }
    }

    return yield* Effect.void;
  }
);

interface GitRunCounters {
  bytes: number;
  outputRecords: number;
  started: boolean;
}

const measuredGitRecords = (
  input: GitBatchInput | undefined,
  counters: GitRunCounters
): number | null => {
  if (input === undefined) {
    return counters.bytes === 0 ? 0 : null;
  }

  return counters.outputRecords + (counters.started ? input.records : 0);
};

const makeRunner = (
  options: Pick<BoundedGitOperationOptions, "spawner">,
  cwd: string,
  context: OperationWorkContext,
  state: GitRunState
) => {
  const lock = Semaphore.makeUnsafe(1);

  const run = Effect.fn("boundedGit.run")(function* run(
    args: readonly string[],
    batchInput?: GitBatchInput
  ) {
    if (state.failure !== null) {
      return yield* state.failure;
    }

    yield* validateGitCommand(args, batchInput);

    const remaining = yield* context.budget.remaining;
    const inputBytes = batchInput?.bytes.byteLength ?? 0;

    const recordAllowance =
      batchInput === undefined ? remaining.maxRecords : batchInput.records * 2;

    const cap = Math.min(
      remaining.maxBytes - inputBytes,
      batchInput === undefined ? remaining.maxRecords : batchInput.records * 96,
      1_048_576
    );

    if (cap <= 0 || remaining.maxRequests < 1 || remaining.maxFiles < 1) {
      return yield* gitError(
        "budget-exhausted",
        "The reviewed Git acquisition allowance is exhausted before starting another command."
      );
    }

    const reservation = yield* context.budget.reserve({
      bytesRead: cap + inputBytes,
      filesRead: 1,
      recordsDecoded: batchInput === undefined ? cap : recordAllowance,
      requests: 1,
      retries: 0,
    });

    const counters = { bytes: 0, outputRecords: 0, started: false };
    const chunks: Uint8Array[] = [];
    const command = boundedArgs(args, remaining.maxRecords, state.gaps);

    const work = Effect.scoped(
      Effect.gen(function* runCommand() {
        const handle = yield* options.spawner.spawn(
          ChildProcess.make(
            "git",
            [
              "--no-pager",
              "--no-optional-locks",
              "-c",
              "core.quotepath=off",
              "-c",
              "diff.external=",
              "-c",
              "core.fsmonitor=false",
              "-C",
              cwd,
              ...command,
            ],
            {
              env: GIT_ENV,
              extendEnv: true,
              stderr: "ignore",
              stdin:
                batchInput === undefined
                  ? "ignore"
                  : Stream.succeed(batchInput.bytes),
            }
          )
        );

        counters.started = true;

        yield* handle.stdout.pipe(
          Stream.runForEach((chunk) =>
            Effect.gen(function* receiveOutput() {
              counters.bytes += chunk.byteLength;

              if (batchInput !== undefined) {
                for (const byte of chunk) {
                  if (byte === 10) {
                    counters.outputRecords += 1;
                  }
                }

                if (counters.outputRecords > batchInput.records) {
                  yield* handle.kill().pipe(Effect.ignore);

                  return yield* gitError(
                    "budget-exhausted",
                    "Git returned more batch-check records than the reviewed SHA input permits."
                  );
                }
              }

              if (counters.bytes > cap) {
                yield* handle.kill().pipe(Effect.ignore);

                return yield* gitError(
                  "budget-exhausted",
                  "Git stdout exceeded its reviewed allowance; the child was stopped and no captured batch was imported."
                );
              }

              chunks.push(chunk);

              return yield* Effect.void;
            })
          )
        );

        const exitCode = Number(yield* handle.exitCode);
        const bytes = new Uint8Array(counters.bytes);
        const position = { value: 0 };

        for (const chunk of chunks) {
          bytes.set(chunk, position.value);
          position.value += chunk.byteLength;
        }

        return { exitCode, stdout: new TextDecoder().decode(bytes) };
      })
    ).pipe(
      Effect.timeout(remaining.maxElapsedMs),
      Effect.catchTag("TimeoutError", () =>
        Effect.fail(
          gitError(
            "budget-exhausted",
            "The Git command exceeded the reviewed elapsed allowance."
          )
        )
      ),
      Effect.mapError(processFailure)
    );

    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* settleCommand() {
        const result = yield* Effect.exit(restore(work));

        yield* reservation.complete({
          bytesRead: counters.bytes + (counters.started ? inputBytes : 0),
          filesRead: counters.started ? 1 : 0,
          recordUnits:
            batchInput === undefined
              ? counters.bytes
              : counters.outputRecords +
                (counters.started ? batchInput.records : 0),
          recordsDecoded: measuredGitRecords(batchInput, counters),
          requests: counters.started ? 1 : 0,
          retries: 0,
        });

        return Exit.isSuccess(result)
          ? result.value
          : yield* Effect.failCause(result.cause);
      })
    );
  });

  const retainGitFailure = (error: AgentStoreFailure) =>
    Effect.sync(() => {
      state.failure = error;
    });

  return (
    args: readonly string[],
    batchInput?: GitBatchInput
  ): Effect.Effect<GitOutput, AgentStoreFailure> =>
    run(args, batchInput).pipe(
      Effect.tapError(retainGitFailure),
      lock.withPermits(1)
    );
};

const GIT_COMMIT_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?(?![\s\S])/u;

export const checkBoundedGitCommits = Effect.fn("boundedGit.checkCommits")(
  function* checkCommits(
    spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
    worktree: string,
    shas: readonly string[],
    context: OperationWorkContext
  ): Effect.fn.Return<ReadonlySet<string>, AgentStoreFailure> {
    if (shas.length === 0) {
      return new Set<string>();
    }

    const remaining = yield* context.budget.remaining;

    if (
      shas.length * 2 > remaining.maxRecords ||
      shas.length * 65 > remaining.maxBytes
    ) {
      return yield* gitError(
        "budget-exhausted",
        "The SHA query input exceeds the remaining reviewed byte or record allowance."
      );
    }

    if (
      worktree.length === 0 ||
      !worktree.startsWith("/") ||
      shas.some((sha) => !GIT_COMMIT_SHA.test(sha))
    ) {
      return yield* gitError(
        "invalid-selector",
        "Git commit checks require an exact enrolled absolute worktree and full hexadecimal SHA inputs."
      );
    }

    const unique = [...new Set(shas)];

    const bytes = new TextEncoder().encode(`${unique.join("\n")}\n`);
    const state: GitRunState = { failure: null, gaps: [] };

    const run = makeRunner({ spawner }, worktree, context, state);

    const output = yield* run(["cat-file", "--batch-check"], {
      bytes,
      records: unique.length,
    });

    if (output.exitCode !== 0 || !output.stdout.endsWith("\n")) {
      return yield* gitError(
        "source-unavailable",
        "The bounded Git commit check did not return a complete response."
      );
    }

    const lines = output.stdout.slice(0, -1).split("\n");

    if (lines.length !== unique.length) {
      return yield* gitError(
        "source-unavailable",
        "The Git commit check returned an incomplete or excess response set."
      );
    }

    const known = new Set<string>();

    for (const [index, line] of lines.entries()) {
      const [sha, type, size, extra] = line.split(" ");

      if (
        sha !== unique[index] ||
        extra !== undefined ||
        (type === "missing"
          ? size !== undefined
          : !["commit", "tree", "blob", "tag"].includes(type ?? "") ||
            size === undefined ||
            !/^\d+(?![\s\S])/u.test(size))
      ) {
        return yield* gitError(
          "source-unavailable",
          "The Git commit check returned a malformed or out-of-scope SHA response."
        );
      }

      if (type === "commit" && sha !== undefined) {
        known.add(sha);
      }
    }

    return known;
  }
);

export const makeBoundedGitCommitChecker =
  (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) =>
  (
    worktree: string,
    shas: readonly string[],
    context: OperationWorkContext
  ): Effect.Effect<ReadonlySet<string>, AgentStoreFailure> =>
    checkBoundedGitCommits(spawner, worktree, shas, context);

export const listBoundedGitWorktrees = Effect.fn("boundedGit.listWorktrees")(
  function* listWorktrees(
    spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
    worktree: string,
    context: OperationWorkContext
  ): Effect.fn.Return<readonly string[], AgentStoreFailure> {
    if (!worktree.startsWith("/") || worktree.includes("\u0000")) {
      return yield* gitError(
        "invalid-selector",
        "Git worktree listing requires an exact enrolled absolute worktree."
      );
    }

    const state: GitRunState = { failure: null, gaps: [] };
    const run = makeRunner({ spawner }, worktree, context, state);

    const output = yield* run(["worktree", "list", "--porcelain"]);

    if (output.exitCode !== 0 || !output.stdout.endsWith("\n")) {
      return yield* gitError(
        "source-unavailable",
        "Git did not return a complete bounded worktree list."
      );
    }

    const entries = parseWorktreePorcelain(output.stdout);

    const roots = [
      ...new Set(
        entries
          .filter((entry) => !entry.bare && !entry.prunable)
          .map((entry) => entry.path)
      ),
    ];

    if (
      roots.length > 256 ||
      roots.some((root) => !root.startsWith("/") || root.includes("\u0000")) ||
      !roots.includes(worktree)
    ) {
      return yield* gitError(
        "source-unavailable",
        "The bounded Git worktree list is incomplete or outside its expected selected-root metadata shape."
      );
    }

    return roots;
  }
);

export const makeBoundedGitWorktreeLister =
  (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) =>
  (
    worktree: string,
    context: OperationWorkContext
  ): Effect.Effect<readonly string[], AgentStoreFailure> =>
    listBoundedGitWorktrees(spawner, worktree, context);

const contextLocations = (
  located: GitOutput
): Pick<FlightContext, "repoCommonDir" | "worktreePath"> | null => {
  const locations = located.stdout.endsWith("\n")
    ? located.stdout.slice(0, -1).split("\n")
    : [];

  const [worktreePath, repoCommonDir] = locations;

  return located.exitCode !== 0 ||
    locations.length !== 2 ||
    worktreePath === undefined ||
    repoCommonDir === undefined ||
    !worktreePath.startsWith("/") ||
    !repoCommonDir.startsWith("/") ||
    locations.some((location) => location.includes("\u0000"))
    ? null
    : { repoCommonDir, worktreePath };
};

const contextHead = (
  output: GitOutput
): Pick<FlightContext, "headSha"> | null => {
  if (output.exitCode !== 0) {
    return output.stdout.length === 0 ? { headSha: null } : null;
  }

  const headSha = output.stdout.endsWith("\n")
    ? output.stdout.slice(0, -1)
    : "";

  return GIT_COMMIT_SHA.test(headSha) ? { headSha } : null;
};

const contextBranch = (
  output: GitOutput
): Pick<FlightContext, "branch"> | null => {
  if (output.exitCode !== 0) {
    return output.exitCode === 1 && output.stdout.length === 0
      ? { branch: null }
      : null;
  }

  const branch = output.stdout.endsWith("\n") ? output.stdout.slice(0, -1) : "";

  return branch.length === 0 ||
    branch.length > 256 ||
    branch.includes("\u0000") ||
    branch.includes("\r") ||
    branch.includes("\n")
    ? null
    : { branch };
};

export const resolveBoundedGitContext = Effect.fn("boundedGit.resolveContext")(
  function* resolveContext(
    spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
    root: string,
    context: OperationWorkContext
  ): Effect.fn.Return<FlightContext, AgentStoreFailure> {
    if (!root.startsWith("/") || root.includes("\u0000")) {
      return yield* gitError(
        "invalid-selector",
        "Git target resolution requires an explicit absolute root."
      );
    }

    const state: GitRunState = { failure: null, gaps: [] };
    const run = makeRunner({ spawner }, root, context, state);

    const located = yield* run([
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
      "--git-common-dir",
    ]);

    const locations = contextLocations(located);

    if (locations === null) {
      return yield* gitError(
        "source-unavailable",
        "Git did not return a complete canonical worktree and repository identity."
      );
    }

    const head = contextHead(yield* run(["rev-parse", "--verify", "HEAD"]));

    if (head === null) {
      return yield* gitError(
        "source-unavailable",
        "Git returned an invalid current HEAD identity."
      );
    }

    const current = contextBranch(
      yield* run(["symbolic-ref", "--quiet", "--short", "HEAD"])
    );

    if (current === null) {
      return yield* gitError(
        "source-unavailable",
        "Git did not return a valid current branch or detached HEAD state."
      );
    }

    return { ...locations, ...head, ...current, flightId: null };
  }
);

export const makeBoundedGitTargetResolver =
  (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) =>
  (
    root: string,
    context: OperationWorkContext
  ): Effect.Effect<FlightContext, AgentStoreFailure> =>
    resolveBoundedGitContext(spawner, root, context);

const selectedSources = Effect.fn("boundedGit.selected")(
  function* selectSources(
    options: BoundedGitOperationOptions,
    request: BoundedGitSelectionRequest
  ) {
    const args = request.arguments;

    if (
      args.kind !== "collect" ||
      !BOUNDED_GIT_SOURCES.includes(args.source) ||
      args.parserVersion !== BOUNDED_GIT_OPERATION_VERSION ||
      args.inputRefs.length !== 0 ||
      args.cursor !== null ||
      args.allowSourceGrowth ||
      args.selectedRoots.length === 0 ||
      new Set(args.selectedRoots).size !== args.selectedRoots.length
    ) {
      return yield* gitError(
        "invalid-selector",
        "Git collection requires exact selected roots, the bounded parser version, and no source-growth or cursor widening."
      );
    }

    const resolved = yield* options.selected(request);

    const selected = args.selectedRoots.map((root) =>
      resolved.find(
        (item) =>
          item.source === args.source &&
          item.input === root &&
          item.ref === null
      )
    );

    if (
      selected.some((item) => item === undefined || item.unavailable !== null)
    ) {
      return yield* gitError(
        "scope-denied",
        "A selected Git root is unavailable or outside the enrolled exact source catalog."
      );
    }

    if (
      selected.some(
        (item) =>
          item !== undefined &&
          ((request.scope.branchSelection.kind === "selected" &&
            !request.scope.branchSelection.branches.includes(
              item.context.branch ?? ""
            )) ||
            (request.scope.sources.length > 0 &&
              !request.scope.sources.includes(item.source)) ||
            (request.scope.flightId !== null &&
              request.scope.flightId !== item.context.flightId))
      )
    ) {
      return yield* gitError(
        "scope-denied",
        "The enrolled Git context does not match the selected branch, source, or flight."
      );
    }

    for (const item of selected) {
      if (item === undefined) {
        continue;
      }

      const identity = options.identity?.(item) ?? {
        repoId: item.context.repoCommonDir,
        worktreeId: item.context.worktreePath,
      };

      if (
        (request.scope.repoId !== null &&
          request.scope.repoId !== identity.repoId) ||
        (request.scope.worktreeId !== null &&
          request.scope.worktreeId !== identity.worktreeId) ||
        request.scope.tools.length > 0
      ) {
        return yield* gitError(
          "scope-denied",
          "The selected Git root is outside the claimed repository, worktree, or tool scope."
        );
      }
    }

    return selected.flatMap((item) => (item === undefined ? [] : [item]));
  }
);

const sourceStepId = (source: string, root: string): string =>
  `git:${snapshotDigest({ root, source })}`;

const pinRepository = Effect.fn("boundedGit.pin")(function* pinRepository(
  options: BoundedGitOperationOptions,
  item: PlannedSource,
  context: OperationWorkContext,
  checkContext: boolean
) {
  const state: GitRunState = { failure: null, gaps: [] };
  const run = makeRunner(options, item.input, context, state);

  const located = yield* run([
    "rev-parse",
    "--path-format=absolute",
    "--show-toplevel",
    "--git-common-dir",
  ]);

  if (located.exitCode !== 0) {
    return yield* gitError(
      "source-unavailable",
      "The selected Git root is not a readable worktree."
    );
  }

  const locationLines = located.stdout.trim().split("\n");
  const [topLevel, commonDir] = locationLines;

  if (
    locationLines.length !== 2 ||
    topLevel !== item.input ||
    (item.context.worktreePath !== null &&
      item.context.worktreePath !== topLevel) ||
    (item.context.repoCommonDir !== null &&
      item.context.repoCommonDir !== commonDir)
  ) {
    return yield* gitError(
      "scope-denied",
      "The selected Git root resolved outside its enrolled worktree or repository identity."
    );
  }

  const head = yield* run(["rev-parse", "--verify", "HEAD"]);

  const refs = yield* run([
    "for-each-ref",
    "--format=%(refname)%09%(objectname)",
    "refs/heads/",
    "refs/remotes/",
  ]);

  const status = yield* run([
    "status",
    "--porcelain=v2",
    "--branch",
    "-z",
    "--untracked-files=all",
  ]);

  const current = parseStatusPorcelainV2(status.stdout);

  const branchSha =
    item.context.branch === current.branch
      ? head.stdout.trim()
      : refs.stdout
          .split("\n")
          .find((line) =>
            line.startsWith(`refs/heads/${item.context.branch ?? ""}\t`)
          )
          ?.split("\t")[1];

  if (
    checkContext &&
    ((item.context.headSha !== null && item.context.headSha !== branchSha) ||
      (item.source !== "collector.git-history" &&
        item.context.branch !== current.branch))
  ) {
    return yield* gitError(
      "scope-denied",
      "The selected Git branch or commit is outside the enrolled source context."
    );
  }

  const diff =
    head.exitCode === 0
      ? yield* run([
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--numstat",
          "HEAD",
          "--",
        ])
      : { exitCode: 0, stdout: "" };

  if ([refs, status, diff].some((output) => output.exitCode !== 0)) {
    return yield* gitError(
      "source-unavailable",
      "Git repository state could not be pinned within the reviewed bounds."
    );
  }

  if (refs.stdout.split("\n").filter(Boolean).length >= 200) {
    return yield* gitError(
      "budget-exhausted",
      "The selected repository has at least 200 refs; the pinned ref set is incomplete and needs a narrower reviewed acquisition."
    );
  }

  return snapshotDigest({
    context: item.context,
    diff: diff.stdout,
    head: head.stdout,
    located: located.stdout,
    refs: refs.stdout,
    status: status.stdout,
  });
});

const collectBatch = Effect.fn("boundedGit.collect")(function* collectBatch(
  options: BoundedGitOperationOptions,
  item: PlannedSource,
  context: OperationWorkContext
) {
  const state: GitRunState = { failure: null, gaps: [] };
  const run = makeRunner(options, item.input, context, state);

  const input: CollectInput = {
    adapterId: item.source,
    context: item.context,
    cursor: null,
    origin: "imported",
    scratchDir: null,
    selectedInput: item.input,
  };

  const textRunner = (cwd: string, args: readonly string[]) =>
    cwd === item.input
      ? run(args).pipe(
          Effect.mapError(sourceFailure(item.source)),
          Effect.flatMap((output) =>
            output.exitCode === 0
              ? Effect.succeed(output.stdout)
              : Effect.fail(
                  new SourceUnavailable({
                    adapterId: item.source,
                    message: `Git ${args[0] ?? ""} exited with code ${output.exitCode}.`,
                  })
                )
          )
        )
      : Effect.fail(
          new SourceUnavailable({
            adapterId: item.source,
            message: "Git attempted to read another worktree.",
          })
        );

  const observedAt = DateTime.formatIso(yield* DateTime.now);

  const batch: EventBatch = yield* Match.value(item.source).pipe(
    Match.when("collector.git-history", () =>
      collectGitHistory(input, { runner: textRunner })
    ),
    Match.when("collector.git-observation", () =>
      collectGitObservation(textRunner, input)
    ),
    Match.orElse(() =>
      resolveGitIdentity((args) =>
        run(args).pipe(Effect.mapError(sourceFailure(item.source)))
      ).pipe(
        Effect.flatMap((identity) =>
          buildGitContextBatch(identity, input, observedAt)
        ),
        Effect.provide(NodeServices.layer)
      )
    )
  );

  if (state.failure !== null) {
    return yield* state.failure;
  }

  return {
    ...batch,
    coverage: {
      ...batch.coverage,
      gaps: [
        ...batch.coverage.gaps,
        {
          code: "git.bounded-acquisition",
          message: `${[...new Set(state.gaps)].join(" ").slice(0, 3500)} ${METRIC_LIMITATION}`,
        },
      ],
      state: "partial" as const,
    },
  };
});

const emptyEffects = (generation: number): OperationReceipt["effects"] => ({
  backupArtifacts: [],
  backupIds: [],
  configDigest: null,
  evidenceIds: [],
  exportArtifacts: [],
  exports: [],
  filesChanged: [],
  remainingStoreGeneration: generation,
  removalReason: null,
  removedCount: 0,
  removedRefs: [],
});

export const makeBoundedGitOperationAdapter = (
  options: BoundedGitOperationOptions
): OperationAdapter => ({
  authorize: (plan, input, context) =>
    plan.consent.scopeDigest === operationScopeDigest(plan)
      ? options
          .enrollment(
            {
              arguments: plan.arguments,
              receiptIds: input.consentReceiptIds,
              scope: plan.scope,
            },
            context
          )
          .pipe(Effect.map((consent) => consent.state === "authorized"))
      : Effect.succeed(false),
  descriptor: {
    authorization: "existing-enrollment",
    cancellation: "between-steps",
    effects: {
      destructive: false,
      networkDestinations: [],
      reads: [
        "exact enrolled local Git roots; fixed read-only commands with capped stdout",
      ],
      writes: [options.env.storePath, spoolDirFor(options.env.storePath)],
    },
    enabled: true,
    idempotency: "durable-key",
    kind: "collect",
    reason: METRIC_LIMITATION,
    requiredInputs: [
      "source",
      "selectedRoots",
      "parserVersion",
      "existing Git enrollment",
    ],
    version: BOUNDED_GIT_OPERATION_VERSION,
  },
  execute: Effect.fn("boundedGit.execute")(
    function* execute(plan, step, context) {
      const selected = yield* selectedSources(options, plan);

      const item = selected.find(
        (candidate) =>
          sourceStepId(candidate.source, candidate.input) === step.id
      );

      if (item === undefined) {
        return yield* gitError(
          "scope-denied",
          "The Git operation step is outside the selected roots."
        );
      }

      const expected = plan.preconditions.find(
        (condition) =>
          condition.target === step.id && condition.kind === "source-identity"
      )?.expected;

      const before = yield* pinRepository(options, item, context, false);

      if (expected !== before) {
        return yield* gitError(
          "plan-stale",
          "The selected Git HEAD, refs, worktree state, or context changed before acquisition."
        );
      }

      const batch = yield* collectBatch(options, item, context).pipe(
        Effect.mapError(collectionFailure)
      );

      const after = yield* pinRepository(options, item, context, false);

      if (before !== after) {
        return yield* gitError(
          "plan-stale",
          "Git state changed during acquisition; no captured batch was imported."
        );
      }

      const remaining = yield* context.budget.remaining;

      if (batch.events.length > remaining.maxRecords) {
        return yield* gitError(
          "budget-exhausted",
          "Git emitted more normalized observations than the remaining reviewed record allowance."
        );
      }

      const normalized = {
        bytesRead: 0,
        filesRead: 0,
        recordsDecoded: batch.events.length,
        requests: 0,
        retries: 0,
      };

      const reservation = yield* context.budget.reserve(normalized);

      yield* reservation.complete(normalized);

      const appended = yield* Effect.uninterruptible(
        options.env.store.append(batch).pipe(
          Effect.map((result): GitAppendResult => ({
            ...result,
            spooledTo: null,
          })),
          Effect.catchTag("StoreBusy", () =>
            writeSpoolBatch(spoolDirFor(options.env.storePath), batch).pipe(
              Effect.map((spooledTo) => ({
                duplicates: 0,
                inserted: 0,
                spooledTo,
              }))
            )
          )
        )
      );

      const committed = appended.spooledTo === null;

      const lastEvent = committed
        ? (batch.events.at(-1)?.eventId ?? null)
        : null;

      const result: OperationStep = {
        ...step,
        committedThrough: lastEvent,
        duplicates: appended.duplicates,
        gaps: batch.coverage.gaps.map((gap) => gap.message).slice(0, 64),
        inserted: appended.inserted,
        rejected: null,
        remainingWork: committed
          ? "Git history and reflog queries were capped; older records may remain unread. Review another exact bounded acquisition for further coverage."
          : "The captured batch was staged; its drain has not been verified and no collection cursor advanced.",
        safeCursor: null,
        spooledRefs: appended.spooledTo === null ? [] : [appended.spooledTo],
        state: Match.value({
          committed,
          events: batch.events.length,
          inserted: appended.inserted,
        }).pipe(
          Match.when({ committed: false }, () => "spooled" as const),
          Match.when({ events: 0 }, () => "unchanged" as const),
          Match.when({ inserted: 0 }, () => "already-applied" as const),
          Match.orElse(() => "partial" as const)
        ),
      };

      return {
        effects: {
          ...emptyEffects(plan.storeGeneration),
          evidenceIds: lastEvent === null ? [] : [lastEvent],
          filesChanged: result.spooledRefs,
        },
        step: result,
      };
    }
  ),
  meteredWork: true,
  prepare: Effect.fn("boundedGit.prepare")(function* prepare(input, context) {
    const consent = yield* options.enrollment(
      { arguments: input.arguments, receiptIds: [], scope: input.scope },
      context
    );

    if (consent.state !== "authorized") {
      return yield* gitError(
        "authorization-required",
        consent.reason ??
          "Git acquisition requires an existing exact enrollment before its source probe."
      );
    }

    const selected = yield* selectedSources(options, input);
    const preconditions = [];

    for (const item of selected) {
      preconditions.push({
        allowAppend: false,
        expected: yield* pinRepository(options, item, context, true),
        kind: "source-identity" as const,
        target: sourceStepId(item.source, item.input),
      });
    }

    return {
      arguments: input.arguments,
      consent: { ...consent, scopeDigest: "pending" },
      effects: {
        destructive: false,
        networkDestinations: [],
        reads: selected.map((item) => item.input),
        writes: [options.env.storePath, spoolDirFor(options.env.storePath)],
      },
      expectedEvidenceImprovement:
        "Capture bounded local Git evidence with the existing collector's event identities and metrics.",
      forecast: { bytes: null, cost: null, elapsedMs: null, requests: null },
      preconditions,
      resumeBoundary: "atomic-step" as const,
      stopCondition: `Stop before another command or import when total output, record units, repository acquisitions, request count, or elapsed time reaches the reviewed bound. ${METRIC_LIMITATION}`,
    };
  }),
  probe: (_plan, step, receipt) => {
    const durable = receipt.steps.find((entry) => entry.id === step.id);

    if (
      durable !== undefined &&
      (["committed", "unchanged", "already-applied"].includes(durable.state) ||
        (durable.state === "partial" && durable.committedThrough !== null))
    ) {
      return Effect.succeed({
        result: { step: durable },
        state: "complete" as const,
      });
    }

    return Effect.succeed(
      durable?.state === "spooled"
        ? {
            reason:
              "A captured Git batch was staged, but this adapter has no proof that its exact staged batch drained.",
            state: "indeterminate" as const,
          }
        : { state: "absent" as const }
    );
  },
  replay: "safe",
  steps: (plan) => {
    const args = plan.arguments;

    return args.kind === "collect"
      ? args.selectedRoots.map((root) =>
          operationStep(sourceStepId(args.source, root), args.source)
        )
      : [];
  },
  validate: Effect.fn("boundedGit.validate")(function* validate(plan, context) {
    const selected = yield* selectedSources(options, plan);
    const changed: string[] = [];

    for (const item of selected) {
      const target = sourceStepId(item.source, item.input);

      const expected = plan.preconditions.find(
        (condition) =>
          condition.target === target && condition.kind === "source-identity"
      )?.expected;

      if (expected !== (yield* pinRepository(options, item, context, false))) {
        changed.push(
          `Git HEAD, refs, worktree state, or context changed for ${item.input}.`
        );
      }
    }

    return changed;
  }),
});
