import { Buffer, isUtf8 } from "node:buffer";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  // @effect-diagnostics-next-line nodeBuiltinImport:off -- File adapters inspect bounded selected files and commit reviewed local artifacts.
} from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Operation destinations are canonical paths within the selected local worktree.
import path from "node:path";

import {
  AgentError,
  AgentScopeSchema,
  AgentStore,
  operationStep,
} from "@rat-stack/core/dx";
import type {
  AgentScope,
  AgentStoreFailure,
  AgentStoreService,
  AnalysisBasisMetadata,
  OperationAdapter,
  OperationBounds,
  OperationEffectResult,
  OperationPlan,
  OperationPlanInput,
  OperationPreparation,
  OperationProbe,
  OperationReceipt,
  OperationStep,
  OperationWorkContext,
} from "@rat-stack/core/dx";
import { Context, Effect, Exit, Layer, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { CursorHooksAdapter } from "./dft-agent-cursor-hooks.js";
import { installAgentSkills } from "./dft-install.js";
import type { PreparedInstallationReader } from "./dft-install.js";
import { skillDigest, skillsSourceDir } from "./dft-skills.js";
import type { DftSkill } from "./dft-skills.js";

const VERSION = "dft.app-operations.v2";

const ABSENT = "absent";

const MAX_SKILLS = 32;

const GIT_IO_GAP =
  "Git internal disk I/O is unavailable; bytesRead measures bounded stdout, stderr and selected content.";

export interface AppOperationAdapterOptions {
  readonly store: AgentStoreService;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly scope: AgentScope | (() => AgentScope);
  readonly worktree: string | (() => string);
  readonly skillsSource?: string;
  readonly hookCommand?: () => string;
  readonly cursorHooksAdapter?: OperationAdapter;
  readonly resolveCurrentTarget?: (
    scope: AgentScope,
    context: OperationWorkContext
  ) => Effect.Effect<
    { readonly scope: AgentScope; readonly worktree: string },
    AgentStoreFailure
  >;
  readonly resolveCursorTarget?: (
    scope: AgentScope,
    context: OperationWorkContext
  ) => Effect.Effect<
    { readonly scope: AgentScope; readonly worktree: string },
    AgentStoreFailure
  >;
}

interface FileState {
  readonly path: string;
  readonly digest: string;
  readonly bytes: number;
}

interface SelectedFile {
  readonly state: FileState;
  readonly body: Buffer | null;
}

interface GuidanceSource {
  readonly files: readonly FileState[];
  readonly skills: readonly DftSkill[];
}

interface LocalBudget {
  readonly bounds: OperationBounds;
  readonly startedAt: number;
  bytesRead: number;
  filesRead: number;
  recordsDecoded: number;
  requests: number;
  unknownBytes: boolean;
  unknownRecords: boolean;
}

interface GuidanceSelection {
  readonly source: string;
  readonly ownership: string;
  readonly ownershipRoot: string;
  readonly sourceFiles: readonly FileState[];
  readonly skills: readonly DftSkill[];
  readonly targets: readonly FileState[];
  readonly backups: readonly FileState[];
  readonly contentDigest: string;
  readonly sourceDigest: string;
}

interface OwnershipLocation {
  readonly file: string;
  readonly root: string;
}

const localError = (code: AgentError["code"], message: string) =>
  new AgentError({
    code,
    currentRevision: null,
    expectedRevision: null,
    message,
    recovery: {
      action: code === "plan-stale" ? "replan" : "none",
      ref: null,
    },
    ref: null,
    retryable: false,
  });

const localFailure = (cause: unknown): AgentStoreFailure =>
  Schema.is(AgentError)(cause)
    ? cause
    : localError(
        "source-unavailable",
        "The selected local artifact could not be inspected or written."
      );

const local = <A>(work: () => A) =>
  Effect.try({ catch: localFailure, try: work });

const budgetFor = (bounds: OperationBounds): LocalBudget => ({
  bounds,
  bytesRead: 0,
  filesRead: 0,
  recordsDecoded: 0,
  requests: 0,
  startedAt: performance.now(),
  unknownBytes: false,
  unknownRecords: false,
});

const checkTime = (budget: LocalBudget): void => {
  if (performance.now() - budget.startedAt > budget.bounds.maxElapsedMs) {
    throw localError(
      "budget-exhausted",
      "The local operation reached its elapsed-time bound before further work."
    );
  }
};

const reserveBytes = (budget: LocalBudget, bytes: number): void => {
  checkTime(budget);

  if (bytes > budget.bounds.maxBytes - budget.bytesRead) {
    throw localError(
      "budget-exhausted",
      "The selected file bytes exceed the operation bound."
    );
  }
};

const reserveRecords = (budget: LocalBudget, count: number): void => {
  checkTime(budget);

  if (count > budget.bounds.maxRecords - budget.recordsDecoded) {
    throw localError(
      "budget-exhausted",
      "The selected decoded records exceed the operation bound."
    );
  }
};

const reserveFileReads = (budget: LocalBudget, count: number): void => {
  checkTime(budget);

  if (count > budget.bounds.maxFiles - budget.filesRead) {
    throw localError(
      "budget-exhausted",
      "The remaining selected file work exceeds the operation bound."
    );
  }
};

const inside = (root: string, file: string): boolean => {
  const relative = path.relative(root, file);

  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
};

const checkPath = (root: string, file: string, directory = false): void => {
  if (!inside(root, file)) {
    throw localError(
      "scope-denied",
      "The selected path is outside its reviewed local root."
    );
  }

  const parts = path.relative(root, file).split(path.sep);

  for (let index = 0; index < parts.length; index += 1) {
    const item = lstatSync(path.join(root, ...parts.slice(0, index + 1)), {
      throwIfNoEntry: false,
    });

    if (item === undefined) {
      continue;
    }

    const finalFile = index === parts.length - 1 && !directory;

    if (
      item.isSymbolicLink() ||
      (finalFile ? !item.isFile() : !item.isDirectory())
    ) {
      throw localError(
        "scope-denied",
        "A selected artifact has a linked or conflicting path."
      );
    }
  }
};

const readSelectedFile = (
  root: string,
  file: string,
  budget: LocalBudget
): SelectedFile => {
  checkPath(root, file);
  checkTime(budget);

  if (budget.filesRead >= budget.bounds.maxFiles) {
    throw localError(
      "budget-exhausted",
      "The selected files exceed the operation bound."
    );
  }

  budget.filesRead += 1;

  if (!existsSync(file)) {
    return { body: null, state: { bytes: 0, digest: ABSENT, path: file } };
  }

  const fd = openSync(file, constants.O_RDONLY + constants.O_NOFOLLOW);

  try {
    const stat = fstatSync(fd);

    if (!stat.isFile()) {
      throw localError(
        "scope-denied",
        "The selected artifact is not a regular file."
      );
    }

    reserveBytes(budget, stat.size);
    const body = Buffer.alloc(stat.size);
    let offset = 0;

    while (offset < body.length) {
      checkTime(budget);
      const count = readSync(fd, body, offset, body.length - offset, offset);

      if (count === 0) {
        throw localError(
          "plan-stale",
          "The selected file changed during inspection."
        );
      }

      offset += count;
      budget.bytesRead += count;
    }

    const after = fstatSync(fd);

    if (
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs
    ) {
      throw localError(
        "plan-stale",
        "The selected file changed during inspection."
      );
    }

    return {
      body,
      state: { bytes: body.length, digest: skillDigest(body), path: file },
    };
  } finally {
    closeSync(fd);
  }
};

const readFileState = (
  root: string,
  file: string,
  budget: LocalBudget
): FileState => readSelectedFile(root, file, budget).state;

const fingerprint = (files: readonly FileState[]): string =>
  skillDigest(
    JSON.stringify(
      files.toSorted((left, right) => left.path.localeCompare(right.path))
    )
  );

const gitPath = Effect.fn("appOperations.gitPath")(function* gitPath(
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  worktree: string,
  args: readonly string[],
  budget: LocalBudget
): Effect.fn.Return<string | null, AgentStoreFailure> {
  yield* local(() => {
    reserveRecords(budget, 1);
    reserveBytes(budget, 1);
    reserveFileReads(budget, 1);

    if (budget.requests >= budget.bounds.maxRequests) {
      throw localError(
        "budget-exhausted",
        "The reviewed native-command allowance is exhausted before another Git invocation."
      );
    }
  });

  const chunks: Uint8Array[] = [];
  const cap = budget.bounds.maxBytes - budget.bytesRead;
  const received = { bytes: 0, stdout: 0 };

  const remainingMs =
    budget.bounds.maxElapsedMs -
    Math.ceil(performance.now() - budget.startedAt);

  const result = yield* Effect.scoped(
    Effect.gen(function* readGitPath() {
      yield* local(() => {
        checkTime(budget);
        budget.requests += 1;
        budget.filesRead += 1;
      });

      const handle = yield* spawner.spawn(
        ChildProcess.make(
          "git",
          ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args],
          {
            cwd: worktree,
            killSignal: "SIGKILL",
            stderr: "pipe",
            stdin: "ignore",
            stdout: "pipe",
          }
        )
      );

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* reapGitPath() {
          if (yield* handle.isRunning.pipe(Effect.orElseSucceed(() => true))) {
            yield* handle.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore);
          }

          yield* handle.exitCode.pipe(Effect.ignore);
        })
      );

      const consume = (stream: typeof handle.stdout, retain: boolean) =>
        stream.pipe(
          Stream.runForEach((chunk) =>
            local(() => {
              received.bytes += chunk.byteLength;
              budget.bytesRead += chunk.byteLength;

              if (received.bytes > cap) {
                throw localError(
                  "budget-exhausted",
                  "The selected Git stdout and stderr exceeded their shared output allowance."
                );
              }

              checkTime(budget);

              if (retain) {
                received.stdout += chunk.byteLength;
                chunks.push(chunk);
              }
            })
          )
        );

      yield* Effect.all(
        [consume(handle.stdout, true), consume(handle.stderr, false)],
        { concurrency: 2 }
      );

      return Number(yield* handle.exitCode);
    }).pipe(
      Effect.timeout(Math.max(1, remainingMs)),
      Effect.catchTag("TimeoutError", () =>
        Effect.fail(
          localError(
            "budget-exhausted",
            "The selected native Git command reached its reviewed elapsed-time bound."
          )
        )
      )
    )
  ).pipe(Effect.mapError(localFailure));

  if (result !== 0) {
    return null;
  }

  return yield* local(() => {
    checkTime(budget);
    const output = Buffer.concat(chunks, received.stdout);

    if (!isUtf8(output)) {
      throw localError(
        "source-unavailable",
        "The selected Git path output is not valid UTF-8."
      );
    }

    budget.recordsDecoded += 1;

    return output.toString("utf-8").trim();
  });
});

const ownershipLocation = Effect.fn("appOperations.ownershipLocation")(
  function* ownershipLocation(
    spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
    worktree: string,
    budget: LocalBudget
  ): Effect.fn.Return<OwnershipLocation, AgentStoreFailure> {
    const name = `${skillDigest(".agents").slice(0, 16)}.json`;

    const directory = yield* gitPath(
      spawner,
      worktree,
      ["rev-parse", "--absolute-git-dir"],
      budget
    );

    if (directory === null) {
      return {
        file: path.join(worktree, ".agents", "dft-install.ownership.json"),
        root: worktree,
      };
    }

    const root = yield* local(() => realpathSync(directory));

    const selected = yield* gitPath(
      spawner,
      worktree,
      ["rev-parse", "--git-path", `dft-install/${name}`],
      budget
    );

    if (selected === null) {
      return yield* localError(
        "source-unavailable",
        "The selected Git ownership path could not be resolved."
      );
    }

    return yield* local(() => {
      checkTime(budget);
      const file = path.resolve(worktree, selected);
      checkPath(root, file);

      return { file, root };
    });
  }
);

const guidanceSourceFiles = (
  source: string,
  budget: LocalBudget
): GuidanceSource => {
  reserveFileReads(budget, 1);
  const directory = opendirSync(source);
  const files: FileState[] = [];
  const skills: DftSkill[] = [];
  let entries = 0;

  try {
    for (
      let entry = directory.readSync();
      entry !== null;
      entry = directory.readSync()
    ) {
      checkTime(budget);
      entries += 1;

      if (entries > Math.min(MAX_SKILLS, budget.bounds.maxFiles)) {
        throw localError(
          "budget-exhausted",
          "The packaged guidance directory exceeds the selected file bound."
        );
      }

      if (entry.isSymbolicLink()) {
        throw localError(
          "scope-denied",
          "The packaged guidance directory contains a linked entry."
        );
      }

      if (!entry.isDirectory()) {
        continue;
      }

      const file = path.join(source, entry.name, "SKILL.md");
      const selected = readSelectedFile(source, file, budget);

      if (selected.body !== null) {
        reserveRecords(budget, 1);

        if (!isUtf8(selected.body)) {
          throw localError(
            "source-unavailable",
            "The selected packaged guidance is not valid UTF-8 text."
          );
        }

        files.push(selected.state);
        skills.push({
          body: selected.body.toString("utf-8"),
          name: entry.name,
        });
        budget.recordsDecoded += 1;
      }
    }
  } finally {
    directory.closeSync();
  }

  if (files.length === 0) {
    throw localError(
      "source-unavailable",
      "This build has no packaged guidance to install."
    );
  }

  return {
    files: files.toSorted((left, right) => left.path.localeCompare(right.path)),
    skills: skills.toSorted((left, right) =>
      left.name.localeCompare(right.name)
    ),
  };
};

const installerBackup = (ownership: string, file: FileState): string =>
  path.join(
    path.dirname(ownership),
    "backups",
    `${skillDigest(file.path).slice(0, 16)}-${file.digest}.backup`
  );

const guidanceSelection = Effect.fn("appOperations.guidanceSelection")(
  function* guidanceSelection(
    options: AppOperationAdapterOptions,
    worktree: string,
    budget: LocalBudget
  ): Effect.fn.Return<GuidanceSelection, AgentStoreFailure> {
    const source = yield* local(() => {
      const selectedSourcePath = path.resolve(
        options.skillsSource ?? skillsSourceDir()
      );

      const canonical = realpathSync(selectedSourcePath);

      if (canonical !== selectedSourcePath) {
        throw localError(
          "scope-denied",
          "The selected packaged guidance root must be a canonical path without links."
        );
      }

      return canonical;
    });

    const selectedSource = yield* local(() =>
      guidanceSourceFiles(source, budget)
    );

    const sourceFiles = selectedSource.files;

    const ownership = yield* ownershipLocation(
      options.spawner,
      worktree,
      budget
    );

    return yield* local(() => {
      const targets = sourceFiles.map((file) =>
        readFileState(
          worktree,
          path.join(
            worktree,
            ".agents",
            "skills",
            path.basename(path.dirname(file.path)),
            "SKILL.md"
          ),
          budget
        )
      );

      targets.push(readFileState(ownership.root, ownership.file, budget));

      const backups = targets
        .filter(
          (file) => file.path !== ownership.file && file.digest !== ABSENT
        )
        .map((file) =>
          readFileState(
            ownership.root,
            installerBackup(ownership.file, file),
            budget
          )
        );

      for (const file of targets.filter(
        (item) => item.path !== ownership.file && item.digest !== ABSENT
      )) {
        const backup = backups.find(
          (item) => item.path === installerBackup(ownership.file, file)
        );

        if (
          backup !== undefined &&
          backup.digest !== ABSENT &&
          backup.digest !== file.digest
        ) {
          throw localError(
            "plan-stale",
            "An existing installer backup has different contents from its reviewed digest."
          );
        }
      }

      return {
        backups,
        contentDigest: fingerprint(targets),
        ownership: ownership.file,
        ownershipRoot: ownership.root,
        skills: selectedSource.skills,
        source,
        sourceDigest: fingerprint(sourceFiles),
        sourceFiles,
        targets,
      };
    });
  }
);

const scopeKey = (scope: AgentScope): string =>
  JSON.stringify({
    branchSelection: {
      branches: scope.branchSelection.branches,
      kind: scope.branchSelection.kind,
    },
    flightId: scope.flightId,
    repoId: scope.repoId,
    sources: scope.sources,
    tools: scope.tools,
    worktreeId: scope.worktreeId,
  });

const sameScope = (left: AgentScope, right: AgentScope): boolean =>
  scopeKey(left) === scopeKey(right);

const scopeFor = (options: AppOperationAdapterOptions): AgentScope =>
  Schema.is(AgentScopeSchema)(options.scope) ? options.scope : options.scope();

const worktreePathFor = (options: AppOperationAdapterOptions): string =>
  Schema.is(Schema.String)(options.worktree)
    ? options.worktree
    : options.worktree();

const withWorktree = <A, E>(
  options: AppOperationAdapterOptions,
  work: (worktree: string) => Effect.Effect<A, E>
) =>
  local(() => realpathSync(worktreePathFor(options))).pipe(
    Effect.flatMap(work)
  );

const meteredPhase = Effect.fn("appOperations.meteredPhase")(
  function* meteredPhase<A, E>(
    options: AppOperationAdapterOptions,
    scope: AgentScope,
    context: OperationWorkContext,
    work: (
      worktree: string,
      budget: LocalBudget,
      selected: AppOperationAdapterOptions
    ) => Effect.Effect<A, E>
  ) {
    const target =
      options.resolveCurrentTarget === undefined
        ? null
        : yield* options.resolveCurrentTarget(scope, context);

    const selected = target === null ? options : { ...options, ...target };
    const remaining = yield* context.budget.remaining;

    const reserved = yield* context.budget.reserve({
      bytesRead: remaining.maxBytes,
      filesRead: remaining.maxFiles,
      recordsDecoded: remaining.maxRecords,
      requests: remaining.maxRequests,
      retries: 0,
    });

    const budget = budgetFor(remaining);

    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* settleLocalPhase() {
        const outcome = yield* Effect.exit(
          restore(
            withWorktree(selected, (worktree) =>
              work(worktree, budget, selected)
            )
          )
        );

        yield* reserved.complete({
          byteUnits: budget.unknownBytes
            ? remaining.maxBytes
            : budget.bytesRead,
          bytesRead: budget.unknownBytes ? null : budget.bytesRead,
          filesRead: budget.filesRead,
          recordUnits: budget.unknownRecords
            ? remaining.maxRecords
            : budget.recordsDecoded,
          recordsDecoded: budget.unknownRecords ? null : budget.recordsDecoded,
          requests: budget.requests,
          retries: 0,
        });

        if (Exit.isFailure(outcome)) {
          return yield* Effect.failCause(outcome.cause);
        }

        return outcome.value;
      })
    );
  }
);

const assertScope = (
  options: AppOperationAdapterOptions,
  worktree: string,
  scope: AgentScope
): void => {
  if (
    !sameScope(scopeFor(options), scope) ||
    scope.repoId === null ||
    scope.worktreeId !== worktree ||
    scope.branchSelection.kind === "unresolved"
  ) {
    throw localError(
      "scope-denied",
      "Select the exact resolved repository, worktree and branch scope of this runtime."
    );
  }
};

const assertTarget = Effect.fn("appOperations.assertTarget")(
  function* assertTarget(
    options: AppOperationAdapterOptions,
    worktree: string,
    input: OperationPlanInput
  ) {
    yield* local(() => {
      assertScope(options, worktree, input.scope);
    });
    const identity = yield* options.store.identity;

    if (
      input.target.storeId !== identity.storeId ||
      input.target.storeGeneration !== identity.storeGeneration
    ) {
      return yield* localError(
        "stale-generation",
        "The operation targets a different store or generation."
      );
    }

    return identity;
  }
);

const preconditionFor = (
  file: FileState
): OperationPlan["preconditions"][number] => ({
  allowAppend: false,
  expected: file.digest,
  kind: "selected-content",
  target: file.path,
});

const preparation = (
  input: OperationPlanInput,
  argumentsValue: OperationPreparation["arguments"],
  reads: readonly string[],
  writes: readonly string[],
  preconditions: OperationPlan["preconditions"],
  bytes: number,
  reason: string
): OperationPreparation => ({
  arguments: argumentsValue,
  consent: {
    reason,
    receiptIds: [],
    scopeDigest: "assigned-by-coordinator",
    state: "required",
  },
  effects: { destructive: false, networkDestinations: [], reads, writes },
  expectedEvidenceImprovement:
    input.arguments.kind === "export"
      ? "Preserve the selected basis metadata and its disclosure policy in a local file."
      : "Install this build's native Codex guidance while preserving edited and unowned files.",
  forecast: { bytes, cost: null, elapsedMs: null, requests: null },
  preconditions: [
    ...preconditions,
    {
      allowAppend: false,
      expected: VERSION,
      kind: "parser-version",
      target: "dft-app-operation-adapter-version",
    },
  ],
  resumeBoundary: input.arguments.kind === "configure" ? "none" : "atomic-step",
  stopCondition:
    "Stop after the selected local artifacts are verified; inspect uncertain external progress before retry. The native-command forecast is unavailable until validation and recovery paths are selected.",
});

const generationPrecondition = (
  storeId: string,
  generation: number
): OperationPlan["preconditions"][number] => ({
  allowAppend: false,
  expected: String(generation),
  kind: "store-generation",
  target: storeId,
});

const baseEffects = (plan: OperationPlan): OperationReceipt["effects"] => ({
  backupArtifacts: [],
  backupIds: [],
  configDigest: null,
  evidenceIds: [],
  exportArtifacts: [],
  exports: [],
  filesChanged: [],
  remainingStoreGeneration: plan.storeGeneration,
  removalReason:
    "This local file operation does not remove recorded observations.",
  removedCount: null,
  removedRefs: [],
});

const resources = (budget: LocalBudget): OperationReceipt["resources"] => ({
  bytesRead: budget.bytesRead,
  elapsedMs: Math.ceil(performance.now() - budget.startedAt),
  recordsDecoded: budget.recordsDecoded,
  requests: budget.requests,
  retries: 0,
});

const backupArtifact = (
  plan: OperationPlan,
  file: FileState
): OperationReceipt["effects"]["backupArtifacts"][number] => ({
  contentDigest: file.digest,
  id: file.path,
  restorationVersion: VERSION,
  storeGeneration: plan.storeGeneration,
  storeId: plan.storeId,
});

const confirmed = (
  plan: OperationPlan,
  confirmation: string | null | undefined
): boolean =>
  confirmation ===
  `${plan.kind === "configure" ? "INSTALL CODEX GUIDANCE" : "EXPORT METADATA"} ${plan.consent.scopeDigest}`;

const hasReviewedVersion = (plan: OperationPlan): boolean =>
  plan.preconditions.some(
    (condition) =>
      condition.kind === "parser-version" &&
      condition.target === "dft-app-operation-adapter-version" &&
      condition.expected === VERSION
  );

const reviewedPlanWork = <A>(
  plan: OperationPlan,
  work: Effect.Effect<A, AgentStoreFailure>
): Effect.Effect<A, AgentStoreFailure> =>
  hasReviewedVersion(plan)
    ? work
    : Effect.fail(
        localError(
          "plan-stale",
          "The reviewed local adapter version changed; create a new plan before target resolution or further work."
        )
      );

const commonValidation = Effect.fn("appOperations.commonValidation")(
  function* commonValidation(
    options: AppOperationAdapterOptions,
    worktree: string,
    plan: OperationPlan
  ) {
    yield* local(() => {
      assertScope(options, worktree, plan.scope);
    });
    const identity = yield* options.store.identity;

    return identity.storeId === plan.storeId &&
      identity.storeGeneration === plan.storeGeneration
      ? []
      : ["store-generation"];
  }
);

const descriptor = (
  kind: "configure" | "export",
  worktree: string,
  resolvesGit = kind === "configure"
): OperationAdapter["descriptor"] => ({
  authorization: "explicit-confirmation",
  cancellation: "before-start-only",
  effects: {
    destructive: false,
    networkDestinations: [],
    reads: [
      ...(kind === "configure"
        ? ["selected packaged guidance", "selected installer ownership record"]
        : ["selected retained basis metadata", "selected export destination"]),
      ...(resolvesGit ? [GIT_IO_GAP] : []),
    ],
    writes:
      kind === "configure"
        ? [
            path.join(worktree, ".agents", "skills"),
            "reviewed installer ownership and backup paths",
          ]
        : [
            path.join(worktree, ".dft", "exports"),
            path.join(worktree, ".dft", "operation-backups"),
          ],
  },
  enabled: true,
  idempotency: "durable-key",
  kind,
  reason: null,
  requiredInputs:
    kind === "configure"
      ? [
          "path: canonical .agents/skills",
          "settings: host=codex, action=install-guidance",
          "expectedContentDigest: current or reviewed digest",
          "typed confirmation: INSTALL CODEX GUIDANCE <consent.scopeDigest>",
        ]
      : [
          "basisId",
          "disclosure: metadata-only",
          "destination: canonical .dft/exports/<name>.json",
          "typed confirmation: EXPORT METADATA <consent.scopeDigest>",
        ],
  version: VERSION,
});

const prepareGuidance = Effect.fn("appOperations.prepareGuidance")(
  function* prepareGuidance(
    options: AppOperationAdapterOptions,
    worktree: string,
    input: OperationPlanInput,
    budget: LocalBudget
  ): Effect.fn.Return<OperationPreparation, AgentStoreFailure> {
    const identity = yield* assertTarget(options, worktree, input);

    if (
      input.arguments.kind !== "configure" ||
      input.arguments.path !== path.join(worktree, ".agents", "skills") ||
      input.arguments.settings.host !== "codex" ||
      input.arguments.settings.action !== "install-guidance" ||
      Object.keys(input.arguments.settings).length !== 2
    ) {
      return yield* localError(
        "invalid-selector",
        "This adapter configures only explicit packaged Codex guidance in this worktree."
      );
    }

    const selection = yield* guidanceSelection(options, worktree, budget);

    if (
      input.arguments.expectedContentDigest !== "current" &&
      input.arguments.expectedContentDigest !== selection.contentDigest
    ) {
      return yield* localError(
        "plan-stale",
        "The selected guidance contents do not match the requested digest."
      );
    }

    return preparation(
      input,
      {
        ...input.arguments,
        expectedContentDigest: selection.contentDigest,
        settings: {
          ...input.arguments.settings,
          packagedDigest: selection.sourceDigest,
          sourceDirectory: selection.source,
        },
      },
      [
        ...[
          ...selection.sourceFiles,
          ...selection.targets,
          ...selection.backups,
        ].map((file) => file.path),
        GIT_IO_GAP,
      ],
      [...selection.targets, ...selection.backups].map((file) => file.path),
      [
        generationPrecondition(identity.storeId, identity.storeGeneration),
        ...[
          ...selection.sourceFiles,
          ...selection.targets,
          ...selection.backups,
        ].map(preconditionFor),
      ],
      budget.bytesRead,
      "Confirm INSTALL CODEX GUIDANCE followed by consent.scopeDigest; this changes only the reviewed project guidance and installer artifacts."
    );
  }
);

const guidanceChanges = (
  plan: OperationPlan,
  selection: GuidanceSelection
): string[] => {
  const changed: string[] = [];

  if (plan.arguments.kind !== "configure") {
    return ["arguments"];
  }

  if (selection.contentDigest !== plan.arguments.expectedContentDigest) {
    changed.push("selected-content");
  }

  if (
    selection.sourceDigest !== plan.arguments.settings.packagedDigest ||
    selection.source !== plan.arguments.settings.sourceDirectory
  ) {
    changed.push("packaged-guidance");
  }

  const actual = new Map(
    [...selection.sourceFiles, ...selection.targets, ...selection.backups].map(
      (file) => [file.path, file.digest]
    )
  );

  for (const condition of plan.preconditions.filter(
    (item) => item.kind === "selected-content"
  )) {
    if (actual.get(condition.target) !== condition.expected) {
      changed.push(condition.target);
    }
  }

  return changed;
};

const installerReader = (
  worktree: string,
  selected: GuidanceSelection,
  budget: LocalBudget
): PreparedInstallationReader => {
  const expected = new Map(
    [...selected.targets, ...selected.backups].map((file) => [
      file.path,
      file.digest,
    ])
  );

  return (file, purpose) => {
    if (!expected.has(file)) {
      throw localError(
        "scope-denied",
        "The installer requested a file outside its exact reviewed artifact set."
      );
    }

    const root = inside(selected.ownershipRoot, file)
      ? selected.ownershipRoot
      : worktree;

    const loaded = readSelectedFile(root, file, budget);

    if (loaded.state.digest !== expected.get(file)) {
      throw localError(
        "plan-stale",
        "A reviewed guidance installer file changed before its bounded read."
      );
    }

    if (purpose === "text" && loaded.body !== null) {
      reserveRecords(budget, 1);

      if (!isUtf8(loaded.body)) {
        throw localError(
          "source-unavailable",
          "The reviewed installer artifact is not valid UTF-8 text."
        );
      }

      budget.recordsDecoded += 1;
    }

    return loaded.body;
  };
};

const validateGuidance = Effect.fn("appOperations.validateGuidance")(
  function* validateGuidance(
    options: AppOperationAdapterOptions,
    worktree: string,
    plan: OperationPlan,
    budget: LocalBudget
  ) {
    const changed = yield* commonValidation(options, worktree, plan);

    const selection = yield* guidanceSelection(options, worktree, budget);

    return [...changed, ...guidanceChanges(plan, selection)];
  }
);

const executeGuidance = Effect.fn("appOperations.executeGuidance")(
  function* executeGuidance(
    options: AppOperationAdapterOptions,
    worktree: string,
    plan: OperationPlan,
    step: OperationStep,
    confirmation: string | null,
    budget: LocalBudget
  ): Effect.fn.Return<OperationEffectResult, AgentStoreFailure> {
    if (!confirmed(plan, confirmation)) {
      return yield* localError(
        "authorization-required",
        "Use the exact typed confirmation from the reviewed guidance plan."
      );
    }

    const changed = yield* commonValidation(options, worktree, plan);

    const before = yield* guidanceSelection(options, worktree, budget);

    if (changed.length > 0 || guidanceChanges(plan, before).length > 0) {
      return yield* localError(
        "plan-stale",
        "The selected guidance plan changed before execution."
      );
    }

    const installed = yield* local(() => {
      const sourceBytes = before.sourceFiles.reduce(
        (sum, file) => sum + file.bytes,
        0
      );

      const targetBytes = before.targets.reduce(
        (sum, file) => sum + file.bytes,
        0
      );

      const repeatedFiles = before.targets.length;

      reserveBytes(budget, targetBytes);
      reserveFileReads(
        budget,
        repeatedFiles * 2 +
          before.sourceFiles.length * 3 +
          before.backups.length
      );

      const decodedRecords =
        before.targets.filter(
          (file) => file.path !== before.ownership && file.digest !== ABSENT
        ).length + 1;

      reserveRecords(budget, decodedRecords);

      const previousOwnership = before.targets.find(
        (file) => file.path === before.ownership
      )?.digest;

      if (previousOwnership === undefined) {
        throw localError(
          "plan-stale",
          "The reviewed guidance installer ownership is missing."
        );
      }

      let ownershipDigest = previousOwnership;
      let admittedOwnership: string | null = null;

      const steps = installAgentSkills(worktree, before.source, {
        maxOwnershipBytes: budget.bounds.maxBytes - budget.bytesRead,
        onOwnershipWrite: (file, body, phase) => {
          if (file !== before.ownership) {
            throw localError(
              "scope-denied",
              "The prepared installer requested an unreviewed ownership write."
            );
          }

          const expected = body === null ? ABSENT : skillDigest(body);

          if (phase === "before") {
            const current = readFileState(
              before.ownershipRoot,
              before.ownership,
              budget
            );

            if (current.digest !== previousOwnership) {
              throw localError(
                "plan-stale",
                "The reviewed guidance ownership changed before mutation."
              );
            }

            reserveBytes(
              budget,
              (body === null ? 0 : Buffer.byteLength(body)) +
                sourceBytes +
                targetBytes * 3
            );
            admittedOwnership = expected;

            return;
          }

          if (expected !== admittedOwnership) {
            throw localError(
              "plan-stale",
              "The installer ownership differs from its exact admitted contents."
            );
          }

          ownershipDigest = expected;
        },
        ownershipPath: before.ownership,
        readFile: installerReader(worktree, before, budget),
        skills: before.skills,
      });

      return { ownershipDigest, steps };
    });

    const result = installed.steps;

    const after = yield* local(() =>
      before.targets.map((file) =>
        readFileState(
          file.path === before.ownership ? before.ownershipRoot : worktree,
          file.path,
          budget
        )
      )
    );

    const exactTargets = after.every((file) => {
      if (file.path === before.ownership) {
        return file.digest === installed.ownershipDigest;
      }

      const installedStep = result.find((item) => item.path === file.path);

      const skill = before.skills.find(
        (item) =>
          path.join(worktree, ".agents", "skills", item.name, "SKILL.md") ===
          file.path
      );

      const expected =
        installedStep !== undefined &&
        installedStep.action !== "skipped" &&
        skill !== undefined
          ? skillDigest(skill.body)
          : before.targets.find((item) => item.path === file.path)?.digest;

      return file.digest === expected;
    });

    if (!exactTargets) {
      return yield* localError(
        "source-unavailable",
        "A selected guidance target changed before its exact postcondition could be verified."
      );
    }

    const contentDigest = fingerprint(after);

    const filesChanged = after
      .filter(
        (file) =>
          before.targets.find((old) => old.path === file.path)?.digest !==
            file.digest &&
          (file.path === before.ownership ||
            result.some(
              (item) =>
                item.path === file.path &&
                (item.action === "created" || item.action === "updated")
            ))
      )
      .map((file) => file.path);

    const backupFiles = yield* local(() =>
      before.targets
        .filter(
          (file) =>
            file.path !== before.ownership &&
            file.digest !== ABSENT &&
            result.some(
              (item) => item.path === file.path && item.action === "updated"
            )
        )
        .map((file) =>
          readFileState(
            before.ownershipRoot,
            installerBackup(before.ownership, file),
            budget
          )
        )
    );

    if (
      backupFiles.some(
        (file) =>
          before.targets.find(
            (old) => installerBackup(before.ownership, old) === file.path
          )?.digest !== file.digest
      )
    ) {
      return yield* localError(
        "source-unavailable",
        "A guidance backup could not be verified against its reviewed previous contents."
      );
    }

    const gaps = result
      .filter((item) => item.action === "skipped")
      .map((item) => item.detail);

    const completedState = filesChanged.length > 0 ? "committed" : "unchanged";

    return {
      effects: {
        ...baseEffects(plan),
        backupArtifacts: backupFiles.map((file) => backupArtifact(plan, file)),
        backupIds: backupFiles.map((file) => file.path),
        configDigest: contentDigest,
        filesChanged,
      },
      resources: resources(budget),
      step: {
        ...step,
        committedThrough: contentDigest,
        gaps: [...gaps, GIT_IO_GAP],
        remainingWork:
          gaps.length > 0
            ? "Edited or unowned guidance was preserved; inspect these gaps before a new plan."
            : null,
        state: gaps.length > 0 ? "partial" : completedState,
      },
    };
  }
);

const probeGuidance = Effect.fn("appOperations.probeGuidance")(
  function* probeGuidance(
    options: AppOperationAdapterOptions,
    worktree: string,
    plan: OperationPlan,
    step: OperationStep,
    receipt: OperationReceipt,
    budget: LocalBudget
  ): Effect.fn.Return<OperationProbe, AgentStoreFailure> {
    const generationChanged = yield* commonValidation(options, worktree, plan);

    if (generationChanged.length > 0) {
      return yield* localError(
        "stale-generation",
        "The guidance plan belongs to a different store generation."
      );
    }

    if (
      receipt.planId !== plan.id ||
      receipt.planDigest !== plan.planDigest ||
      receipt.storeId !== plan.storeId ||
      receipt.storeGeneration !== plan.storeGeneration
    ) {
      return {
        reason:
          "The supplied guidance receipt is not bound to this reviewed plan and store generation.",
        state: "indeterminate",
      };
    }

    const ownership = yield* ownershipLocation(
      options.spawner,
      worktree,
      budget
    );

    const targets = yield* local(() =>
      plan.effects.writes
        .filter(
          (file) =>
            !inside(path.join(path.dirname(ownership.file), "backups"), file)
        )
        .map((file) =>
          readFileState(
            file === ownership.file ? ownership.root : worktree,
            file,
            budget
          )
        )
    );

    const committed = receipt.steps.find(
      (item) =>
        item.id === step.id &&
        ["committed", "unchanged", "already-applied"].includes(item.state)
    );

    if (
      receipt.effects.configDigest !== null &&
      fingerprint(targets) === receipt.effects.configDigest &&
      committed?.committedThrough === receipt.effects.configDigest
    ) {
      const requiredBackups = plan.preconditions.filter(
        (item) =>
          item.kind === "selected-content" &&
          item.target !== ownership.file &&
          item.expected !== ABSENT &&
          receipt.effects.filesChanged.includes(item.target)
      );

      const backups = yield* local(
        () =>
          requiredBackups.every((item) =>
            receipt.effects.backupArtifacts.some(
              (backup) =>
                backup.id ===
                  installerBackup(ownership.file, {
                    bytes: 0,
                    digest: item.expected,
                    path: item.target,
                  }) && backup.contentDigest === item.expected
            )
          ) &&
          receipt.effects.backupArtifacts.every(
            (item) =>
              item.storeId === plan.storeId &&
              item.storeGeneration === plan.storeGeneration &&
              readFileState(ownership.root, item.id, budget).digest ===
                item.contentDigest
          )
      );

      return backups
        ? {
            result: {
              effects: receipt.effects,
              resources: resources(budget),
              step: {
                ...step,
                committedThrough: receipt.effects.configDigest,
                gaps: [...new Set([...step.gaps, GIT_IO_GAP])],
                state: "already-applied",
              },
            },
            state: "complete",
          }
        : {
            reason:
              "A committed installer backup no longer matches the durable receipt.",
            state: "indeterminate",
          };
    }

    const selected = yield* guidanceSelection(options, worktree, budget);

    const unchanged = guidanceChanges(plan, selected);

    return unchanged.length === 0
      ? { state: "absent" }
      : {
          reason:
            "Guidance or ownership changed without an exact durable completion result; inspect the files before retry.",
          state: "indeterminate",
        };
  }
);

const exportDestination = (worktree: string, destination: string): string => {
  const directory = path.join(worktree, ".dft", "exports");
  const canonical = path.join(directory, path.basename(destination));

  if (
    destination !== canonical ||
    !destination.endsWith(".json") ||
    path.basename(destination) === ".json"
  ) {
    throw localError(
      "scope-denied",
      "Select one canonical JSON filename directly inside this worktree's .dft/exports directory."
    );
  }

  checkPath(worktree, destination);

  return canonical;
};

const exportBackup = (worktree: string, file: FileState): string =>
  path.join(
    worktree,
    ".dft",
    "operation-backups",
    `${skillDigest(file.path).slice(0, 16)}-${file.digest}.backup`
  );

const exportTemporary = (destination: string, digest: string): string =>
  `${destination}.dft-${digest.slice(0, 16)}.tmp`;

const metadataBytes = (basis: AnalysisBasisMetadata): string =>
  `${JSON.stringify({ basis, disclosure: "metadata-only", schemaVersion: "dft.basis-export.v1" }, null, 2)}\n`;

const selectedMetadata = Effect.fn("appOperations.selectedMetadata")(
  function* selectedMetadata(
    options: AppOperationAdapterOptions,
    worktree: string,
    basisId: string,
    budget: LocalBudget,
    storeId: string,
    storeGeneration: number
  ) {
    yield* local(() => {
      reserveRecords(budget, 1);
    });

    const selected = yield* options.store
      .readBasisMetadata(
        { id: basisId, storeGeneration, storeId },
        budget.bounds.maxBytes - budget.bytesRead
      )
      .pipe(
        Effect.tapError((error) =>
          Effect.sync(() => {
            if (
              !Schema.is(AgentError)(error) ||
              ![
                "basis-not-found",
                "budget-exhausted",
                "stale-generation",
              ].includes(error.code)
            ) {
              budget.unknownBytes = true;
              budget.unknownRecords = true;
            }
          })
        )
      );

    yield* local(() => {
      budget.bytesRead += selected.decodedBytes;
      budget.recordsDecoded += selected.factsExamined;

      if (budget.bytesRead > budget.bounds.maxBytes) {
        throw localError(
          "budget-exhausted",
          "The metadata provider exceeded its reserved read allowance."
        );
      }

      if (selected.metadata !== null) {
        assertScope(options, worktree, selected.metadata.scope);
      }
    });

    if (selected.metadata === null) {
      return yield* localError(
        "basis-not-found",
        "The selected basis metadata is not retained in this store."
      );
    }

    return selected.metadata;
  }
);

const prepareExport = Effect.fn("appOperations.prepareExport")(
  function* prepareExport(
    options: AppOperationAdapterOptions,
    worktree: string,
    input: OperationPlanInput,
    budget: LocalBudget
  ): Effect.fn.Return<OperationPreparation, AgentStoreFailure> {
    const identity = yield* assertTarget(options, worktree, input);

    if (
      input.arguments.kind !== "export" ||
      input.arguments.disclosure !== "metadata-only"
    ) {
      return yield* localError(
        "invalid-selector",
        "This adapter exports only explicitly selected retained basis metadata."
      );
    }

    const destination = yield* local(() =>
      exportDestination(
        worktree,
        input.arguments.kind === "export" ? input.arguments.destination : ""
      )
    );

    const before = yield* local(() =>
      readFileState(worktree, destination, budget)
    );

    const basis = yield* selectedMetadata(
      options,
      worktree,
      input.arguments.basisId,
      budget,
      identity.storeId,
      identity.storeGeneration
    );

    const body = metadataBytes(basis);
    const outputBytes = Buffer.byteLength(body);

    const backup =
      before.digest === ABSENT
        ? null
        : yield* local(() =>
            readFileState(worktree, exportBackup(worktree, before), budget)
          );

    const temporary = yield* local(() =>
      readFileState(
        worktree,
        exportTemporary(destination, skillDigest(body)),
        budget
      )
    );

    if (
      temporary.digest !== ABSENT ||
      (backup !== null &&
        backup.digest !== ABSENT &&
        backup.digest !== before.digest)
    ) {
      return yield* localError(
        "plan-stale",
        "The reviewed export temporary or backup artifact requires inspection before a new plan."
      );
    }

    yield* local(() => {
      reserveBytes(budget, outputBytes);
    });

    return preparation(
      input,
      { ...input.arguments, destination },
      [
        destination,
        temporary.path,
        input.arguments.basisId,
        ...(backup === null ? [] : [backup.path]),
        ...(options.resolveCurrentTarget === undefined ? [] : [GIT_IO_GAP]),
      ],
      [destination, temporary.path, ...(backup === null ? [] : [backup.path])],
      [
        generationPrecondition(identity.storeId, identity.storeGeneration),
        preconditionFor(before),
        preconditionFor(temporary),
        ...(backup === null ? [] : [preconditionFor(backup)]),
        {
          allowAppend: false,
          expected: skillDigest(body),
          kind: "source-content",
          target: input.arguments.basisId,
        },
      ],
      budget.bytesRead + outputBytes,
      "Confirm EXPORT METADATA followed by consent.scopeDigest; this exports only the selected basis metadata, without retained event bodies or price-sheet contents."
    );
  }
);

const validateExport = Effect.fn("appOperations.validateExport")(
  function* validateExport(
    options: AppOperationAdapterOptions,
    worktree: string,
    plan: OperationPlan,
    budget: LocalBudget
  ) {
    const changed = yield* commonValidation(options, worktree, plan);

    if (
      plan.arguments.kind !== "export" ||
      plan.arguments.disclosure !== "metadata-only"
    ) {
      return [...changed, "arguments"];
    }

    yield* local(() =>
      exportDestination(
        worktree,
        plan.arguments.kind === "export" ? plan.arguments.destination : ""
      )
    );

    for (const item of plan.preconditions.filter(
      (condition) => condition.kind === "selected-content"
    )) {
      const file = yield* local(() =>
        readFileState(worktree, item.target, budget)
      );

      if (file.digest !== item.expected) {
        changed.push(item.target);
      }
    }

    const basis = yield* selectedMetadata(
      options,
      worktree,
      plan.arguments.basisId,
      budget,
      plan.storeId,
      plan.storeGeneration
    );

    if (
      skillDigest(metadataBytes(basis)) !==
      plan.preconditions.find((item) => item.kind === "source-content")
        ?.expected
    ) {
      changed.push("basis-metadata");
    }

    return changed;
  }
);

const commitExport = (
  worktree: string,
  destination: string,
  body: string,
  before: FileState,
  previousBody: Buffer | null,
  budget: LocalBudget
): readonly FileState[] => {
  const bytes = Buffer.byteLength(body);
  reserveBytes(budget, bytes + before.bytes);
  reserveFileReads(budget, before.digest === ABSENT ? 1 : 2);
  const backups: FileState[] = [];

  if (before.digest !== ABSENT && before.digest !== skillDigest(body)) {
    const backup = exportBackup(worktree, before);
    checkPath(worktree, backup);
    mkdirSync(path.dirname(backup), { recursive: true });

    if (!existsSync(backup)) {
      if (previousBody === null) {
        throw localError(
          "plan-stale",
          "The reviewed previous export bytes are unavailable for backup."
        );
      }

      const fd = openSync(backup, "wx", 0o600);

      try {
        writeFileSync(fd, previousBody);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }

    const artifact = readFileState(worktree, backup, budget);

    if (artifact.digest !== before.digest) {
      throw localError(
        "plan-stale",
        "The selected export backup does not match the reviewed contents."
      );
    }

    backups.push(artifact);
  }

  if (before.digest === skillDigest(body)) {
    return backups;
  }

  const temporary = exportTemporary(destination, skillDigest(body));
  checkPath(worktree, temporary);
  mkdirSync(path.dirname(destination), { recursive: true });
  let created = false;

  try {
    const fd = openSync(temporary, "wx", 0o600);

    try {
      created = true;
      writeFileSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    renameSync(temporary, destination);
  } finally {
    if (created) {
      rmSync(temporary, { force: true });
    }
  }

  return backups;
};

const executeExport = Effect.fn("appOperations.executeExport")(
  function* executeExport(
    options: AppOperationAdapterOptions,
    worktree: string,
    plan: OperationPlan,
    step: OperationStep,
    confirmation: string | null,
    budget: LocalBudget
  ): Effect.fn.Return<OperationEffectResult, AgentStoreFailure> {
    if (!confirmed(plan, confirmation)) {
      return yield* localError(
        "authorization-required",
        "Use the exact typed confirmation from the reviewed export plan."
      );
    }

    const changed = yield* commonValidation(options, worktree, plan);

    if (changed.length > 0 || plan.arguments.kind !== "export") {
      return yield* localError(
        "plan-stale",
        "The selected export plan changed before execution."
      );
    }

    const basis = yield* selectedMetadata(
      options,
      worktree,
      plan.arguments.basisId,
      budget,
      plan.storeId,
      plan.storeGeneration
    );

    const { destination } = plan.arguments;

    const selected = yield* local(() => {
      exportDestination(worktree, destination);

      return readSelectedFile(worktree, destination, budget);
    });

    const before = selected.state;

    const otherConditions = plan.preconditions.filter(
      (condition) =>
        condition.kind === "selected-content" &&
        condition.target !== destination
    );

    const otherChanged = yield* local(() =>
      otherConditions.some(
        (condition) =>
          readFileState(worktree, condition.target, budget).digest !==
          condition.expected
      )
    );

    const expectedBefore = plan.preconditions.find(
      (condition) =>
        condition.kind === "selected-content" &&
        condition.target === destination
    )?.expected;

    const body = metadataBytes(basis);
    const digest = skillDigest(body);

    if (
      before.digest !== expectedBefore ||
      otherChanged ||
      digest !==
        plan.preconditions.find(
          (condition) => condition.kind === "source-content"
        )?.expected
    ) {
      return yield* localError(
        "plan-stale",
        "The selected export contents changed before its local commit."
      );
    }

    const backups = yield* local(() =>
      commitExport(worktree, destination, body, before, selected.body, budget)
    );

    const after = yield* local(() =>
      readFileState(worktree, destination, budget)
    );

    if (after.digest !== digest) {
      return yield* localError(
        "source-unavailable",
        "The exported metadata could not be verified against the selected basis."
      );
    }

    return {
      effects: {
        ...baseEffects(plan),
        backupArtifacts: backups.map((file) => backupArtifact(plan, file)),
        backupIds: backups.map((file) => file.path),
        exportArtifacts: [
          {
            basisId: basis.id,
            contentDigest: digest,
            destination,
            disclosure: "metadata-only",
          },
        ],
        exports: [destination],
        filesChanged: before.digest === digest ? [] : [destination],
      },
      resources: resources(budget),
      step: {
        ...step,
        committedThrough: digest,
        gaps: options.resolveCurrentTarget === undefined ? [] : [GIT_IO_GAP],
        state: before.digest === digest ? "unchanged" : "committed",
      },
    };
  }
);

const probeExport = Effect.fn("appOperations.probeExport")(
  function* probeExport(
    options: AppOperationAdapterOptions,
    worktree: string,
    plan: OperationPlan,
    step: OperationStep,
    budget: LocalBudget
  ): Effect.fn.Return<OperationProbe, AgentStoreFailure> {
    const generationChanged = yield* commonValidation(options, worktree, plan);

    if (generationChanged.length > 0) {
      return yield* localError(
        "stale-generation",
        "The export plan belongs to a different store generation."
      );
    }

    if (plan.arguments.kind !== "export") {
      return {
        reason: "The retained export plan arguments are incompatible.",
        state: "indeterminate",
      };
    }

    const destination = yield* local(() =>
      exportDestination(
        worktree,
        plan.arguments.kind === "export" ? plan.arguments.destination : ""
      )
    );

    const actual = yield* local(() =>
      readFileState(worktree, destination, budget)
    );

    const expected = plan.preconditions.find(
      (item) => item.kind === "source-content"
    )?.expected;

    const before = plan.preconditions.find(
      (item) => item.kind === "selected-content" && item.target === destination
    )?.expected;

    if (expected === undefined) {
      return {
        reason:
          "The retained export plan is missing its selected metadata digest.",
        state: "indeterminate",
      };
    }

    const temporary = yield* local(() =>
      readFileState(worktree, exportTemporary(destination, expected), budget)
    );

    if (temporary.digest !== ABSENT) {
      return {
        reason:
          "An export temporary artifact exists without a completed atomic commit; inspect it before retry.",
        state: "indeterminate",
      };
    }

    if (actual.digest === expected) {
      const backups: FileState[] = [];

      if (before !== ABSENT && before !== expected && before !== undefined) {
        const backup = yield* local(() =>
          readFileState(
            worktree,
            exportBackup(worktree, {
              bytes: 0,
              digest: before,
              path: destination,
            }),
            budget
          )
        );

        if (backup.digest !== before) {
          return {
            reason:
              "The exact exported contents exist, but their required previous-content backup is unavailable.",
            state: "indeterminate",
          };
        }

        backups.push(backup);
      }

      return {
        result: {
          effects: {
            ...baseEffects(plan),
            backupArtifacts: backups.map((file) => backupArtifact(plan, file)),
            backupIds: backups.map((file) => file.path),
            exportArtifacts: [
              {
                basisId: plan.arguments.basisId,
                contentDigest: actual.digest,
                destination,
                disclosure: "metadata-only",
              },
            ],
            exports: [destination],
            filesChanged: [],
          },
          resources: resources(budget),
          step: {
            ...step,
            committedThrough: actual.digest,
            gaps: [
              "The exact metadata artifact and required backup were recovered; original file-change attribution and execution resource use are unavailable.",
              ...(options.resolveCurrentTarget === undefined
                ? []
                : [GIT_IO_GAP]),
            ],
            state: "already-applied",
          },
        },
        state: "complete",
      };
    }

    if (actual.digest === before) {
      const originalArtifacts = yield* local(() =>
        plan.preconditions
          .filter(
            (item) =>
              item.kind === "selected-content" &&
              item.target !== destination &&
              item.target !== temporary.path
          )
          .every(
            (item) =>
              readFileState(worktree, item.target, budget).digest ===
              item.expected
          )
      );

      return originalArtifacts
        ? { state: "absent" }
        : {
            reason:
              "A reviewed backup artifact changed without a completed export; inspect it before retry.",
            state: "indeterminate",
          };
    }

    return {
      reason:
        "The selected export has neither the reviewed prior contents nor the exact committed metadata; inspect it before retry.",
      state: "indeterminate",
    };
  }
);

export const makeAppOperationAdapters = (
  options: AppOperationAdapterOptions
): readonly OperationAdapter[] => {
  const worktree = Schema.is(Schema.String)(options.worktree)
    ? path.resolve(options.worktree)
    : "selected canonical worktree";

  const guidance: OperationAdapter = {
    authorize: (plan, input, context) =>
      reviewedPlanWork(
        plan,
        context.budget.remaining.pipe(
          Effect.as(confirmed(plan, input.confirmation))
        )
      ),
    descriptor: descriptor("configure", worktree),
    execute: (plan, step, context) =>
      reviewedPlanWork(
        plan,
        meteredPhase(
          options,
          plan.scope,
          context,
          (selected, budget, current) =>
            executeGuidance(
              current,
              selected,
              plan,
              step,
              context.confirmation,
              budget
            )
        )
      ),
    meteredWork: true,
    prepare: (input, context) =>
      meteredPhase(options, input.scope, context, (selected, budget, current) =>
        prepareGuidance(current, selected, input, budget)
      ),
    probe: (plan, step, receipt, context) =>
      hasReviewedVersion(plan)
        ? meteredPhase(
            options,
            plan.scope,
            context,
            (selected, budget, current) =>
              probeGuidance(current, selected, plan, step, receipt, budget)
          )
        : Effect.succeed<OperationProbe>({
            reason:
              "The reviewed local adapter version changed; create a new plan before target resolution or further work.",
            state: "indeterminate",
          }),
    replay: "probe-required",
    steps: () => [
      operationStep("install-codex-guidance", "packaged-codex-guidance"),
    ],
    validate: (plan, context) =>
      reviewedPlanWork(
        plan,
        meteredPhase(
          options,
          plan.scope,
          context,
          (selected, budget, current) =>
            validateGuidance(current, selected, plan, budget)
        )
      ),
  };

  const exporter: OperationAdapter = {
    authorize: (plan, input, context) =>
      reviewedPlanWork(
        plan,
        context.budget.remaining.pipe(
          Effect.as(confirmed(plan, input.confirmation))
        )
      ),
    descriptor: descriptor(
      "export",
      worktree,
      options.resolveCurrentTarget !== undefined
    ),
    execute: (plan, step, context) =>
      reviewedPlanWork(
        plan,
        meteredPhase(
          options,
          plan.scope,
          context,
          (selected, budget, current) =>
            executeExport(
              current,
              selected,
              plan,
              step,
              context.confirmation,
              budget
            )
        )
      ),
    meteredWork: true,
    prepare: (input, context) =>
      meteredPhase(options, input.scope, context, (selected, budget, current) =>
        prepareExport(current, selected, input, budget)
      ),
    probe: (plan, step, _receipt, context) =>
      hasReviewedVersion(plan)
        ? meteredPhase(
            options,
            plan.scope,
            context,
            (selected, budget, current) =>
              probeExport(current, selected, plan, step, budget)
          )
        : Effect.succeed<OperationProbe>({
            reason:
              "The reviewed local adapter version changed; create a new plan before target resolution or further work.",
            state: "indeterminate",
          }),
    replay: "probe-required",
    steps: () => [
      operationStep("export-basis-metadata", "retained-basis-metadata"),
    ],
    validate: (plan, context) =>
      reviewedPlanWork(
        plan,
        meteredPhase(
          options,
          plan.scope,
          context,
          (selected, budget, current) =>
            validateExport(current, selected, plan, budget)
        )
      ),
  };

  if (options.cursorHooksAdapter === undefined) {
    return [guidance, exporter];
  }

  const cursor = options.cursorHooksAdapter;

  const selected = (args: OperationPlan["arguments"]): OperationAdapter =>
    args.kind === "configure" && args.settings.action === "install-hooks"
      ? cursor
      : guidance;

  const configure: OperationAdapter = {
    authorize: (plan, input, context) =>
      selected(plan.arguments).authorize(plan, input, context),
    descriptor: {
      ...guidance.descriptor,
      effects: {
        ...guidance.descriptor.effects,
        reads: [
          ...guidance.descriptor.effects.reads,
          ...cursor.descriptor.effects.reads,
        ],
        writes: [
          ...guidance.descriptor.effects.writes,
          ...cursor.descriptor.effects.writes,
        ],
      },
      requiredInputs: [
        ...guidance.descriptor.requiredInputs,
        ...cursor.descriptor.requiredInputs,
      ],
      version: `${VERSION}:${cursor.descriptor.version}`,
    },
    execute: (plan, step, context) =>
      selected(plan.arguments).execute(plan, step, context),
    meteredWork: cursor.meteredWork === true,
    prepare: (input, context) =>
      selected(input.arguments).prepare(input, context),
    probe: (plan, step, receipt, context) =>
      selected(plan.arguments).probe(plan, step, receipt, context),
    replay: "probe-required",
    steps: (plan) => selected(plan.arguments).steps(plan),
    validate: (plan, context) =>
      selected(plan.arguments).validate(plan, context),
  };

  return [configure, exporter];
};

export class AppOperationAdapters extends Context.Service<
  AppOperationAdapters,
  {
    readonly adapters: readonly OperationAdapter[];
  }
>()("@rat-stack/cli/AppOperationAdapters") {
  static readonly layer = (
    options: Omit<
      AppOperationAdapterOptions,
      "store" | "spawner" | "cursorHooksAdapter"
    >
  ) => {
    const appLayer = Layer.effect(
      AppOperationAdapters,
      Effect.gen(function* appOperationAdaptersLayer() {
        const store = yield* AgentStore;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const cursor = (yield* CursorHooksAdapter).adapter;
        const supplied = { ...options, spawner, store };

        const selected =
          cursor === null
            ? supplied
            : { ...supplied, cursorHooksAdapter: cursor };

        return AppOperationAdapters.of({
          adapters: makeAppOperationAdapters(selected),
        });
      })
    );

    let cursorOptions: Parameters<typeof CursorHooksAdapter.layer>[0] = {
      scope: options.scope,
      worktree: options.worktree,
    };

    if (options.hookCommand !== undefined) {
      cursorOptions = { ...cursorOptions, hookCommand: options.hookCommand };
    }

    if (options.resolveCursorTarget !== undefined) {
      cursorOptions = {
        ...cursorOptions,
        resolveTarget: options.resolveCursorTarget,
      };
    }

    if (options.skillsSource !== undefined) {
      cursorOptions = { ...cursorOptions, skillsSource: options.skillsSource };
    }

    return appLayer.pipe(
      Layer.provide(CursorHooksAdapter.layer(cursorOptions))
    );
  };
}
