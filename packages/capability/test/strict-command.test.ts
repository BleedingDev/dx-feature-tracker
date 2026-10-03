import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Ref, Schema } from "effect";
import { TestConsole } from "effect/testing";
import { CliError, CliOutput, Command } from "effect/unstable/cli";

import { defineContract, implement, toCommand } from "../src/index.js";

const inputSchema = Schema.Struct({
  action: Schema.Struct({
    kind: Schema.Literal("start"),
    parameters: Schema.Struct({ label: Schema.String }),
  }),
  scope: Schema.Struct({
    session: Schema.Struct({ id: Schema.String }),
  }),
});

const operationContract = defineContract("operation", {
  description: "Start an operation in a session",
  failure: Schema.Never,
  input: inputSchema,
  output: inputSchema,
});

const validInput = {
  action: { kind: "start", parameters: { label: "verify" } },
  scope: { session: { id: "session-a" } },
};

const TestLayer = Layer.mergeAll(
  TestConsole.layer,
  CliOutput.layer(CliOutput.defaultFormatter({ colors: false }))
).pipe(Layer.provideMerge(NodeServices.layer));

describe("toCommand strict input", () => {
  it.layer(TestLayer)("command parsing", (test) => {
    test.effect("accepts valid JSON flags before invoking the handler", () =>
      Effect.gen(function* acceptsValidInput() {
        const received = yield* Ref.make<typeof inputSchema.Type | null>(null);

        const operation = implement(operationContract, (input) =>
          Ref.set(received, input).pipe(Effect.as(input))
        );

        yield* Command.runWith(toCommand(operation, { strictInput: true }), {
          version: "0.0.0",
        })([
          "--action",
          JSON.stringify(validInput.action),
          "--scope",
          JSON.stringify(validInput.scope),
        ]);

        expect(yield* Ref.get(received)).toEqual(validInput);
      })
    );

    test.effect(
      "rejects root and nested excess fields before the handler",
      () =>
        Effect.gen(function* rejectsExcessInput() {
          const called = yield* Ref.make(false);

          const operation = implement(operationContract, (input) =>
            Ref.set(called, true).pipe(Effect.as(input))
          );

          const run = Command.runWith(
            toCommand(operation, { strictInput: true }),
            { version: "0.0.0" }
          );

          const invalidInputs = [
            {
              ...validInput,
              scope: { ...validInput.scope, unexpected: true },
            },
            {
              ...validInput,
              scope: { session: { id: "session-a", unexpected: true } },
            },
            {
              ...validInput,
              action: {
                kind: "start",
                parameters: { label: "verify", unexpected: true },
              },
            },
          ];

          for (const input of invalidInputs) {
            const error = yield* run([
              "--action",
              JSON.stringify(input.action),
              "--scope",
              JSON.stringify(input.scope),
            ]).pipe(Effect.flip);

            expect(error).toBeInstanceOf(CliError.ShowHelp);

            const errors = Schema.is(CliError.ShowHelp)(error)
              ? error.errors
              : [];

            expect(errors).toHaveLength(1);
            expect(errors[0]).toBeInstanceOf(CliError.InvalidValue);
            expect(errors[0]).toHaveProperty(
              "expected",
              expect.stringContaining("Expected no excess property")
            );
            expect(yield* Ref.get(called)).toBe(false);
          }
        })
    );

    test.effect("keeps default JSON input compatible", () =>
      Effect.gen(function* acceptsLegacyInput() {
        const received = yield* Ref.make<typeof inputSchema.Type | null>(null);

        const operation = implement(operationContract, (input) =>
          Ref.set(received, input).pipe(Effect.as(input))
        );

        yield* Command.runWith(toCommand(operation), { version: "0.0.0" })([
          "--action",
          JSON.stringify({
            kind: "start",
            parameters: { label: "verify", unexpected: true },
          }),
          "--scope",
          JSON.stringify({
            session: { id: "session-a", unexpected: true },
            unexpected: true,
          }),
        ]);

        expect(yield* Ref.get(received)).toEqual(validInput);
      })
    );

    test.effect("validates JSON positional arguments before the handler", () =>
      Effect.gen(function* validatesPositionalInput() {
        const called = yield* Ref.make(false);

        const operation = implement(operationContract, (input) =>
          Ref.set(called, true).pipe(Effect.as(input))
        );

        const run = Command.runWith(
          toCommand(operation, {
            positional: ["action", "scope"],
            strictInput: true,
          }),
          { version: "0.0.0" }
        );

        const error = yield* run([
          JSON.stringify(validInput.action),
          JSON.stringify({ session: { id: "session-a", unexpected: true } }),
        ]).pipe(Effect.flip);

        expect(error).toBeInstanceOf(CliError.ShowHelp);
        expect(yield* Ref.get(called)).toBe(false);

        yield* run([
          JSON.stringify(validInput.action),
          JSON.stringify(validInput.scope),
        ]);

        expect(yield* Ref.get(called)).toBe(true);
      })
    );
  });
});
