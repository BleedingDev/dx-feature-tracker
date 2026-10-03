import { Effect, Schema } from "effect";

import type { AgentFailure } from "../../contracts/agent.js";
import { AgentError } from "../../contracts/error-agent.js";
import type { QueryFailure } from "../../contracts/errors.js";
import type { AgentRequest } from "../../model/agent-common.js";
import type {
  AgentQueryInput,
  AgentQueryOutput,
} from "../../model/agent-query.js";
import type { DxHandlerDeps } from "./deps.js";

export const agentUnavailable = (message: string) =>
  new AgentError({
    code: "view-not-ready",
    currentRevision: null,
    expectedRevision: null,
    message,
    recovery: { action: "none", ref: null },
    ref: null,
    retryable: false,
  });

export const handleAgentQuery = (
  deps: DxHandlerDeps,
  capability: AgentQueryInput["capability"],
  agent: AgentRequest,
  selectors: Readonly<Record<string, readonly string[]>>,
  cursor?: string
): Effect.Effect<AgentQueryOutput, QueryFailure | AgentFailure> => {
  if (deps.agentQuery === undefined) {
    return Effect.fail(
      agentUnavailable("The installed composition has no agent query service.")
    );
  }

  const request: AgentQueryInput = { agent, capability, selectors };

  return deps.agentQuery(
    cursor === undefined ? request : { ...request, cursor }
  );
};

export const selectorStrings = (
  input: Readonly<
    Record<string, string | number | readonly string[] | undefined>
  >
) =>
  Object.fromEntries(
    Object.entries(input).flatMap(([key, value]) =>
      value === undefined
        ? []
        : [
            [
              key,
              Schema.is(Schema.Array(Schema.String))(value)
                ? value
                : [String(value)],
            ],
          ]
    )
  );

export const normalizeAgentSelectors = (
  input: AgentQueryInput,
  from: string | null | undefined,
  allRepos: boolean | undefined,
  resolveRepo: (value: string) => string | null
): Readonly<Record<string, readonly string[]>> => {
  const { asOf, evidenceIds: _ids, flight, ...original } = input.selectors;
  let selectors = original;

  if (asOf !== undefined) {
    selectors = { ...selectors, until: asOf };
  }

  if (flight !== undefined) {
    selectors = { ...selectors, flightId: flight };
  }

  if (input.agent.basisId !== undefined || input.cursor !== undefined) {
    return selectors;
  }

  if (selectors.repo !== undefined) {
    selectors = {
      ...selectors,
      repo: selectors.repo.map((repo) =>
        repo === "(all)" || repo === "(no repo)"
          ? repo
          : (resolveRepo(repo) ?? repo)
      ),
    };
  }

  if (from !== undefined && from !== null && selectors.since === undefined) {
    selectors = { ...selectors, since: [from] };
  }

  if (allRepos === true && selectors.repo === undefined) {
    selectors = { ...selectors, branch: ["(all)"], repo: ["(all)"] };
  }

  return selectors;
};
