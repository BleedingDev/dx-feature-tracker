import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { McpServer } from "effect/unstable/ai";

import { defineContract, implement, toToolkit } from "../src/index.js";
import { noArgs } from "./fixtures.js";
import { makeMcpClient, serverLayer } from "./mcp-harness.js";

const scopeSchema = Schema.Struct({ sessionId: Schema.String });

const scopeContract = defineContract("scope", {
  description: "Return the requested session scope",
  failure: Schema.Never,
  input: Schema.Struct({ scope: scopeSchema }),
  output: scopeSchema,
});

const scope = implement(scopeContract, (input) => Effect.succeed(input.scope));

const strictProjection = toToolkit([scope, noArgs], { strictInput: true });

const strictAppLayer = McpServer.toolkit(strictProjection.toolkit).pipe(
  Layer.provideMerge(strictProjection.layer),
  Layer.provide(serverLayer)
);

const defaultProjection = toToolkit([scope]);

const defaultAppLayer = McpServer.toolkit(defaultProjection.toolkit).pipe(
  Layer.provideMerge(defaultProjection.layer),
  Layer.provide(serverLayer)
);

describe("toToolkit strict input", () => {
  it.effect("accepts valid nested input and advertises closed objects", () =>
    Effect.gen(function* acceptsValidInput() {
      const client = yield* makeMcpClient(strictAppLayer);
      const { tools } = yield* client["tools/list"]({});
      const tool = tools.find((item) => item.name === "scope");

      expect(tool?.inputSchema).toMatchObject({
        additionalProperties: false,
        properties: {
          scope: {
            additionalProperties: false,
            properties: { sessionId: { type: "string" } },
          },
        },
      });

      const result = yield* client["tools/call"]({
        arguments: { scope: { sessionId: "session-a" } },
        name: "scope",
      });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({ sessionId: "session-a" });
    })
  );

  it.effect("rejects excess properties at the root and in nested input", () =>
    Effect.gen(function* rejectsExcessInput() {
      const client = yield* makeMcpClient(strictAppLayer);

      const invalidInputs = [
        { scope: { sessionId: "session-a" }, unexpected: true },
        { scope: { sessionId: "session-a", unexpected: true } },
      ];

      for (const input of invalidInputs) {
        const error = yield* client["tools/call"]({
          arguments: input,
          name: "scope",
        }).pipe(Effect.flip);

        expect(error).toMatchObject({ code: -32_602 });
        expect(error).toHaveProperty(
          "message",
          expect.stringContaining("Expected no excess property")
        );
        expect(error).toHaveProperty(
          "message",
          expect.stringContaining("unexpected")
        );
      }
    })
  );

  it.effect("preserves default acceptance of excess input", () =>
    Effect.gen(function* acceptsDefaultInput() {
      const client = yield* makeMcpClient(defaultAppLayer);

      const result = yield* client["tools/call"]({
        arguments: {
          scope: { sessionId: "session-a", unexpected: true },
          unexpected: true,
        },
        name: "scope",
      });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({ sessionId: "session-a" });
    })
  );

  it.effect(
    "keeps empty dynamic tools callable with strict input enabled",
    () =>
      Effect.gen(function* acceptsEmptyInput() {
        const client = yield* makeMcpClient(strictAppLayer);
        const { tools } = yield* client["tools/list"]({});
        const tool = tools.find((item) => item.name === "noArgs");

        expect(tool?.inputSchema).toEqual({
          additionalProperties: false,
          properties: {},
          type: "object",
        });

        const empty = yield* client["tools/call"]({ name: "noArgs" });

        const excess = yield* client["tools/call"]({
          arguments: { unexpected: true },
          name: "noArgs",
        });

        expect(empty.isError).toBeFalsy();
        expect(excess.isError).toBeFalsy();
        expect(empty.content).toEqual(excess.content);
      })
  );
});
