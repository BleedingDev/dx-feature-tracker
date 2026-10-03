import { Effect, Result, Schema } from "effect";

import type {
  AgentStoreFailure,
  AgentStoreService,
} from "../../contracts/agent-store.js";
import {
  AGENT_PROFILE_VERSION,
  AgentCountSchema,
  AgentRefSchema,
} from "../../model/agent-common.js";
import type {
  AgentRef,
  AgentRefResolution,
  StoreIdentity,
} from "../../model/agent-common.js";
import {
  AGENT_RESULT_VERSION,
  AgentQueryOutputSchema,
} from "../../model/agent-query.js";
import type {
  AgentBasisDifference,
  AgentCursor,
  AgentQueryInput,
  AgentQueryOutput,
  AgentResultMetadata,
  AgentView,
  AgentWork,
  AnalysisBasisMetadata,
} from "../../model/agent-query.js";
import { agentDigest, agentFailure, canonicalAgentJson } from "./basis.js";
import { ProjectionItemSchema } from "./projection.js";

export interface FinishAgentResponseArgs {
  readonly input: AgentQueryInput;
  readonly store: AgentStoreService;
  readonly identity: StoreIdentity;
  readonly basis: AnalysisBasisMetadata;
  readonly result: AgentResultMetadata;
  readonly page: {
    readonly view: AgentView;
    readonly nextPosition: number | null;
    readonly nextSeriesPosition: number | null;
  };
  readonly resolutions: readonly AgentRefResolution[];
  readonly difference: AgentBasisDifference | null;
  readonly measurements: {
    readonly factsExamined: number;
    readonly decodedBytes: number;
    readonly basisWrites: number;
    readonly cacheWrites: number;
    readonly started: number;
  };
  readonly itemPosition: number;
  readonly seriesPosition: number;
  readonly retainedSeriesCount?: number;
  readonly cursorAxis?: AgentCursor["axis"];
}

interface ResponseCursors {
  readonly items: AgentCursor | null;
  readonly series: AgentCursor | null;
  readonly work: AgentCursor | null;
}

const responseBytes = (output: AgentQueryOutput): number =>
  Buffer.byteLength(JSON.stringify(output), "utf-8");

const outputWithByteCount = (
  output: AgentQueryOutput,
  outputBytes: number
): AgentQueryOutput => ({
  ...output,
  context: {
    ...output.context,
    resources: { ...output.context.resources, outputBytes },
  },
});

const outputWithMeasuredBytes = (
  output: AgentQueryOutput
): AgentQueryOutput => {
  let outputBytes = 0;
  let actual = responseBytes(outputWithByteCount(output, outputBytes));

  while (outputBytes !== actual) {
    outputBytes = actual;
    actual = responseBytes(outputWithByteCount(output, outputBytes));
  }

  return outputWithByteCount(output, outputBytes);
};

const outputWithElapsed = (
  output: AgentQueryOutput,
  elapsedMs: number
): AgentQueryOutput => {
  const previousBytes = output.context.resources.outputBytes;
  const previousElapsed = output.context.resources.elapsedMs;

  const fixedBytes =
    (previousBytes ?? responseBytes(output)) -
    String(previousBytes).length -
    String(previousElapsed).length +
    String(elapsedMs).length;

  let outputBytes = fixedBytes + 1;
  let nextBytes = fixedBytes + String(outputBytes).length;

  while (nextBytes !== outputBytes) {
    outputBytes = nextBytes;
    nextBytes = fixedBytes + String(outputBytes).length;
  }

  return {
    ...output,
    context: {
      ...output.context,
      resources: { ...output.context.resources, elapsedMs, outputBytes },
    },
  };
};

const responseCursor = (
  args: FinishAgentResponseArgs,
  lane: "items" | "series" | "work",
  position: number
): AgentCursor => {
  const body: Omit<AgentCursor, "id"> = {
    axis: lane,
    basisId: args.basis.id,
    kind: lane === "work" ? "work-continuation" : "output-page",
    position,
    projectionVersion: args.result.projectionVersion,
    queryDigest: args.result.queryDigest,
    resultId: args.result.id,
    storeGeneration: args.identity.storeGeneration,
    storeId: args.identity.storeId,
    storeRevision: lane === "work" ? args.identity.revision : null,
  };

  const prefix = lane === "items" ? "page" : lane;

  return { ...body, id: `${prefix}_${agentDigest(body).slice(0, 48)}` };
};

const responseCursors = (
  args: FinishAgentResponseArgs,
  nextPosition: number | null,
  nextSeriesPosition: number | null
): ResponseCursors => ({
  items:
    nextPosition === null ? null : responseCursor(args, "items", nextPosition),
  series:
    nextSeriesPosition === null
      ? null
      : responseCursor(args, "series", nextSeriesPosition),
  work:
    args.result.completeness.aggregation === "partial"
      ? responseCursor(args, "work", 0)
      : null,
});

const json = Schema.decodeUnknownSync(Schema.Json);

const SeriesPointSchema = Schema.Struct({
  bucket: Schema.String,
  omittedStacks: Schema.optional(AgentCountSchema),
  stacks: Schema.Array(Schema.Json),
  values: Schema.Json,
});

const itemReference = Schema.is(Schema.Struct({ ref: AgentRefSchema }));

const encodeRef = Schema.encodeSync(Schema.fromJsonString(AgentRefSchema));

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

const referenceKey = (ref: AgentRef): string =>
  canonicalAgentJson(decodeJson(encodeRef(ref)));

const responseItems = (
  items: AgentView["items"],
  detail: AgentQueryInput["agent"]["detail"]
): AgentView["items"] =>
  detail === "expanded"
    ? items
    : items.map((item) =>
        Schema.is(ProjectionItemSchema)(item)
          ? json({
              conflicting: item.conflicting,
              ref: item.ref,
              supporting: item.supporting,
            })
          : item
      );

const responseSeries = (
  series: AgentView["series"],
  maxStacks: number
): AgentView["series"] =>
  series.map((point) => {
    const decoded = Schema.decodeUnknownResult(SeriesPointSchema)(point);

    if (Result.isFailure(decoded)) {
      return point;
    }

    const { bucket, omittedStacks = 0, stacks, values } = decoded.success;

    return json({
      bucket,
      omittedStacks: omittedStacks + Math.max(0, stacks.length - maxStacks),
      stacks: stacks.slice(0, maxStacks),
      values,
    });
  });

const hasOmittedStacks = (series: AgentView["series"]): boolean =>
  series.some((point) => {
    const decoded = Schema.decodeUnknownResult(SeriesPointSchema)(point);

    return (
      Result.isSuccess(decoded) && (decoded.success.omittedStacks ?? 0) > 0
    );
  });

const resolutionsForPage = (
  resolutions: readonly AgentRefResolution[],
  items: AgentView["items"]
): AgentRefResolution[] => {
  const returned = new Set(
    items.flatMap((item) =>
      itemReference(item) ? [referenceKey(item.ref)] : []
    )
  );

  return resolutions.map((resolution) =>
    resolution.state === "found" && !returned.has(referenceKey(resolution.ref))
      ? {
          ...resolution,
          reason:
            "The reference is retained but its item is outside this response budget or page.",
          state: "over-budget",
        }
      : resolution
  );
};

interface ResponseEnvelopeArgs {
  readonly args: FinishAgentResponseArgs;
  readonly view: AgentView;
  readonly cursors: ResponseCursors;
  readonly nextPosition: number | null;
  readonly nextSeriesPosition: number | null;
  readonly outputLimited: boolean;
  readonly elapsedMs: number;
}

const responseReason = ({
  args,
  cursors,
  outputLimited,
  view,
}: ResponseEnvelopeArgs): string | null => {
  const reason = [
    args.result.completeness.reason,
    outputLimited ? "Detail was truncated by the output byte budget." : null,
    hasOmittedStacks(view.series)
      ? "Stack rows were truncated; bucket totals retain all selected rows and omittedStacks reports the exact count per returned bucket."
      : null,
    cursors.work === null
      ? null
      : "The work continuation restarts the same watermark and window with the next requested budget.",
  ]
    .filter((part) => part !== null)
    .join(" ");

  return reason.length === 0 ? null : reason;
};

const responseLimit = ({
  args,
  cursors,
  nextPosition,
  nextSeriesPosition,
  outputLimited,
  view,
}: ResponseEnvelopeArgs): AgentWork["limitReached"] => {
  if (outputLimited) {
    return "output-bytes";
  }

  if (nextPosition !== null) {
    return "items";
  }

  if (nextSeriesPosition !== null) {
    return "series";
  }

  if (hasOmittedStacks(view.series)) {
    return "stacks";
  }

  if (cursors.work !== null) {
    return args.measurements.factsExamined >= args.input.agent.budget.maxFacts
      ? "facts"
      : "decoded-bytes";
  }

  return null;
};

const responseEnvelope = (envelope: ResponseEnvelopeArgs): AgentQueryOutput => {
  const { args, view, cursors, nextPosition, nextSeriesPosition, elapsedMs } =
    envelope;

  const { basis, result, input, measurements } = args;
  const { budget, policies } = input.agent;
  const stacksOmitted = hasOmittedStacks(view.series);
  const resolutions = resolutionsForPage(args.resolutions, view.items);

  const resultRef: AgentRef = {
    basisId: basis.id,
    id: result.id,
    kind: "result",
    storeGeneration: basis.storeGeneration,
    storeId: basis.storeId,
    version: AGENT_RESULT_VERSION,
  };

  return {
    context: {
      basisId: basis.id,
      completeness: {
        ...result.completeness,
        items: nextPosition === null ? result.completeness.items : "truncated",
        missingRefs: resolutions.filter(
          (resolution) => resolution.state !== "found"
        ).length,
        omittedItems: Math.max(
          0,
          result.itemCount - args.itemPosition - view.items.length
        ),
        omittedSeries: Math.max(
          0,
          (args.retainedSeriesCount ?? result.seriesCount) -
            args.seriesPosition -
            view.series.length
        ),
        reason: responseReason(envelope),
        series:
          nextSeriesPosition !== null || stacksOmitted
            ? "truncated"
            : result.completeness.series,
      },
      coverage: basis.coverage,
      effectivePolicies: policies,
      effects: {
        acquisitionReceiptIds: basis.acquisitionReceiptIds,
        basisWrites: measurements.basisWrites,
        cacheWrites:
          measurements.cacheWrites +
          [cursors.work, cursors.items, cursors.series].filter(
            (cursor) => cursor !== null
          ).length,
        networkRequests: 0,
      },
      freshness: basis.coverage.map((coverage) => ({
        lastSuccess: coverage.state === "complete" ? coverage.windowTo : null,
        observedAt: coverage.windowTo,
        reason:
          coverage.state === "complete"
            ? null
            : `Recorded coverage is ${coverage.state}; ${coverage.gaps.map((gap) => gap.code).join(", ")}`,
        source: coverage.adapterId,
      })),
      id: result.id,
      next: [
        resultRef,
        ...view.items
          .flatMap((item) => (itemReference(item) ? [item.ref] : []))
          .slice(0, 15),
      ],
      originMix: basis.originMix,
      profileVersion: AGENT_PROFILE_VERSION,
      reproducibility: basis.reproducibility,
      resources: {
        appliedLimits: budget,
        continuation:
          cursors.work?.id ?? cursors.items?.id ?? cursors.series?.id ?? null,
        decodedBytes: measurements.decodedBytes,
        elapsedMs,
        factsExamined: measurements.factsExamined,
        limitReached: responseLimit(envelope),
        networkRequests: 0,
        outputBytes: 0,
      },
      resultDigest: result.resultDigest,
      resultRef,
      revisions: {
        attribution: basis.attributionVersion,
        config: basis.configDigest,
        definitions: agentDigest(basis.metricDefinitions),
        derivation: basis.reconciliationVersion,
        evidence: basis.selectedEventDigest,
        prices: agentDigest(
          basis.priceSheets.map((sheet) => [sheet.id, sheet.contentHash])
        ),
      },
      schemaVersion: "dx.context.v1",
      scope: basis.scope,
      storeGeneration: basis.storeGeneration,
      storeId: basis.storeId,
      window: basis.window,
    },
    difference: args.difference,
    resolutions,
    result,
    view: {
      ...view,
      nextCursor: cursors.items?.id ?? null,
      nextSeriesCursor: cursors.series?.id ?? null,
    },
  };
};

const pruneResponseView = (
  view: AgentView,
  axis: "items" | "series"
): AgentView => ({
  ...view,
  items: axis === "items" ? view.items.slice(0, -1) : view.items,
  series: axis === "series" ? view.series.slice(0, -1) : view.series,
});

const responseStalled = (
  args: FinishAgentResponseArgs,
  view: AgentView,
  nextPosition: number | null,
  nextSeriesPosition: number | null
): boolean => {
  const itemsStalled =
    args.cursorAxis === "items" &&
    nextPosition !== null &&
    view.items.length === 0;

  const seriesStalled =
    args.cursorAxis === "series" &&
    nextSeriesPosition !== null &&
    view.series.length === 0;

  const noProgress =
    view.items.length === 0 &&
    view.series.length === 0 &&
    (nextPosition !== null || nextSeriesPosition !== null);

  return itemsStalled || seriesStalled || noProgress;
};

export const finishAgentResponse = Effect.fn("finishAgentResponse")(
  function* finishAgentResponse(
    args: FinishAgentResponseArgs
  ): Effect.fn.Return<AgentQueryOutput, AgentStoreFailure> {
    const { budget } = args.input.agent;

    if (
      args.measurements.factsExamined > budget.maxFacts ||
      args.measurements.decodedBytes > budget.maxDecodedBytes ||
      performance.now() - args.measurements.started > budget.maxElapsedMs
    ) {
      return yield* agentFailure(
        "budget-exhausted",
        "The measured query work exceeds the requested facts, bytes or elapsed budget."
      );
    }

    let view: AgentView = {
      ...args.page.view,
      items: responseItems(args.page.view.items, args.input.agent.detail),
      series: responseSeries(args.page.view.series, budget.maxStacks),
    };

    let { nextPosition, nextSeriesPosition } = args.page;
    let outputLimited = false;
    let cursors = responseCursors(args, nextPosition, nextSeriesPosition);

    let output = outputWithMeasuredBytes(
      responseEnvelope({
        args,
        cursors,
        elapsedMs: budget.maxElapsedMs,
        nextPosition,
        nextSeriesPosition,
        outputLimited,
        view,
      })
    );

    while (responseBytes(output) > budget.maxOutputBytes) {
      if (performance.now() - args.measurements.started > budget.maxElapsedMs) {
        return yield* agentFailure(
          "budget-exhausted",
          "The elapsed response work exceeds the requested elapsed budget."
        );
      }

      if (args.cursorAxis === "series" && view.items.length > 0) {
        view = pruneResponseView(view, "items");
        nextPosition = args.itemPosition + view.items.length;
      } else if (view.series.length > 0) {
        view = pruneResponseView(view, "series");
        nextSeriesPosition = args.seriesPosition + view.series.length;
      } else if (view.items.length > 0) {
        view = pruneResponseView(view, "items");
        nextPosition = args.itemPosition + view.items.length;
      } else {
        return yield* agentFailure(
          "budget-exhausted",
          "The requested output budget cannot contain the mandatory scope, gaps, completeness and continuation envelope."
        );
      }

      outputLimited = true;
      cursors = responseCursors(args, nextPosition, nextSeriesPosition);
      output = outputWithMeasuredBytes(
        responseEnvelope({
          args,
          cursors,
          elapsedMs: budget.maxElapsedMs,
          nextPosition,
          nextSeriesPosition,
          outputLimited,
          view,
        })
      );
    }

    if (responseStalled(args, view, nextPosition, nextSeriesPosition)) {
      return yield* agentFailure(
        "budget-exhausted",
        responseStalled(
          args,
          args.page.view,
          args.page.nextPosition,
          args.page.nextSeriesPosition
        )
          ? "The retained-page work budget permits no detail on the requested page. Increase maxFacts or maxDecodedBytes to advance the continuation."
          : "The output byte budget permits no detail on the requested page. Increase maxOutputBytes to advance the continuation."
      );
    }

    yield* Schema.decodeUnknownEffect(AgentQueryOutputSchema)(output).pipe(
      Effect.mapError(() =>
        agentFailure(
          "basis-incompatible",
          "The retained view does not match the negotiated response schema."
        )
      )
    );

    for (const cursor of [cursors.work, cursors.items, cursors.series]) {
      if (cursor !== null) {
        yield* args.store.putCursor(cursor);
      }
    }

    const elapsed = performance.now() - args.measurements.started;

    if (elapsed > budget.maxElapsedMs) {
      return yield* agentFailure(
        "budget-exhausted",
        "The elapsed query work exceeds the requested elapsed budget."
      );
    }

    const measured = outputWithElapsed(
      output,
      Math.max(0, Math.floor(elapsed))
    );

    if (performance.now() - args.measurements.started > budget.maxElapsedMs) {
      return yield* agentFailure(
        "budget-exhausted",
        "The final response measurement exceeds the requested elapsed budget."
      );
    }

    return measured;
  }
);
