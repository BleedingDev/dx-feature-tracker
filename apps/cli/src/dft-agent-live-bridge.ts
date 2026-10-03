// @effect-diagnostics-next-line nodeBuiltinImport:off -- Dashboard click operations need unique durable idempotency keys.
import { randomUUID } from "node:crypto";

import {
  AgentError,
  AgentHandleSchema,
  AgentScopeSchema,
  AgentStore,
  buildRegistry,
  configPath,
  contextForRepo,
  makeDxCapabilities,
  OperationInputSchema,
  OperationPlanSchema,
} from "@rat-stack/core/dx";
import type {
  AgentScope,
  AgentStoreFailure,
  AgentStoreService,
  BackupInfo,
  LiveActionError,
  LiveAdministrationPreview,
  LiveAdministrationRequest,
  LiveEngine,
  OperationArguments,
  OperationBounds,
  OperationPlan,
  OperationServiceApi,
  RemovalTotals,
} from "@rat-stack/core/dx";
import { Context, Effect, Function, Layer, Schema } from "effect";

import { AgentApplication } from "./dft-agent-runtime.js";
import { capabilityAt } from "./dft-session.js";

const TargetSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256)
);

const PlanRequestSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("delete"),
    target: Schema.optional(TargetSchema),
  }),
  Schema.Struct({ kind: Schema.Literal("reset") }),
  Schema.Struct({ kind: Schema.Literal("restore"), target: TargetSchema }),
]);

const ConfigureRequestSchema = Schema.Union([
  Schema.Struct({
    action: Schema.Literals(["track", "untrack"]),
    value: TargetSchema,
  }),
  Schema.Struct({ action: Schema.Literal("usage"), value: Schema.Boolean }),
]);

const ExportRequestSchema = Schema.Struct({
  basisId: TargetSchema,
  destination: TargetSchema,
  scope: AgentScopeSchema,
});

export const DashboardOperationReviewSchema = Schema.Struct({
  expectedDigest: OperationPlanSchema.fields.planDigest,
  kind: Schema.Literals(["delete", "reset", "restore", "export"]),
  plan: AgentHandleSchema,
});

export type DashboardOperationReview =
  typeof DashboardOperationReviewSchema.Type;

const ApplyRequestSchema = Schema.Struct({
  confirmation: Schema.String.check(Schema.isMaxLength(4096)),
  idempotencyKey: OperationPlanSchema.fields.id,
  review: DashboardOperationReviewSchema,
});

export const DASHBOARD_OPERATION_BOUNDS: OperationBounds = {
  maxBytes: 67_108_864,
  maxElapsedMs: 60_000,
  maxFiles: 1000,
  maxRecords: 100_000,
  maxRequests: 64,
  maxRetries: 0,
};

const bridgeError = (code: AgentError["code"], message: string) =>
  new AgentError({
    code,
    currentRevision: null,
    expectedRevision: null,
    message,
    recovery: { action: code === "plan-stale" ? "replan" : "none", ref: null },
    ref: null,
    retryable: false,
  });

const decodeInput = <
  S extends Schema.Constraint & { readonly DecodingServices: never },
>(
  schema: S
) =>
  Function.compose(
    Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" }),
    Effect.mapError(() =>
      bridgeError("invalid-selector", "Invalid dashboard operation input.")
    )
  );

const mapPreviewError = (error: LiveActionError) => {
  let code: AgentError["code"] = "source-unavailable";

  if (error.reason === "stale-plan") {
    code = "plan-stale";
  } else if (error.reason === "confirmation") {
    code = "authorization-required";
  } else if (error.reason === "outside-home" || error.reason === "not-a-repo") {
    code = "scope-denied";
  } else if (/budget|bound|limit exceeded/u.test(error.message)) {
    code = "budget-exhausted";
  }

  return bridgeError(code, error.message.slice(0, 4096));
};

const wholeStoreScope: AgentScope = {
  branchSelection: { branches: [], kind: "all" },
  flightId: null,
  repoId: null,
  resolution: "Explicit unfiltered dashboard store administration.",
  sources: [],
  tools: [],
  worktreeId: null,
};

const repositoryScope = Effect.fn("dashboardOperation.repositoryScope")(
  function* repositoryScope(target: string) {
    const context = yield* Effect.sync(() => contextForRepo(target));

    if (context.repoCommonDir === null || context.worktreePath === null) {
      return yield* bridgeError(
        "scope-denied",
        "Select a repository with a canonical Git common directory and worktree."
      );
    }

    return {
      ...wholeStoreScope,
      repoId: context.repoCommonDir,
      resolution: "Explicit unfiltered dashboard repository administration.",
      worktreeId: context.worktreePath,
    } satisfies AgentScope;
  }
);

const expectedPrecondition = (plan: OperationPlan, target: string) =>
  plan.preconditions.find((entry) => entry.target === target)?.expected;

const confirmationFor = Effect.fn("dashboardOperation.confirmationFor")(
  function* confirmationFor(plan: OperationPlan) {
    if (plan.kind === "export") {
      if (
        plan.arguments.kind !== "export" ||
        plan.arguments.disclosure !== "metadata-only"
      ) {
        return yield* bridgeError(
          "scope-denied",
          "Dashboard exports require reviewed metadata-only export arguments."
        );
      }

      return `EXPORT METADATA ${plan.consent.scopeDigest}`;
    }

    const confirmation = plan.preconditions.find(
      (entry) =>
        entry.kind === "backup-policy" && entry.target === "confirmation"
    )?.expected;

    if (confirmation === undefined || confirmation.length === 0) {
      return yield* bridgeError(
        "invalid-transition",
        "The shared operation plan has no reviewed confirmation text."
      );
    }

    return confirmation;
  }
);

export interface DashboardOperationPlan {
  readonly backup: BackupInfo | null;
  readonly branches: number | null;
  readonly confirmText: string;
  readonly countsUnavailableReason: string | null;
  readonly plan: OperationPlan;
  readonly repos: number | null;
  readonly review: DashboardOperationReview;
  readonly totals: RemovalTotals | null;
}

export interface DashboardMetadataExportPlan {
  readonly basisId: string;
  readonly confirmText: string;
  readonly destination: string;
  readonly idempotencyKey: string;
  readonly plan: OperationPlan;
  readonly review: DashboardOperationReview;
}

export const makeDashboardOperationBridge = (dependencies: {
  readonly currentRepo: string;
  readonly engine: Pick<LiveEngine, "home" | "previewAdministration">;
  readonly operations: OperationServiceApi;
  readonly store: AgentStoreService;
}) => {
  const { engine, operations, store } = dependencies;

  const preparePlan = Effect.fn("dashboardOperation.preparePlan")(
    function* preparePlan(args: OperationArguments, scope: AgentScope) {
      const identity = yield* store.identity;

      const input = yield* decodeInput(OperationInputSchema)({
        action: "plan",
        arguments: args,
        bounds: DASHBOARD_OPERATION_BOUNDS,
        purpose: `Apply the explicitly selected dashboard ${args.kind} action.`,
        scope,
        target: identity,
      });

      const output = yield* operations.run(input);

      if (output.action !== "plan" || output.plan.kind !== args.kind) {
        return yield* bridgeError(
          "invalid-transition",
          "The operation service did not return the requested plan."
        );
      }

      return output.plan;
    }
  );

  const prepare = Effect.fn("dashboardOperation.prepare")(function* prepare(
    args: OperationArguments,
    scope: AgentScope,
    preview: LiveAdministrationPreview
  ) {
    const plan = yield* preparePlan(args, scope);

    if (
      expectedPrecondition(plan, "administration.fingerprint") !==
        preview.fingerprint ||
      expectedPrecondition(plan, "administration.current-config") !==
        preview.configDigest
    ) {
      return yield* bridgeError(
        "plan-stale",
        "Administration contents changed while preparing the dashboard review."
      );
    }

    return plan;
  });

  const applyOperation = Effect.fn("dashboardOperation.applyOperation")(
    function* applyOperation(
      plan: Pick<
        OperationPlan,
        "id" | "storeId" | "storeGeneration" | "planDigest"
      >,
      confirmation: string,
      idempotencyKey: string
    ) {
      const input = yield* decodeInput(OperationInputSchema)({
        action: "apply",
        confirmation,
        consentReceiptIds: [],
        expectedDigest: plan.planDigest,
        idempotencyKey,
        plan: {
          id: plan.id,
          storeGeneration: plan.storeGeneration,
          storeId: plan.storeId,
        },
      });

      const output = yield* operations.run(input);

      if (output.action !== "apply") {
        return yield* bridgeError(
          "invalid-transition",
          "The operation service did not return an operation receipt."
        );
      }

      return output;
    }
  );

  const recoverConsumedExport = Effect.fn(
    "dashboardOperation.recoverConsumedExport"
  )(function* recoverConsumedExport(input: typeof ApplyRequestSchema.Type) {
    const applied = yield* applyOperation(
      {
        ...input.review.plan,
        planDigest: input.review.expectedDigest,
      },
      input.confirmation,
      input.idempotencyKey
    );

    if (
      !applied.reused ||
      applied.receipt.executionState === "planned" ||
      applied.receipt.planId !== input.review.plan.id ||
      applied.receipt.planDigest !== input.review.expectedDigest ||
      applied.receipt.idempotencyKey !== input.idempotencyKey ||
      applied.receipt.storeId !== input.review.plan.storeId
    ) {
      return yield* bridgeError(
        "plan-stale",
        "Only the exact consumed dashboard export reservation can be recovered."
      );
    }

    const request = yield* decodeInput(OperationInputSchema)({
      action: "get",
      operation: {
        id: applied.receipt.id,
        storeGeneration: applied.receipt.storeGeneration,
        storeId: applied.receipt.storeId,
      },
    });

    const recovered = yield* operations.run(request);

    if (
      recovered.action !== "get" ||
      recovered.reviewedPlan === null ||
      recovered.receipt.id !== applied.receipt.id ||
      recovered.receipt.planId !== input.review.plan.id ||
      recovered.receipt.planDigest !== input.review.expectedDigest ||
      recovered.receipt.idempotencyKey !== input.idempotencyKey ||
      recovered.receipt.storeId !== applied.receipt.storeId ||
      recovered.receipt.storeGeneration !== applied.receipt.storeGeneration
    ) {
      return yield* bridgeError(
        "plan-stale",
        "The recovered export receipt has no matching immutable reviewed plan."
      );
    }

    return { plan: recovered.reviewedPlan, receipt: recovered.receipt };
  });

  const previewExport = Effect.fn("dashboardOperation.previewExport")(
    function* previewExport(
      request: typeof ExportRequestSchema.Type
    ): Effect.fn.Return<DashboardMetadataExportPlan, AgentStoreFailure> {
      const input = yield* decodeInput(ExportRequestSchema)(request);

      const sharedPlan = yield* preparePlan(
        {
          basisId: input.basisId,
          destination: input.destination,
          disclosure: "metadata-only",
          kind: "export",
        },
        input.scope
      );

      if (
        sharedPlan.arguments.kind !== "export" ||
        sharedPlan.arguments.disclosure !== "metadata-only" ||
        sharedPlan.arguments.basisId !== input.basisId ||
        sharedPlan.arguments.destination !== input.destination
      ) {
        return yield* bridgeError(
          "scope-denied",
          "The shared export plan must retain the selected basis, destination and metadata-only disclosure."
        );
      }

      const confirmText = yield* confirmationFor(sharedPlan);

      const idempotencyKey = yield* decodeInput(
        ApplyRequestSchema.fields.idempotencyKey
      )(`dashboard:export:${sharedPlan.id}`);

      const review = yield* decodeInput(DashboardOperationReviewSchema)({
        expectedDigest: sharedPlan.planDigest,
        kind: "export",
        plan: {
          id: sharedPlan.id,
          storeGeneration: sharedPlan.storeGeneration,
          storeId: sharedPlan.storeId,
        },
      });

      return {
        basisId: input.basisId,
        confirmText,
        destination: input.destination,
        idempotencyKey,
        plan: sharedPlan,
        review,
      };
    }
  );

  const plan = Effect.fn("dashboardOperation.plan")(function* plan(
    kind: "delete" | "reset" | "restore",
    target?: string
  ): Effect.fn.Return<DashboardOperationPlan, AgentStoreFailure> {
    const input = yield* decodeInput(PlanRequestSchema)(
      target === undefined ? { kind } : { kind, target }
    );

    const scope =
      input.kind === "delete"
        ? yield* repositoryScope(input.target ?? dependencies.currentRepo)
        : wholeStoreScope;

    let request: LiveAdministrationRequest;

    if (input.kind === "delete") {
      request = {
        kind: "delete",
        target: scope.worktreeId ?? dependencies.currentRepo,
      };
    } else if (input.kind === "restore") {
      request = { backupId: input.target, kind: "restore" };
    } else {
      request = { kind: "reset" };
    }

    const preview = yield* engine
      .previewAdministration(request, DASHBOARD_OPERATION_BOUNDS)
      .pipe(Effect.mapError(mapPreviewError));

    let args: OperationArguments;

    if (input.kind === "delete") {
      args = { backupRequired: true, kind: "delete", selectedRefs: [] };
    } else if (input.kind === "reset") {
      args = { backupRequired: true, kind: "reset" };
    } else {
      if (preview.backupContentDigest === null) {
        return yield* bridgeError(
          "source-unavailable",
          "The selected backup content digest is unavailable."
        );
      }

      args = {
        backupId: input.target,
        expectedContentDigest: preview.backupContentDigest,
        kind: "restore",
      };
    }

    const sharedPlan = yield* prepare(args, scope, preview);

    const confirmText = yield* confirmationFor(sharedPlan);

    const review = yield* decodeInput(DashboardOperationReviewSchema)({
      expectedDigest: sharedPlan.planDigest,
      kind: input.kind,
      plan: {
        id: sharedPlan.id,
        storeGeneration: sharedPlan.storeGeneration,
        storeId: sharedPlan.storeId,
      },
    });

    let repos: number | null = null;

    if (preview.plan !== null) {
      repos = "repos" in preview.plan ? preview.plan.repos.length : 1;
    }

    return {
      backup: preview.backup,
      branches:
        preview.plan !== null && "branches" in preview.plan
          ? preview.plan.branches.length
          : null,
      confirmText,
      countsUnavailableReason:
        preview.plan === null
          ? "The restore preview does not report restored repository, branch or removal totals."
          : null,
      plan: sharedPlan,
      repos,
      review,
      totals: preview.plan?.totals ?? null,
    };
  });

  const apply = Effect.fn("dashboardOperation.apply")(function* apply(
    review: DashboardOperationReview,
    confirmation: string,
    idempotencyKey: string
  ) {
    const input = yield* decodeInput(ApplyRequestSchema)({
      confirmation,
      idempotencyKey,
      review,
    });

    if (
      input.review.kind === "export" &&
      input.idempotencyKey !== `dashboard:export:${input.review.plan.id}`
    ) {
      return yield* bridgeError(
        "idempotency-conflict",
        "Use the exact retained dashboard export idempotency key."
      );
    }

    const reviewedOperation = yield* store
      .getOperationPlan(input.review.plan)
      .pipe(
        Effect.map((retained) => ({ plan: retained, receipt: null })),
        Effect.catchTag("AgentError", (error) =>
          error.code === "stale-generation" && input.review.kind === "export"
            ? recoverConsumedExport(input)
            : Effect.fail(error)
        )
      );

    const retained = reviewedOperation.plan;

    if (
      retained.kind !== input.review.kind ||
      retained.planDigest !== input.review.expectedDigest ||
      retained.id !== input.review.plan.id ||
      retained.storeId !== input.review.plan.storeId ||
      retained.storeGeneration !== input.review.plan.storeGeneration
    ) {
      return yield* bridgeError(
        "plan-stale",
        "The supplied review does not match the retained operation plan."
      );
    }

    const expectedConfirmation = yield* confirmationFor(retained);

    if (
      retained.kind === "export" &&
      input.idempotencyKey !== `dashboard:export:${retained.id}`
    ) {
      return yield* bridgeError(
        "idempotency-conflict",
        "Use the exact retained dashboard export idempotency key."
      );
    }

    if (input.confirmation !== expectedConfirmation) {
      return yield* bridgeError(
        "authorization-required",
        "Type the exact reviewed confirmation text. Nothing was changed."
      );
    }

    if (reviewedOperation.receipt !== null) {
      const args = retained.arguments;

      if (args.kind !== "export") {
        return yield* bridgeError(
          "scope-denied",
          "The recovered operation is not the reviewed metadata export."
        );
      }

      if (
        reviewedOperation.receipt.effects.exportArtifacts.some(
          (artifact) =>
            artifact.basisId !== args.basisId ||
            artifact.destination !== args.destination ||
            artifact.disclosure !== "metadata-only"
        )
      ) {
        return yield* bridgeError(
          "scope-denied",
          "The recovered metadata artifact differs from its exact reviewed export."
        );
      }

      return reviewedOperation.receipt;
    }

    const output = yield* applyOperation(
      retained,
      input.confirmation,
      input.idempotencyKey
    );

    return output.receipt;
  });

  const configure = Effect.fn("dashboardOperation.configure")(
    function* configure(
      action: "track" | "untrack" | "usage",
      value: string | boolean
    ) {
      const input = yield* decodeInput(ConfigureRequestSchema)({
        action,
        value,
      });

      const scope =
        input.action === "usage"
          ? wholeStoreScope
          : yield* repositoryScope(input.value);

      const request: LiveAdministrationRequest =
        input.action === "usage"
          ? { action: "cursor-usage", enabled: input.value, kind: "configure" }
          : {
              action: input.action === "track" ? "add-repo" : "remove-repo",
              kind: "configure",
              target: scope.worktreeId ?? dependencies.currentRepo,
            };

      const preview = yield* engine
        .previewAdministration(request, DASHBOARD_OPERATION_BOUNDS)
        .pipe(Effect.mapError(mapPreviewError));

      const sharedPlan = yield* prepare(
        {
          expectedContentDigest: preview.configDigest,
          kind: "configure",
          path: configPath(engine.home),
          settings:
            request.action === "cursor-usage"
              ? { action: request.action, enabled: String(request.enabled) }
              : { action: request.action, target: request.target },
        },
        scope,
        preview
      );

      const confirmation = yield* confirmationFor(sharedPlan);
      const idempotencyKey = yield* Effect.sync(randomUUID);

      const output = yield* applyOperation(
        sharedPlan,
        confirmation,
        idempotencyKey
      );

      return output.receipt;
    }
  );

  return { apply, configure, plan, previewExport };
};

export type DashboardOperationBridgeApi = ReturnType<
  typeof makeDashboardOperationBridge
>;

export class DashboardOperationBridge extends Context.Service<
  DashboardOperationBridge,
  DashboardOperationBridgeApi
>()("dft/DashboardOperationBridge") {
  static readonly layer = (options: {
    readonly currentRepo: string;
    readonly engine: Pick<LiveEngine, "home" | "previewAdministration">;
  }) =>
    Layer.effect(
      this,
      Effect.gen(function* dashboardOperationBridge() {
        const store = yield* AgentStore;

        const application = yield* AgentApplication;

        const capabilities = makeDxCapabilities({
          collectors: [],
          defaultRepo: options.currentRepo,
          operation: application.operations.run,
          registry: buildRegistry([], [], []),
          storePath: options.engine.home.storePath,
        });

        const { operation } = capabilityAt(capabilities);

        const operations: OperationServiceApi = {
          descriptors: application.operations.descriptors,
          run: (request) => operation.handler({ request }),
        };

        return makeDashboardOperationBridge({
          ...options,
          operations,
          store,
        });
      })
    );
}
