import { Buffer, isUtf8 } from "node:buffer";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  writeFileSync,
  // @effect-diagnostics-next-line nodeBuiltinImport:off -- Selected installer files are bounded before allocation and written only after reviewed fingerprints match.
} from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Cursor installation paths remain inside their reviewed canonical worktree or Git metadata roots.
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

import {
  installCursorHooks,
  installSkills,
  parseHooksFile,
} from "./dft-install.js";
import type { PreparedInstallationReader } from "./dft-install.js";
import {
  isReleasedSkillBody,
  skillDigest,
  skillsSourceDir,
} from "./dft-skills.js";
import type { DftSkill } from "./dft-skills.js";

const VERSION = "dft.cursor-hooks-operation.v2";

const ABSENT = "absent";

const MAX_SKILLS = 24;

const EXCLUDE_START = "# >>> dft agent Cursor hooks";

const EXCLUDE_END = "# <<< dft agent Cursor hooks";

export interface CursorHooksAdapterOptions {
  readonly store: AgentStoreService;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly scope: AgentScope | (() => AgentScope);
  readonly worktree: string | (() => string);
  readonly skillsSource?: string;
  readonly hookCommand: () => string;
  readonly resolveTarget?: (
    scope: AgentScope,
    context: OperationWorkContext
  ) => Effect.Effect<
    { readonly scope: AgentScope; readonly worktree: string },
    AgentStoreFailure
  >;
}

interface LocalWork {
  readonly bounds: OperationBounds;
  readonly started: number;
  bytes: number;
  files: number;
  records: number;
  requests: number;
}

interface SelectedFile {
  readonly root: string;
  readonly path: string;
  readonly digest: string;
  readonly bytes: number;
  readonly body: Buffer | null;
}

interface GitLocations {
  readonly common: string;
  readonly directory: string;
  readonly ownership: string;
  readonly ownershipRoot: string;
  readonly exclude: string;
  readonly excludeRoot: string;
}

interface Selection {
  readonly worktree: string;
  readonly source: string;
  readonly sourceFiles: readonly SelectedFile[];
  readonly skills: readonly DftSkill[];
  readonly targets: readonly SelectedFile[];
  readonly backups: readonly SelectedFile[];
  readonly locations: GitLocations;
  readonly tracked: readonly string[];
  readonly ignoreEntries: readonly string[];
  readonly command: string;
}

const OwnershipSchema = Schema.Struct({
  createdHookEvents: Schema.optional(Schema.Array(Schema.String)),
  hookFileCreated: Schema.Boolean,
  hooks: Schema.Record(
    Schema.String,
    Schema.Array(
      Schema.StructWithRest(Schema.Struct({ command: Schema.String }), [
        Schema.Record(Schema.String, Schema.Json),
      ])
    )
  ),
  schema: Schema.Literal("dft.install.ownership.v1"),
  skills: Schema.Record(Schema.String, Schema.String),
});

const failure = (code: AgentError["code"], message: string): AgentError =>
  new AgentError({
    code,
    currentRevision: null,
    expectedRevision: null,
    message,
    recovery: { action: code === "plan-stale" ? "replan" : "none", ref: null },
    ref: null,
    retryable: false,
  });

const local = <A>(run: () => A): Effect.Effect<A, AgentStoreFailure> =>
  Effect.try({
    catch: (cause) =>
      Schema.is(AgentError)(cause)
        ? cause
        : failure(
            "source-unavailable",
            "The selected Cursor artifact could not be inspected or written."
          ),
    try: run,
  });

const room = (
  work: LocalWork,
  files = 0,
  bytes = 0,
  records = 0,
  requests = 0
): void => {
  if (
    performance.now() - work.started >= work.bounds.maxElapsedMs ||
    files > work.bounds.maxFiles - work.files ||
    bytes > work.bounds.maxBytes - work.bytes ||
    records > work.bounds.maxRecords - work.records ||
    requests > work.bounds.maxRequests - work.requests
  ) {
    throw failure(
      "budget-exhausted",
      "The cumulative reviewed Cursor installation work limit is exhausted."
    );
  }
};

const descendant = (root: string, file: string): boolean => {
  const relative = path.relative(root, file);

  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
};

const safePath = (root: string, file: string, directory = false): void => {
  if (!descendant(root, file) || path.resolve(file) !== file) {
    throw failure(
      "scope-denied",
      "A Cursor artifact is outside its reviewed canonical root."
    );
  }

  const parts = path.relative(root, file).split(path.sep);

  for (let index = 0; index < parts.length; index += 1) {
    const stat = lstatSync(path.join(root, ...parts.slice(0, index + 1)), {
      throwIfNoEntry: false,
    });

    if (stat === undefined) {
      continue;
    }

    if (
      stat.isSymbolicLink() ||
      (index === parts.length - 1 && !directory
        ? !stat.isFile()
        : !stat.isDirectory())
    ) {
      throw failure(
        "scope-denied",
        "A selected Cursor artifact has a linked or conflicting path."
      );
    }
  }
};

const canonicalRoot = (selected: string): string => {
  const root = path.resolve(selected);

  if (realpathSync(root) !== root || !lstatSync(root).isDirectory()) {
    throw failure(
      "scope-denied",
      "Select a canonical directory without linked path components."
    );
  }

  return root;
};

const readSelected = (
  root: string,
  file: string,
  work: LocalWork
): SelectedFile => {
  safePath(root, file);
  room(work, 1);
  work.files += 1;
  const existing = lstatSync(file, { throwIfNoEntry: false });

  if (existing === undefined) {
    return { body: null, bytes: 0, digest: ABSENT, path: file, root };
  }

  const fd = openSync(file, constants.O_RDONLY + constants.O_NOFOLLOW);

  try {
    const before = fstatSync(fd);

    if (!before.isFile()) {
      throw failure(
        "scope-denied",
        "The selected Cursor artifact is not a regular file."
      );
    }

    room(work, 0, before.size);
    const body = Buffer.alloc(before.size);
    let offset = 0;

    while (offset < body.length) {
      room(work);
      const count = readSync(fd, body, offset, body.length - offset, offset);

      if (count === 0) {
        throw failure(
          "plan-stale",
          "A selected Cursor artifact changed during inspection."
        );
      }

      offset += count;
      work.bytes += count;
    }

    const after = fstatSync(fd);

    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw failure(
        "plan-stale",
        "A selected Cursor artifact changed during inspection."
      );
    }

    return {
      body,
      bytes: body.length,
      digest: skillDigest(body),
      path: file,
      root,
    };
  } finally {
    closeSync(fd);
  }
};

const text = (file: SelectedFile, work: LocalWork): string | null => {
  if (file.body === null) {
    return null;
  }

  room(work, 0, 0, 1);

  if (!isUtf8(file.body)) {
    throw failure(
      "source-unavailable",
      "The reviewed Cursor text artifact is not valid UTF-8."
    );
  }

  work.records += 1;

  return file.body.toString("utf-8");
};

const fileFingerprint = (files: readonly SelectedFile[]): string =>
  skillDigest(
    JSON.stringify(
      files
        .map(({ path: file, digest }) => ({ digest, path: file }))
        .toSorted((left, right) => left.path.localeCompare(right.path))
    )
  );

const gitOutput = Effect.fn("cursorHooks.gitOutput")(function* gitOutput(
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  worktree: string,
  args: readonly string[],
  work: LocalWork
): Effect.fn.Return<string, AgentStoreFailure> {
  const allowance = yield* local(() => {
    room(work, 1, 1, 1, 1);

    return {
      bytes: Math.min(32_768, work.bounds.maxBytes - work.bytes),
      elapsedMs:
        work.bounds.maxElapsedMs - Math.ceil(performance.now() - work.started),
    };
  });

  const chunks: Uint8Array[] = [];
  const output = { bytes: 0, stdoutBytes: 0 };

  return yield* Effect.scoped(
    Effect.gen(function* scopedGitOutput() {
      yield* local(() => {
        room(work, 1, 1, 1, 1);
        work.files += 1;
        work.requests += 1;
      });

      const handle = yield* spawner.spawn(
        ChildProcess.make(
          "git",
          ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args],
          {
            cwd: worktree,
            forceKillAfter: 0,
            killSignal: "SIGKILL",
            stderr: "pipe",
            stdin: "ignore",
            stdout: "pipe",
          }
        )
      );

      yield* Effect.all(
        [
          handle.stdout.pipe(
            Stream.runForEach((chunk) =>
              local(() => {
                output.bytes += chunk.byteLength;
                work.bytes += chunk.byteLength;
                room(work);

                if (output.bytes > allowance.bytes) {
                  throw failure(
                    "budget-exhausted",
                    "The selected Git stdout and stderr exceed their shared byte allowance."
                  );
                }

                output.stdoutBytes += chunk.byteLength;
                chunks.push(chunk);
              })
            )
          ),
          handle.stderr.pipe(
            Stream.runForEach((chunk) =>
              local(() => {
                output.bytes += chunk.byteLength;
                work.bytes += chunk.byteLength;
                room(work);

                if (output.bytes > allowance.bytes) {
                  throw failure(
                    "budget-exhausted",
                    "The selected Git stdout and stderr exceed their shared byte allowance."
                  );
                }
              })
            )
          ),
        ],
        { concurrency: 2, discard: true }
      );

      const code = yield* handle.exitCode;

      return yield* local(() => {
        room(work, 0, 0, 1);

        if (Number(code) !== 0) {
          throw failure(
            "source-unavailable",
            "The selected bounded Git metadata query failed."
          );
        }

        const body = Buffer.concat(chunks, output.stdoutBytes);

        if (!isUtf8(body)) {
          throw failure(
            "source-unavailable",
            "The selected Git metadata is not valid UTF-8."
          );
        }

        work.records += 1;

        return body.toString("utf-8");
      });
    })
  ).pipe(
    Effect.timeout(Math.max(1, allowance.elapsedMs)),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(
        failure(
          "budget-exhausted",
          "The selected Git metadata query exceeded the remaining elapsed allowance."
        )
      )
    ),
    Effect.mapError((cause) =>
      Schema.is(AgentError)(cause)
        ? cause
        : failure(
            "source-unavailable",
            "The selected bounded Git metadata query failed."
          )
    )
  );
});

const gitLocations = Effect.fn("cursorHooks.gitLocations")(
  function* gitLocations(
    spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
    worktree: string,
    work: LocalWork
  ): Effect.fn.Return<GitLocations, AgentStoreFailure> {
    const name = `${skillDigest(".cursor").slice(0, 16)}.json`;

    const body = yield* gitOutput(
      spawner,
      worktree,
      [
        "rev-parse",
        "--path-format=absolute",
        "--show-toplevel",
        "--git-common-dir",
        "--git-dir",
        "--git-path",
        `dft-install/${name}`,
        "--git-path",
        "info/exclude",
      ],
      work
    );

    return yield* local(() => {
      const parts = body.trimEnd().split("\n");

      const [top, commonPath, directoryPath, ownershipPath, excludePath] =
        parts;

      if (
        parts.length !== 5 ||
        top !== worktree ||
        commonPath === undefined ||
        directoryPath === undefined ||
        ownershipPath === undefined ||
        excludePath === undefined
      ) {
        throw failure(
          "scope-denied",
          "Select the exact root of a local Git worktree for Cursor hook installation."
        );
      }

      const common = canonicalRoot(commonPath);
      const directory = canonicalRoot(directoryPath);
      const ownership = path.resolve(worktree, ownershipPath);
      const exclude = path.resolve(worktree, excludePath);

      const ownershipRoot = descendant(directory, ownership)
        ? directory
        : common;

      const excludeRoot = descendant(common, exclude) ? common : directory;

      safePath(ownershipRoot, ownership);
      safePath(excludeRoot, exclude);

      return {
        common,
        directory,
        exclude,
        excludeRoot,
        ownership,
        ownershipRoot,
      };
    });
  }
);

const packagedSkills = (source: string, work: LocalWork) => {
  const files: SelectedFile[] = [];
  const skills: DftSkill[] = [];
  room(work, 1);
  work.files += 1;
  const directory = opendirSync(source);
  let count = 0;

  try {
    for (
      let entry = directory.readSync();
      entry !== null;
      entry = directory.readSync()
    ) {
      room(work);
      count += 1;

      if (count > MAX_SKILLS) {
        throw failure(
          "budget-exhausted",
          "The packaged Cursor skill inventory exceeds its reviewed bound."
        );
      }

      if (entry.isSymbolicLink()) {
        throw failure(
          "scope-denied",
          "A packaged Cursor skill uses a linked path."
        );
      }

      if (!entry.isDirectory() || !/^dx-[a-z0-9-]+$/u.test(entry.name)) {
        continue;
      }

      const file = readSelected(
        source,
        path.join(source, entry.name, "SKILL.md"),
        work
      );

      const body = text(file, work);

      if (body === null) {
        throw failure(
          "source-unavailable",
          "A selected packaged Cursor skill is missing its reviewed body."
        );
      }

      files.push(file);
      skills.push({ body, name: entry.name });
    }
  } finally {
    directory.closeSync();
  }

  if (skills.length === 0) {
    throw failure(
      "source-unavailable",
      "No packaged Cursor skills are available for this reviewed installation."
    );
  }

  return {
    files,
    skills: skills.toSorted((left, right) =>
      left.name.localeCompare(right.name)
    ),
  };
};

const backupPath = (ownership: string, file: SelectedFile): string =>
  path.join(
    path.dirname(ownership),
    "backups",
    `${skillDigest(file.path).slice(0, 16)}-${file.digest}.backup`
  );

const parsedOwnership = (
  file: SelectedFile,
  work: LocalWork
): typeof OwnershipSchema.Type => {
  const body = text(file, work);

  if (body === null) {
    return {
      hookFileCreated: false,
      hooks: {},
      schema: "dft.install.ownership.v1",
      skills: {},
    };
  }

  try {
    return Schema.decodeUnknownSync(Schema.fromJsonString(OwnershipSchema))(
      body
    );
  } catch {
    throw failure(
      "source-unavailable",
      "The reviewed Cursor installation ownership file is invalid."
    );
  }
};

const acceptedSkill = (
  skill: DftSkill,
  file: SelectedFile,
  ownership: typeof OwnershipSchema.Type
): boolean =>
  file.body === null ||
  file.digest === skillDigest(skill.body) ||
  ownership.skills[skill.name] === file.digest ||
  isReleasedSkillBody(skill.name, file.body.toString("utf-8"));

const mergeExclude = (body: string, entries: readonly string[]): string => {
  const lines = body === "" ? [] : body.replace(/\n$/u, "").split("\n");
  const start = lines.indexOf(EXCLUDE_START);
  const end = lines.indexOf(EXCLUDE_END);

  if ((start === -1) !== (end === -1) || (start !== -1 && end < start)) {
    throw failure(
      "plan-stale",
      "The reviewed Cursor Git exclude block requires inspection."
    );
  }

  const before = start === -1 ? lines : lines.slice(0, start);
  const after = start === -1 ? [] : lines.slice(end + 1);
  const previous = start === -1 ? [] : lines.slice(start + 1, end);
  const block = [...new Set([...previous, ...entries])];

  const result = [
    ...before,
    ...(block.length === 0 ? [] : [EXCLUDE_START, ...block, EXCLUDE_END]),
    ...after,
  ];

  return result.length === 0 ? "" : `${result.join("\n")}\n`;
};

const select = Effect.fn("cursorHooks.select")(function* select(
  options: CursorHooksAdapterOptions,
  worktree: string,
  work: LocalWork
): Effect.fn.Return<Selection, AgentStoreFailure> {
  const { source, packaged } = yield* local(() => {
    const selectedSource = canonicalRoot(
      options.skillsSource ?? skillsSourceDir()
    );

    return {
      packaged: packagedSkills(selectedSource, work),
      source: selectedSource,
    };
  });

  const locations = yield* gitLocations(options.spawner, worktree, work);

  const current = yield* local(() => {
    const hooks = readSelected(
      worktree,
      path.join(worktree, ".cursor", "hooks.json"),
      work
    );

    const hooksText = text(hooks, work);

    if (hooksText !== null && parseHooksFile(hooksText) === null) {
      throw failure(
        "source-unavailable",
        "The reviewed Cursor hooks file is invalid and must be left untouched."
      );
    }

    const ownershipFile = readSelected(
      locations.ownershipRoot,
      locations.ownership,
      work
    );

    const ownership = parsedOwnership(ownershipFile, work);

    const skillTargets = packaged.skills.map((skill) => {
      const file = readSelected(
        worktree,
        path.join(worktree, ".cursor", "skills", skill.name, "SKILL.md"),
        work
      );

      text(file, work);

      return file;
    });

    const exclude = readSelected(
      locations.excludeRoot,
      locations.exclude,
      work
    );

    text(exclude, work);

    const targets = [hooks, ...skillTargets, ownershipFile, exclude];

    const rels = [hooks.path, ...skillTargets.map((item) => item.path)].map(
      (file) => path.relative(worktree, file).split(path.sep).join("/")
    );

    return { exclude, hooks, ownership, rels, skillTargets, targets };
  });

  const tracked = (yield* gitOutput(
    options.spawner,
    worktree,
    ["ls-files", "-z", "--", ...current.rels],
    work
  ))
    .split("\0")
    .filter((item) => item !== "")
    .toSorted();

  return yield* local(() => {
    const { hooks, ownership, skillTargets, exclude, targets } = current;

    const accepted = [
      hooks.path,
      ...packaged.skills.flatMap((skill) => {
        const file = skillTargets.find(
          (item) => path.basename(path.dirname(item.path)) === skill.name
        );

        return file !== undefined && acceptedSkill(skill, file, ownership)
          ? [file.path]
          : [];
      }),
    ];

    const ignoreEntries = accepted
      .flatMap((file) => {
        const rel = path.relative(worktree, file).split(path.sep).join("/");

        return tracked.includes(rel) ? [] : [`/${rel}`];
      })
      .toSorted();

    mergeExclude(exclude.body?.toString("utf-8") ?? "", ignoreEntries);

    const backups = targets.flatMap((file) =>
      file.body === null
        ? []
        : [
            readSelected(
              locations.ownershipRoot,
              backupPath(locations.ownership, file),
              work
            ),
          ]
    );

    for (const file of targets.filter((item) => item.body !== null)) {
      const backup = backups.find(
        (item) => item.path === backupPath(locations.ownership, file)
      );

      if (
        backup !== undefined &&
        backup.digest !== ABSENT &&
        backup.digest !== file.digest
      ) {
        throw failure(
          "plan-stale",
          "A reviewed Cursor backup has different contents from its declared digest."
        );
      }
    }

    const command = options.hookCommand();

    if (
      command.length === 0 ||
      command.length > 4096 ||
      command.includes("\n") ||
      command.includes("\0")
    ) {
      throw failure(
        "source-unavailable",
        "The trusted Cursor hook executable is unavailable."
      );
    }

    return {
      backups,
      command,
      ignoreEntries,
      locations,
      skills: packaged.skills,
      source,
      sourceFiles: packaged.files,
      targets,
      tracked,
      worktree,
    };
  });
});

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

const targetFor = Effect.fn("cursorHooks.targetFor")(function* targetFor(
  options: CursorHooksAdapterOptions,
  scope: AgentScope,
  work: LocalWork
) {
  const selected = yield* local(() => ({
    scope: Schema.is(AgentScopeSchema)(options.scope)
      ? options.scope
      : options.scope(),
    worktree: Schema.is(Schema.String)(options.worktree)
      ? options.worktree
      : options.worktree(),
  }));

  return yield* local(() => {
    room(work, 0, 0, 1);
    work.records += 1;
    const worktree = canonicalRoot(selected.worktree);

    if (
      scopeKey(selected.scope) !== scopeKey(scope) ||
      scope.repoId === null ||
      scope.worktreeId !== worktree ||
      scope.branchSelection.kind === "unresolved"
    ) {
      throw failure(
        "scope-denied",
        "Select the exact resolved repository, worktree and branch admitted by this runtime."
      );
    }

    return worktree;
  });
});

const phase = Effect.fn("cursorHooks.phase")(function* phase<A, E>(
  options: CursorHooksAdapterOptions,
  scope: AgentScope,
  context: OperationWorkContext,
  run: (
    selectedOptions: CursorHooksAdapterOptions,
    work: LocalWork
  ) => Effect.Effect<A, E>
) {
  const selected =
    options.resolveTarget === undefined
      ? options
      : { ...options, ...(yield* options.resolveTarget(scope, context)) };

  return yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* settlePhase() {
      const bounds = yield* context.budget.remaining;

      const reservation = yield* context.budget.reserve({
        bytesRead: bounds.maxBytes,
        filesRead: bounds.maxFiles,
        recordsDecoded: bounds.maxRecords,
        requests: bounds.maxRequests,
        retries: 0,
      });

      const work: LocalWork = {
        bounds,
        bytes: 0,
        files: 0,
        records: 0,
        requests: 0,
        started: performance.now(),
      };

      const outcome = yield* Effect.exit(restore(run(selected, work)));
      yield* reservation.complete({
        bytesRead: work.bytes,
        filesRead: work.files,
        recordsDecoded: work.records,
        requests: work.requests,
        retries: 0,
      });

      if (Exit.isFailure(outcome)) {
        return yield* Effect.failCause(outcome.cause);
      }

      return outcome.value;
    })
  );
});

const fingerprints = (selected: Selection): OperationPlan["preconditions"] => [
  {
    allowAppend: false,
    expected: fileFingerprint(selected.sourceFiles),
    kind: "source-content",
    target: selected.source,
  },
  {
    allowAppend: false,
    expected: skillDigest(selected.command),
    kind: "source-content",
    target: "cursor-hook-command",
  },
  {
    allowAppend: false,
    expected: JSON.stringify(selected.locations),
    kind: "source-identity",
    target: "cursor-git-locations",
  },
  {
    allowAppend: false,
    expected: JSON.stringify(selected.tracked),
    kind: "source-identity",
    target: "cursor-tracking",
  },
  {
    allowAppend: false,
    expected: JSON.stringify(selected.ignoreEntries),
    kind: "source-identity",
    target: "cursor-ignore-entries",
  },
  ...selected.targets.map((file): OperationPlan["preconditions"][number] => ({
    allowAppend: false,
    expected: file.digest,
    kind: "selected-content",
    target: file.path,
  })),
  ...selected.backups.map((file): OperationPlan["preconditions"][number] => ({
    allowAppend: false,
    expected: file.digest,
    kind: "backup-policy",
    target: file.path,
  })),
];

const argumentsMatch = (
  worktree: string,
  input: OperationPlanInput["arguments"]
): boolean =>
  input.kind === "configure" &&
  input.path === path.join(worktree, ".cursor", "hooks.json") &&
  input.settings.host === "cursor" &&
  input.settings.action === "install-hooks" &&
  Object.keys(input.settings).length === 2;

const identityChanges = Effect.fn("cursorHooks.identityChanges")(
  function* identityChanges(
    options: CursorHooksAdapterOptions,
    target: { readonly storeId: string; readonly storeGeneration: number }
  ) {
    const identity = yield* options.store.identity;

    return identity.storeId === target.storeId &&
      identity.storeGeneration === target.storeGeneration
      ? []
      : ["store-generation"];
  }
);

const changedSelection = (plan: OperationPlan, selected: Selection): string[] =>
  fingerprints(selected)
    .filter(
      (item) =>
        !plan.preconditions.some(
          (expected) =>
            expected.kind === item.kind &&
            expected.target === item.target &&
            expected.expected === item.expected
        )
    )
    .map((item) => item.target);

const prepare = Effect.fn("cursorHooks.prepare")(function* prepare(
  options: CursorHooksAdapterOptions,
  input: OperationPlanInput,
  work: LocalWork
): Effect.fn.Return<OperationPreparation, AgentStoreFailure> {
  const worktree = yield* targetFor(options, input.scope, work);

  if (
    !argumentsMatch(worktree, input.arguments) ||
    input.arguments.kind !== "configure"
  ) {
    return yield* failure(
      "invalid-selector",
      "Select only Cursor install-hooks with the canonical .cursor/hooks.json path and exact host/action settings."
    );
  }

  const configureArguments = input.arguments;

  if ((yield* identityChanges(options, input.target)).length > 0) {
    return yield* failure(
      "stale-generation",
      "The selected Cursor plan belongs to a different store generation."
    );
  }

  const selected = yield* select(options, worktree, work);

  if (input.scope.repoId !== selected.locations.common) {
    return yield* failure(
      "scope-denied",
      "The selected repository does not match this worktree's canonical Git common directory."
    );
  }

  const before = selected.targets.find(
    (item) => item.path === configureArguments.path
  );

  if (
    before === undefined ||
    !["current", before.digest].includes(
      configureArguments.expectedContentDigest
    )
  ) {
    return yield* failure(
      "plan-stale",
      "The selected Cursor hooks digest differs from the reviewed input."
    );
  }

  const writes = [
    ...selected.targets.map((item) => item.path),
    ...selected.targets
      .filter((item) => item.body !== null)
      .map((item) => backupPath(selected.locations.ownership, item)),
  ];

  return {
    arguments: { ...configureArguments, expectedContentDigest: before.digest },
    consent: {
      reason:
        "Confirm INSTALL CURSOR HOOKS followed by consent.scopeDigest. This changes only the reviewed local Cursor files and Git exclude entries.",
      receiptIds: [],
      scopeDigest: skillDigest(JSON.stringify({ scope: input.scope, writes })),
      state: "required",
    },
    effects: {
      destructive: false,
      networkDestinations: [],
      reads: [
        ...selected.sourceFiles.map((item) => item.path),
        ...selected.targets.map((item) => item.path),
        ...selected.backups.map((item) => item.path),
        "bounded selected Git path/tracking control metadata",
      ],
      writes,
    },
    expectedEvidenceImprovement:
      "Installs the packaged Cursor guidance and trusted local hook command for this exact worktree.",
    forecast: {
      bytes: work.bytes,
      cost: 0,
      elapsedMs: null,
      requests: work.requests,
    },
    preconditions: [
      {
        allowAppend: false,
        expected: VERSION,
        kind: "parser-version",
        target: "cursor-hooks-adapter-version",
      },
      {
        allowAppend: false,
        expected: String(input.target.storeGeneration),
        kind: "store-generation",
        target: input.target.storeId,
      },
      ...fingerprints(selected),
    ],
    resumeBoundary: "none",
    stopCondition:
      "Stop before effects if scope, selected contents, packaged skill inventory, tracking, Git paths, trusted command or shared work limits change.",
  };
});

const validate = Effect.fn("cursorHooks.validate")(function* validate(
  options: CursorHooksAdapterOptions,
  plan: OperationPlan,
  work: LocalWork
) {
  const worktree = yield* targetFor(options, plan.scope, work);
  const changed = yield* identityChanges(options, plan);

  if (!argumentsMatch(worktree, plan.arguments)) {
    return [...changed, "arguments"];
  }

  return [
    ...changed,
    ...changedSelection(plan, yield* select(options, worktree, work)),
  ];
});

const confirmed = (
  plan: OperationPlan,
  confirmation: string | null | undefined
): boolean =>
  confirmation === `INSTALL CURSOR HOOKS ${plan.consent.scopeDigest}`;

const ensureBackup = (
  selected: Selection,
  file: SelectedFile,
  work: LocalWork
): SelectedFile | null => {
  if (file.body === null) {
    return null;
  }

  const destination = backupPath(selected.locations.ownership, file);

  const existing = readSelected(
    selected.locations.ownershipRoot,
    destination,
    work
  );

  if (existing.body === null) {
    room(work, 1, file.bytes);
    safePath(selected.locations.ownershipRoot, destination);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, file.body, { flag: "wx", mode: 0o600 });
  }

  const backup = readSelected(
    selected.locations.ownershipRoot,
    destination,
    work
  );

  if (backup.digest !== file.digest) {
    throw failure(
      "plan-stale",
      "The Cursor backup does not match the reviewed previous contents."
    );
  }

  return backup;
};

const reader =
  (
    selected: Selection,
    work: LocalWork,
    expected: Map<string, string>
  ): PreparedInstallationReader =>
  (file, purpose) => {
    const known = [...selected.targets, ...selected.backups].find(
      (item) => item.path === file
    );

    if (known === undefined) {
      throw failure(
        "plan-stale",
        "The prepared Cursor installer requested an unreviewed file."
      );
    }

    const actual = readSelected(known.root, file, work);

    if (actual.digest !== expected.get(file)) {
      throw failure(
        "plan-stale",
        "A reviewed Cursor installer file changed before its read."
      );
    }

    if (purpose === "text") {
      text(actual, work);
    }

    return actual.body;
  };

const receiptEffects = (plan: OperationPlan): OperationReceipt["effects"] => ({
  backupArtifacts: [],
  backupIds: [],
  configDigest: null,
  evidenceIds: [],
  exportArtifacts: [],
  exports: [],
  filesChanged: [],
  remainingStoreGeneration: plan.storeGeneration,
  removalReason: null,
  removedCount: 0,
  removedRefs: [],
});

const measured = (work: LocalWork): OperationReceipt["resources"] => ({
  bytesRead: work.bytes,
  elapsedMs: Math.max(0, Math.floor(performance.now() - work.started)),
  recordsDecoded: work.records,
  requests: work.requests,
  retries: 0,
});

const artifact = (
  plan: OperationPlan,
  file: SelectedFile
): OperationReceipt["effects"]["backupArtifacts"][number] => ({
  contentDigest: file.digest,
  id: file.path,
  restorationVersion: "dft.install.ownership.v1",
  storeGeneration: plan.storeGeneration,
  storeId: plan.storeId,
});

const execute = Effect.fn("cursorHooks.execute")(function* execute(
  options: CursorHooksAdapterOptions,
  plan: OperationPlan,
  step: OperationStep,
  confirmation: string | null,
  work: LocalWork
): Effect.fn.Return<OperationEffectResult, AgentStoreFailure> {
  const worktree = yield* targetFor(options, plan.scope, work);

  if (!confirmed(plan, confirmation)) {
    return yield* failure(
      "authorization-required",
      "Use the exact typed confirmation from the reviewed Cursor hook plan."
    );
  }

  if (
    !argumentsMatch(worktree, plan.arguments) ||
    (yield* identityChanges(options, plan)).length > 0
  ) {
    return yield* failure(
      "plan-stale",
      "The selected Cursor scope, arguments or generation changed before execution."
    );
  }

  const selected = yield* select(options, worktree, work);

  if (changedSelection(plan, selected).length > 0) {
    return yield* failure(
      "plan-stale",
      "A reviewed Cursor file, source inventory or tracking decision changed before execution."
    );
  }

  return yield* local<OperationEffectResult>(() => {
    const expected = new Map(
      [...selected.targets, ...selected.backups].map((file) => [
        file.path,
        file.digest,
      ])
    );

    const hooks = selected.targets.find(
      (file) => file.path === path.join(worktree, ".cursor", "hooks.json")
    );

    const owner = selected.targets.find(
      (file) => file.path === selected.locations.ownership
    );

    const exclude = selected.targets.find(
      (file) => file.path === selected.locations.exclude
    );

    if (hooks === undefined || owner === undefined || exclude === undefined) {
      throw failure(
        "plan-stale",
        "The reviewed Cursor target set is incomplete."
      );
    }

    const outputAllowance =
      selected.sourceFiles.reduce((sum, file) => sum + file.bytes, 0) +
      selected.targets.reduce((sum, file) => sum + file.bytes, 0) +
      selected.command.length * 32 +
      16_384;

    room(
      work,
      selected.targets.length * 6 + 8,
      outputAllowance * 5,
      selected.targets.length * 3 + 8
    );

    const backups: SelectedFile[] = [];
    let backupsReady = false;
    let intendedOwnership: string | null = null;

    const onOwnershipWrite = (
      file: string,
      body: string | null,
      stage: "before" | "after"
    ): void => {
      if (file !== owner.path) {
        throw failure(
          "plan-stale",
          "The prepared Cursor installer selected an unreviewed ownership path."
        );
      }

      const digest = body === null ? ABSENT : skillDigest(body);
      const current = readSelected(owner.root, owner.path, work);

      if (stage === "after") {
        if (intendedOwnership !== digest || current.digest !== digest) {
          throw failure(
            "plan-stale",
            "The installed Cursor ownership differs from its exact admitted serialization."
          );
        }

        expected.set(owner.path, digest);
        intendedOwnership = null;

        return;
      }

      if (
        intendedOwnership !== null ||
        current.digest !== expected.get(owner.path)
      ) {
        throw failure(
          "plan-stale",
          "The reviewed Cursor ownership changed before installation."
        );
      }

      room(work, 1, body === null ? 0 : Buffer.byteLength(body));
      intendedOwnership = digest;

      if (!backupsReady) {
        const originals = selected.targets.filter(
          (target) => target.body !== null
        );

        let backupReads = 0;

        let installerReads = 0;

        for (const target of originals) {
          const reviewedBackup = selected.backups.find(
            (backup) =>
              backup.path === backupPath(selected.locations.ownership, target)
          );

          backupReads += target.bytes + (reviewedBackup?.bytes ?? 0);

          if (target.path !== owner.path && target.path !== exclude.path) {
            installerReads += target.bytes * 2;
          }
        }

        room(
          work,
          originals.length * 4 + 1,
          (body === null ? 0 : Buffer.byteLength(body)) +
            backupReads +
            installerReads
        );

        for (const target of selected.targets) {
          const backup = ensureBackup(selected, target, work);

          if (backup !== null) {
            backups.push(backup);
            expected.set(backup.path, backup.digest);
          }
        }

        backupsReady = true;
      }

      room(work, 1, body === null ? 0 : Buffer.byteLength(body));
    };

    const readFile = reader(selected, work, expected);
    installCursorHooks(worktree, selected.command, {
      maxOwnershipBytes: work.bounds.maxBytes - work.bytes,
      onOwnershipWrite,
      ownershipPath: selected.locations.ownership,
      readFile,
      refresh: !selected.tracked.includes(".cursor/hooks.json"),
    });
    installSkills(worktree, selected.source, ".cursor", {
      maxOwnershipBytes: work.bounds.maxBytes - work.bytes,
      onOwnershipWrite,
      ownershipPath: selected.locations.ownership,
      readFile,
      skills: selected.skills,
    });

    const nextExclude = mergeExclude(
      exclude.body?.toString("utf-8") ?? "",
      selected.ignoreEntries
    );

    if (skillDigest(nextExclude) !== exclude.digest && nextExclude !== "") {
      safePath(exclude.root, exclude.path);
      mkdirSync(path.dirname(exclude.path), { recursive: true });
      writeFileSync(exclude.path, nextExclude);
    }

    const after = selected.targets.map((file) =>
      readSelected(file.root, file.path, work)
    );

    const configDigest = fileFingerprint(after);

    return {
      effects: {
        ...receiptEffects(plan),
        backupArtifacts: backups.map((file) => artifact(plan, file)),
        backupIds: backups.map((file) => file.path),
        configDigest,
        filesChanged: after
          .filter(
            (file) =>
              selected.targets.find((before) => before.path === file.path)
                ?.digest !== file.digest
          )
          .map((file) => file.path),
      },
      resources: measured(work),
      step: { ...step, committedThrough: configDigest, state: "committed" },
    };
  });
});

const probe = Effect.fn("cursorHooks.probe")(function* probe(
  options: CursorHooksAdapterOptions,
  plan: OperationPlan,
  step: OperationStep,
  receipt: OperationReceipt,
  work: LocalWork
): Effect.fn.Return<OperationProbe, AgentStoreFailure> {
  const worktree = yield* targetFor(options, plan.scope, work);

  if (
    !argumentsMatch(worktree, plan.arguments) ||
    (yield* identityChanges(options, plan)).length > 0
  ) {
    return {
      reason: "The reviewed Cursor target or generation is unavailable.",
      state: "indeterminate",
    };
  }

  const locations = yield* gitLocations(options.spawner, worktree, work);

  if (
    !plan.preconditions.some(
      (item) =>
        item.target === "cursor-git-locations" &&
        item.expected === JSON.stringify(locations)
    )
  ) {
    return {
      reason: "The selected Cursor Git metadata roots changed.",
      state: "indeterminate",
    };
  }

  const readReviewed = (file: string) => {
    let root = locations.excludeRoot;

    if (descendant(worktree, file)) {
      root = worktree;
    } else if (descendant(locations.ownershipRoot, file)) {
      root = locations.ownershipRoot;
    }

    return readSelected(root, file, work);
  };

  const targets = yield* local(() =>
    plan.preconditions
      .filter((item) => item.kind === "selected-content")
      .map((item) => readReviewed(item.target))
  );

  const digest = fileFingerprint(targets);

  const committed = receipt.steps.find(
    (item) =>
      item.id === step.id &&
      ["committed", "unchanged", "already-applied"].includes(item.state)
  );

  if (
    receipt.storeId === plan.storeId &&
    receipt.storeGeneration === plan.storeGeneration &&
    receipt.planId === plan.id &&
    receipt.planDigest === plan.planDigest &&
    receipt.effects.configDigest === digest &&
    committed?.committedThrough === digest
  ) {
    const requiredBackups = plan.preconditions.flatMap((item) =>
      item.kind === "selected-content" && item.expected !== ABSENT
        ? [
            {
              digest: item.expected,
              path: path.join(
                path.dirname(locations.ownership),
                "backups",
                `${skillDigest(item.target).slice(0, 16)}-${item.expected}.backup`
              ),
            },
          ]
        : []
    );

    const verified = yield* local(
      () =>
        requiredBackups.every((required) =>
          receipt.effects.backupArtifacts.some(
            (item) =>
              item.id === required.path &&
              item.contentDigest === required.digest
          )
        ) &&
        receipt.effects.backupArtifacts.every(
          (item) =>
            readReviewed(item.id).digest === item.contentDigest &&
            item.storeId === plan.storeId &&
            item.storeGeneration === plan.storeGeneration
        )
    );

    return verified
      ? {
          result: {
            effects: receipt.effects,
            resources: measured(work),
            step: {
              ...step,
              committedThrough: digest,
              state: "already-applied",
            },
          },
          state: "complete",
        }
      : {
          reason:
            "The retained Cursor completion record is missing an exact required backup.",
          state: "indeterminate",
        };
  }

  const unchanged = targets.every((file) =>
    plan.preconditions.some(
      (item) =>
        item.kind === "selected-content" &&
        item.target === file.path &&
        item.expected === file.digest
    )
  );

  const backupsUnchanged =
    unchanged &&
    (yield* local(() =>
      plan.preconditions
        .filter((item) => item.kind === "backup-policy")
        .every((item) => readReviewed(item.target).digest === item.expected)
    ));

  return backupsUnchanged
    ? { state: "absent" }
    : {
        reason:
          "Cursor installation files or backups changed without an exact durable completion record. Inspect the selected files before retry.",
        state: "indeterminate",
      };
});

const compatiblePlan = (plan: OperationPlan): boolean =>
  plan.preconditions.some(
    (item) =>
      item.kind === "parser-version" &&
      item.target === "cursor-hooks-adapter-version" &&
      item.expected === VERSION
  );

export const makeCursorHooksAdapter = (
  options: CursorHooksAdapterOptions
): OperationAdapter => ({
  authorize: (plan, input, context) =>
    compatiblePlan(plan)
      ? phase(options, plan.scope, context, (selected, work) =>
          targetFor(selected, plan.scope, work).pipe(
            Effect.as(confirmed(plan, input.confirmation))
          )
        )
      : Effect.fail(
          failure(
            "plan-stale",
            "Review a new Cursor installation plan for this adapter version."
          )
        ),
  descriptor: {
    authorization: "explicit-confirmation",
    cancellation: "before-start-only",
    effects: {
      destructive: false,
      networkDestinations: [],
      reads: [
        "selected packaged Cursor skills and reviewed worktree/Git metadata",
      ],
      writes: [
        "selected .cursor/hooks.json, Cursor skills, ownership, verified backups and local Git exclude",
      ],
    },
    enabled: true,
    idempotency: "durable-key",
    kind: "configure",
    reason: null,
    requiredInputs: [
      "host=cursor",
      "action=install-hooks",
      "canonical .cursor/hooks.json path",
      "exact scope and typed confirmation",
    ],
    version: VERSION,
  },
  execute: (plan, step, context) =>
    compatiblePlan(plan)
      ? phase(options, plan.scope, context, (selected, work) =>
          execute(selected, plan, step, context.confirmation, work)
        )
      : Effect.fail(
          failure(
            "plan-stale",
            "Review a new Cursor installation plan for this adapter version."
          )
        ),
  meteredWork: true,
  prepare: (input, context) =>
    phase(options, input.scope, context, (selected, work) =>
      prepare(selected, input, work)
    ),
  probe: (plan, step, receipt, context) =>
    compatiblePlan(plan)
      ? phase(options, plan.scope, context, (selected, work) =>
          probe(selected, plan, step, receipt, work)
        )
      : Effect.succeed<OperationProbe>({
          reason:
            "The retained Cursor plan belongs to a different adapter version. Inspect its receipt before retry.",
          state: "indeterminate",
        }),
  replay: "probe-required",
  steps: () => [
    operationStep("install-cursor-hooks", "reviewed-local-cursor-installation"),
  ],
  validate: (plan, context) =>
    compatiblePlan(plan)
      ? phase(options, plan.scope, context, (selected, work) =>
          validate(selected, plan, work)
        )
      : Effect.succeed(["adapter-version"]),
});

export class CursorHooksAdapter extends Context.Service<
  CursorHooksAdapter,
  {
    readonly adapter: OperationAdapter | null;
  }
>()("@rat-stack/cli/CursorHooksAdapter") {
  static readonly layer = (
    options: Omit<
      CursorHooksAdapterOptions,
      "store" | "hookCommand" | "spawner"
    > & {
      readonly hookCommand?: () => string;
    }
  ) =>
    Layer.effect(
      CursorHooksAdapter,
      Effect.gen(function* cursorHooksAdapterLayer() {
        const store = yield* AgentStore;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

        const { hookCommand } = options;

        return CursorHooksAdapter.of({
          adapter:
            hookCommand === undefined
              ? null
              : makeCursorHooksAdapter({
                  ...options,
                  hookCommand,
                  spawner,
                  store,
                }),
        });
      })
    );
}
