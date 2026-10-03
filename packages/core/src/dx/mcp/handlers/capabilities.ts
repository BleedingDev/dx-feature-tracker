import { implement } from "@rat-stack/capability/define";
import { Effect } from "effect";

import type { AgentFailure } from "../../contracts/agent.js";
import type {
  DxAnalyzeInput,
  DxEvidenceInput,
  DxEvidenceOutput,
  DxExplainInput,
} from "../../contracts/capabilities.js";
import {
  dxAnalyzeContract,
  dxEvidenceContract,
  dxExplainContract,
  dxStatusContract,
} from "../../contracts/capabilities.js";
import type { QueryFailure } from "../../contracts/errors.js";
import type { EventStore } from "../../contracts/event-store.js";
import type { AgentRequest } from "../../model/agent-common.js";
import type { AgentQueryOutput } from "../../model/agent-query.js";
import type { AnalyzeReport, ExplainTimeline } from "../../model/report.js";
import { handleAgentQuery, selectorStrings } from "./agent-query.js";
import { handleAnalyze } from "./analyze.js";
import type { DxHandlerDeps } from "./deps.js";
import { handleEvidence } from "./evidence.js";
import { handleExplain } from "./explain.js";
import { handleStatus } from "./status.js";
import { isolateStdout } from "./stdio.js";

type Failure = QueryFailure | AgentFailure;

type AnalyzeInput = typeof DxAnalyzeInput.Type;

type ExplainInput = typeof DxExplainInput.Type;

type EvidenceInput = typeof DxEvidenceInput.Type;

type Negotiated<I> = Omit<I, "agentQuery"> & {
  readonly agentQuery: AgentRequest;
};

type Legacy<I> = Omit<I, "agentQuery"> & { readonly agentQuery?: never };

export const makeDxQueryCapabilities = (deps: DxHandlerDeps) => {
  const status = implement(dxStatusContract, (input) =>
    isolateStdout(handleStatus(deps, input))
  );

  const analyze = implement(dxAnalyzeContract, (input) =>
    isolateStdout(
      Effect.suspend<AnalyzeReport | AgentQueryOutput, Failure, EventStore>(
        () =>
          input.agentQuery === undefined
            ? handleAnalyze(deps, input)
            : handleAgentQuery(
                deps,
                "dx_analyze",
                input.agentQuery,
                selectorStrings({
                  asOf: input.asOf,
                  flight: input.flight,
                  repo: input.repo,
                  snapshotId: input.snapshotId,
                }),
                input.cursor
              )
      )
    )
  );

  const explain = implement(dxExplainContract, (input) =>
    isolateStdout(
      Effect.suspend<ExplainTimeline | AgentQueryOutput, Failure, EventStore>(
        () =>
          input.agentQuery === undefined
            ? handleExplain(deps, input)
            : handleAgentQuery(
                deps,
                "dx_explain",
                input.agentQuery,
                selectorStrings({
                  asOf: input.asOf,
                  flight: input.flight,
                  limit: input.limit,
                  snapshotId: input.snapshotId,
                }),
                input.cursor
              )
      )
    )
  );

  const evidence = implement(dxEvidenceContract, (input) =>
    isolateStdout(
      Effect.suspend<
        typeof DxEvidenceOutput.Type | AgentQueryOutput,
        Failure,
        EventStore
      >(() =>
        input.agentQuery === undefined
          ? handleEvidence(deps, input)
          : handleAgentQuery(
              deps,
              "dx_evidence",
              input.agentQuery,
              selectorStrings({
                asOf: input.asOf,
                evidenceIds: input.evidenceIds,
                snapshotId: input.snapshotId,
              }),
              input.cursor
            )
      )
    )
  );

  function analyzeHandler(
    input: Negotiated<AnalyzeInput>
  ): Effect.Effect<AgentQueryOutput, Failure, EventStore>;
  function analyzeHandler(
    input: Legacy<AnalyzeInput>
  ): Effect.Effect<AnalyzeReport, Failure, EventStore>;
  function analyzeHandler(
    input: AnalyzeInput
  ): Effect.Effect<AnalyzeReport | AgentQueryOutput, Failure, EventStore>;
  function analyzeHandler(
    input: AnalyzeInput
  ): Effect.Effect<AnalyzeReport | AgentQueryOutput, Failure, EventStore> {
    return analyze.handler(input);
  }

  function explainHandler(
    input: Negotiated<ExplainInput>
  ): Effect.Effect<AgentQueryOutput, Failure, EventStore>;
  function explainHandler(
    input: Legacy<ExplainInput>
  ): Effect.Effect<ExplainTimeline, Failure, EventStore>;
  function explainHandler(
    input: ExplainInput
  ): Effect.Effect<ExplainTimeline | AgentQueryOutput, Failure, EventStore>;
  function explainHandler(
    input: ExplainInput
  ): Effect.Effect<ExplainTimeline | AgentQueryOutput, Failure, EventStore> {
    return explain.handler(input);
  }

  function evidenceHandler(
    input: Negotiated<EvidenceInput>
  ): Effect.Effect<AgentQueryOutput, Failure, EventStore>;
  function evidenceHandler(
    input: Legacy<EvidenceInput>
  ): Effect.Effect<typeof DxEvidenceOutput.Type, Failure, EventStore>;
  function evidenceHandler(
    input: EvidenceInput
  ): Effect.Effect<
    typeof DxEvidenceOutput.Type | AgentQueryOutput,
    Failure,
    EventStore
  >;
  function evidenceHandler(
    input: EvidenceInput
  ): Effect.Effect<
    typeof DxEvidenceOutput.Type | AgentQueryOutput,
    Failure,
    EventStore
  > {
    return evidence.handler(input);
  }

  return [
    status,
    { ...analyze, handler: analyzeHandler },
    { ...explain, handler: explainHandler },
    { ...evidence, handler: evidenceHandler },
  ] as const;
};
