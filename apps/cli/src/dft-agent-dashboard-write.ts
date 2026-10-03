import { Buffer } from "node:buffer";

import { InvalidInput } from "@rat-stack/core/dx";
import { Effect, Schema } from "effect";

import type { capabilityAt } from "./dft-session.js";

const MAX_INPUT_BYTES = 65_536;

const decodeDashboardWriteInput = <
  S extends Schema.Constraint & { readonly DecodingServices: never },
>(
  schema: S,
  inputJson: string,
  capability: string
): Effect.Effect<S["Type"], InvalidInput> =>
  Schema.decodeEffect(Schema.fromJsonString(schema), {
    onExcessProperty: "error",
  })(inputJson).pipe(
    Effect.mapError(
      () =>
        new InvalidInput({
          field: "input",
          message: `Invalid input for ${capability}. Supply its explicit request wrapper.`,
        })
    )
  );

export const writeAgentDashboardCapability = Effect.fn(
  "writeAgentDashboardCapability"
)(function* dashboardWrite(
  caps: ReturnType<typeof capabilityAt>,
  capability: string,
  inputJson: string
) {
  if (Buffer.byteLength(inputJson, "utf-8") > MAX_INPUT_BYTES) {
    return yield* new InvalidInput({
      field: "input",
      message: "Dashboard agent capability input exceeds 64 KiB.",
    });
  }

  switch (capability) {
    case "dx_operation": {
      const input = yield* decodeDashboardWriteInput(
        caps.operation.contract.input,
        inputJson,
        capability
      );

      return yield* caps.operation.handler(input);
    }

    case "dx_learning": {
      const input = yield* decodeDashboardWriteInput(
        caps.learning.contract.input,
        inputJson,
        capability
      );

      return yield* caps.learning.handler(input);
    }

    default: {
      return yield* new InvalidInput({
        field: "capability",
        message: `Unsupported dashboard agent write capability: ${capability}.`,
      });
    }
  }
});
