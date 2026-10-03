// @effect-diagnostics nodeBuiltinImport:off -- Enrollment reads one explicitly configured file through a capped nofollow descriptor and never discovers sources.
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import type { Stats } from "node:fs";
import path from "node:path";

import {
  AgentError,
  DEFAULT_LIVE_CONFIG,
  HarnessHome,
  configPath,
  contextForRepo,
} from "@rat-stack/core/dx";
import type {
  AgentStoreFailure,
  CollectionEnrollmentRequest,
  ExplicitSourceMapping,
  HarnessId,
  LiveConfig,
  LiveHome,
  OperationPlan,
  OperationWorkContext,
} from "@rat-stack/core/dx";
import { Context, Effect, Exit, Layer, Option, Schema } from "effect";

type Enrollment = Pick<
  OperationPlan["consent"],
  "state" | "reason" | "receiptIds"
>;

export interface TrackedEnrollmentConfig {
  readonly config: LiveConfig | null;
  readonly cursorUsageEnrolled: boolean;
  readonly digest: string | null;
  readonly receiptIds: readonly string[];
}

interface RawConfigSnapshot {
  readonly digest: string;
  readonly text: string;
}

export interface TrackedSourceEnrollmentOptions {
  readonly cursorUsageSources?: readonly string[];
  readonly home: LiveHome;
  readonly locations: { readonly rootOf: (harness: HarnessId) => string };
  readonly mappings: readonly ExplicitSourceMapping[];
  readonly resolveContext?: (
    worktree: string,
    work: OperationWorkContext
  ) => Effect.Effect<ReturnType<typeof contextForRepo>, AgentStoreFailure>;
  readonly sourceRoots?: (source: string) => readonly string[];
}

const EnrollmentConfigSchema = Schema.fromJsonString(
  Schema.Struct({
    cursorUsageImport: Schema.optionalKey(Schema.Boolean),
    repos: Schema.optionalKey(
      Schema.Array(Schema.String.check(Schema.isMaxLength(4096))).check(
        Schema.isMaxLength(256)
      )
    ),
  })
);

const decodeEnrollmentConfig = Schema.decodeUnknownEffect(
  EnrollmentConfigSchema
);

const enrollmentError = (code: AgentError["code"], message: string) =>
  new AgentError({
    code,
    currentRevision: null,
    expectedRevision: null,
    message,
    recovery: { action: "replan", ref: null },
    ref: null,
    retryable: false,
  });

const decodeConfigFailure = Schema.decodeUnknownOption(AgentError);

const configFailure = (error: Option.Option<AgentError>): AgentError =>
  Option.getOrElse(error, () =>
    enrollmentError(
      "source-unavailable",
      "The exact enrollment configuration is unavailable or invalid."
    )
  );

const configStat = (file: string): Stats | null => {
  const absolute = path.resolve(file);
  const base = path.parse(absolute).root;
  const parts = absolute.slice(base.length).split(path.sep);

  for (let index = 0; index < parts.length; index += 1) {
    const current = path.join(base, ...parts.slice(0, index + 1));
    const info = lstatSync(current, { throwIfNoEntry: false });

    if (info === undefined) {
      return null;
    }

    if (
      info.isSymbolicLink() ||
      (index < parts.length - 1 && !info.isDirectory())
    ) {
      throw enrollmentError(
        "scope-denied",
        "The enrollment configuration path contains a linked or conflicting component."
      );
    }

    if (index === parts.length - 1) {
      if (!info.isFile()) {
        throw enrollmentError(
          "source-unavailable",
          "The enrollment configuration is not a regular file."
        );
      }

      return info;
    }
  }

  return null;
};

const sameConfig = (left: Stats, right: Stats): boolean =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.mtimeMs === right.mtimeMs &&
  left.ctimeMs === right.ctimeMs;

const readConfigSnapshot = (
  file: string,
  expected: Stats,
  measured: (bytes: number) => void
): RawConfigSnapshot => {
  const descriptor = openSync(file, constants.O_RDONLY + constants.O_NOFOLLOW);

  try {
    const opened = fstatSync(descriptor);

    if (!opened.isFile() || !sameConfig(expected, opened)) {
      throw enrollmentError(
        "plan-stale",
        "The enrollment configuration changed before its bounded read."
      );
    }

    const bytes = Buffer.alloc(expected.size);
    let offset = 0;

    while (offset < bytes.byteLength) {
      const count = readSync(
        descriptor,
        bytes,
        offset,
        bytes.byteLength - offset,
        offset
      );

      measured(count);

      if (count === 0) {
        throw enrollmentError(
          "plan-stale",
          "The enrollment configuration shrank during its bounded read."
        );
      }

      offset += count;
    }

    const finished = fstatSync(descriptor);
    const current = configStat(file);

    if (
      current === null ||
      !sameConfig(expected, finished) ||
      !sameConfig(expected, current)
    ) {
      throw enrollmentError(
        "plan-stale",
        "The enrollment configuration changed during its bounded read."
      );
    }

    return {
      digest: createHash("sha256").update(bytes).digest("hex"),
      text: bytes.toString("utf-8"),
    };
  } finally {
    closeSync(descriptor);
  }
};

const visitConfig = Effect.fn("enrollment.visitConfig")(function* visit(
  file: string,
  work: OperationWorkContext
) {
  const usage = {
    bytesRead: 0,
    filesRead: 1,
    recordsDecoded: 0,
    requests: 0,
    retries: 0,
  };

  return yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* reservedVisit() {
      const reserved = yield* work.budget.reserve(usage);

      const inspected = yield* Effect.exit(
        restore(
          Effect.try({
            catch: (error) => configFailure(decodeConfigFailure(error)),
            try: () => configStat(file),
          })
        )
      );

      yield* reserved.complete(usage);

      return Exit.isSuccess(inspected)
        ? inspected.value
        : yield* Effect.failCause(inspected.cause);
    })
  );
});

export const readTrackedEnrollmentConfig = Effect.fn("enrollment.readConfig")(
  function* read(
    home: LiveHome,
    work: OperationWorkContext
  ): Effect.fn.Return<TrackedEnrollmentConfig, AgentStoreFailure> {
    const file = configPath(home);
    const expected = yield* visitConfig(file, work);
    const remaining = yield* work.budget.remaining;

    if (expected === null) {
      return {
        config: null,
        cursorUsageEnrolled: false,
        digest: null,
        receiptIds: [],
      };
    }

    if (expected.size > Math.min(remaining.maxBytes, 131_072)) {
      return yield* enrollmentError(
        "budget-exhausted",
        "The enrollment configuration exceeds its bounded byte allowance."
      );
    }

    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* reservedDecode() {
        const reserved = yield* work.budget.reserve({
          bytesRead: expected.size,
          filesRead: 0,
          recordUnits: expected.size + 1,
          recordsDecoded: null,
          requests: 0,
          retries: 0,
        });

        let bytesRead = 0;

        const decoded = yield* Effect.exit(
          restore(
            Effect.try({
              catch: (error) => configFailure(decodeConfigFailure(error)),
              try: () =>
                readConfigSnapshot(file, expected, (bytes) => {
                  bytesRead += bytes;
                }),
            }).pipe(
              Effect.flatMap((snapshot) =>
                decodeEnrollmentConfig(snapshot.text).pipe(
                  Effect.mapError(() => configFailure(Option.none())),
                  Effect.map((config) => ({ config, digest: snapshot.digest }))
                )
              )
            )
          )
        );

        yield* reserved.complete({
          bytesRead,
          filesRead: 0,
          recordUnits: Exit.isSuccess(decoded)
            ? (decoded.value.config.repos?.length ?? 0) + 1
            : expected.size + 1,
          recordsDecoded: Exit.isSuccess(decoded)
            ? (decoded.value.config.repos?.length ?? 0) + 1
            : null,
          requests: 0,
          retries: 0,
        });

        if (Exit.isFailure(decoded)) {
          return yield* Effect.failCause(decoded.cause);
        }

        yield* work.budget.remaining;

        return {
          config: {
            cursorUsageImport:
              decoded.value.config.cursorUsageImport ??
              DEFAULT_LIVE_CONFIG.cursorUsageImport,
            repos: decoded.value.config.repos ?? DEFAULT_LIVE_CONFIG.repos,
          },
          cursorUsageEnrolled: decoded.value.config.cursorUsageImport === true,
          digest: decoded.value.digest,
          receiptIds: [file],
        };
      })
    );
  }
);

const within = (root: string, selected: string): boolean => {
  if (
    !path.isAbsolute(root) ||
    path.resolve(root) !== root ||
    !path.isAbsolute(selected) ||
    path.resolve(selected) !== selected
  ) {
    return false;
  }

  const relative = path.relative(root, selected);

  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
};

const denied = (reason: string): Enrollment => ({
  reason,
  receiptIds: [],
  state: "denied",
});

export const makeTrackedSourceEnrollment = (
  options: TrackedSourceEnrollmentOptions
): ((
  request: CollectionEnrollmentRequest,
  work: OperationWorkContext
) => Effect.Effect<Enrollment, AgentStoreFailure>) =>
  Effect.fn("trackedSourceEnrollment")(function* enrolled(
    request: CollectionEnrollmentRequest,
    work: OperationWorkContext
  ): Effect.fn.Return<Enrollment, AgentStoreFailure> {
    const snapshot = yield* readTrackedEnrollmentConfig(options.home, work);
    const { config } = snapshot;
    const worktree = request.scope.worktreeId;

    if (
      config === null ||
      worktree === null ||
      !config.repos.includes(worktree)
    ) {
      return denied(
        "Track the exact repository before collecting its selected source."
      );
    }

    const mapping = options.mappings.find(
      (entry) => entry.source === request.source
    );

    const roots = [
      ...new Set([
        ...(mapping === undefined
          ? []
          : [options.locations.rootOf(mapping.harness)]),
        ...(options.sourceRoots?.(request.source) ?? []),
      ]),
    ];

    const requiresCursorUsage =
      (mapping?.harness === "cursor" && mapping.channel === "usage-api") ||
      (options.cursorUsageSources ?? []).includes(request.source);

    if (
      roots.length === 0 ||
      (requiresCursorUsage && !snapshot.cursorUsageEnrolled)
    ) {
      return denied(
        "The selected source is unsupported or its explicit enrollment is disabled."
      );
    }

    if (
      request.selectedRoots.length === 0 ||
      !request.selectedRoots.every(
        (root) =>
          within(worktree, root) ||
          roots.some((allowed) => within(allowed, root))
      )
    ) {
      return denied(
        "Select exact local roots inside the tracked worktree or its configured source root."
      );
    }

    yield* work.budget.remaining;

    const context = yield* options.resolveContext === undefined
      ? Effect.try({
          catch: (error) => configFailure(decodeConfigFailure(error)),
          try: () => contextForRepo(worktree),
        })
      : options.resolveContext(worktree, work);

    yield* work.budget.remaining;

    if (
      context.worktreePath !== worktree ||
      context.repoCommonDir !== request.scope.repoId ||
      context.repoCommonDir === null
    ) {
      return denied(
        "The current repository identity does not match the exact tracked operation scope."
      );
    }

    return {
      reason:
        "The exact tracked repository and selected source roots have explicit local enrollment.",
      receiptIds: snapshot.receiptIds,
      state: "authorized" as const,
    };
  });

interface TrackedSourceEnrollmentService {
  readonly authorize: ReturnType<typeof makeTrackedSourceEnrollment>;
  readonly readConfig: (
    work: OperationWorkContext
  ) => Effect.Effect<TrackedEnrollmentConfig, AgentStoreFailure>;
}

export class TrackedSourceEnrollment extends Context.Service<
  TrackedSourceEnrollment,
  TrackedSourceEnrollmentService
>()("@rat-stack/cli/TrackedSourceEnrollment") {
  static readonly layer = (
    options: Omit<TrackedSourceEnrollmentOptions, "locations">
  ) =>
    Layer.effect(
      TrackedSourceEnrollment,
      Effect.gen(function* makeEnrollment() {
        const locations = yield* HarnessHome;

        const authorize = makeTrackedSourceEnrollment({
          ...options,
          locations,
          resolveContext:
            options.resolveContext ??
            (() =>
              Effect.fail(
                enrollmentError(
                  "source-unavailable",
                  "The bounded repository identity resolver is unavailable."
                )
              )),
        });

        const readConfig = Effect.fn("TrackedSourceEnrollment.readConfig")(
          function* snapshot(work: OperationWorkContext) {
            return yield* readTrackedEnrollmentConfig(options.home, work);
          }
        );

        return { authorize, readConfig };
      })
    );
}
