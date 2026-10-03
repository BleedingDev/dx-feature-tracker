import { Buffer } from "node:buffer";

import { InvalidInput } from "@rat-stack/core/dx";
import { Effect, Schema } from "effect";

import type { capabilityAt } from "./dft-session.js";

const MAX_INPUT_BYTES = 65_536;

const decodeAgentDashboardInput = <
  S extends Schema.Constraint & {
    readonly Type: { readonly agentQuery?: unknown };
  },
>(
  schema: S,
  inputJson: string,
  capability: string
) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema), {
    onExcessProperty: "error",
  })(inputJson).pipe(
    Effect.mapError(
      () =>
        new InvalidInput({
          field: "input",
          message: `Invalid input for ${capability}.`,
        })
    ),
    Effect.flatMap((input) =>
      input.agentQuery === undefined
        ? Effect.fail(
            new InvalidInput({
              field: "agentQuery",
              message:
                "Dashboard agent queries require an explicit dx.agent.v1 profile.",
            })
          )
        : Effect.succeed(input)
    )
  );

export const readAgentDashboardQuery = Effect.fn("readAgentDashboardQuery")(
  function* dashboardQuery(
    caps: ReturnType<typeof capabilityAt>,
    capability: string,
    inputJson: string
  ) {
    if (Buffer.byteLength(inputJson, "utf-8") > MAX_INPUT_BYTES) {
      return yield* new InvalidInput({
        field: "input",
        message: "Dashboard agent query input exceeds 64 KiB.",
      });
    }

    switch (capability) {
      case "dx_status": {
        const input = yield* decodeAgentDashboardInput(
          caps.status.contract.input,
          inputJson,
          capability
        );

        return yield* caps.status.handler(input);
      }

      case "dx_analyze": {
        const input = yield* decodeAgentDashboardInput(
          caps.analyze.contract.input,
          inputJson,
          capability
        );

        return yield* caps.analyze.handler(input);
      }

      case "dx_usage": {
        const input = yield* decodeAgentDashboardInput(
          caps.usage.contract.input,
          inputJson,
          capability
        );

        return yield* caps.usage.handler(input);
      }

      case "dx_explain": {
        const input = yield* decodeAgentDashboardInput(
          caps.explain.contract.input,
          inputJson,
          capability
        );

        return yield* caps.explain.handler(input);
      }

      case "dx_evidence": {
        const input = yield* decodeAgentDashboardInput(
          caps.evidence.contract.input,
          inputJson,
          capability
        );

        return yield* caps.evidence.handler(input);
      }

      default: {
        return yield* new InvalidInput({
          field: "capability",
          message: `Unsupported dashboard agent query capability: ${capability}.`,
        });
      }
    }
  }
);
