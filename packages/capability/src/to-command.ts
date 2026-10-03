import { Console, Effect, Option, Predicate, Schema, SchemaAST } from "effect";
import { Argument, CliError, Command, Flag } from "effect/unstable/cli";

import { Approval } from "./approval.js";
import type {
  AnyCapability,
  FailureOf,
  InputOf,
  OutputOf,
  PlainSchema,
  RequirementsOf as CapabilityRequirementsOf,
} from "./contract.js";

export interface ToCommandOptions<Output> {
  readonly name?: string | undefined;
  readonly positional?: readonly string[] | undefined;
  readonly render?: ((output: Output) => string) | undefined;
  readonly strictInput?: boolean | undefined;
}

interface FieldSpec {
  readonly description: string | undefined;
  readonly kind: "string" | "number" | "boolean" | "literals" | "json";
  readonly literals: readonly string[];
  readonly optional: boolean;
}

const literalOf = (ast: SchemaAST.AST): string | undefined =>
  SchemaAST.isLiteral(ast) && Predicate.isString(ast.literal)
    ? ast.literal
    : undefined;

const primitiveKinds: Partial<
  Record<SchemaAST.AST["_tag"], FieldSpec["kind"]>
> = {
  Boolean: "boolean",
  Number: "number",
  String: "string",
};

const primitiveKind = (ast: SchemaAST.AST): FieldSpec["kind"] =>
  primitiveKinds[ast._tag] ?? "json";

const describe = (field: PlainSchema): FieldSpec => {
  let ast: SchemaAST.AST = field.ast;
  let optional = ast.context?.isOptional === true;

  const description = SchemaAST.resolveDescription(ast);

  if (SchemaAST.isUnion(ast)) {
    const members = ast.types.filter(
      (member) => !SchemaAST.isUndefined(member)
    );

    if (members.length < ast.types.length) {
      optional = true;
    }

    const [only] = members;

    if (members.length === 1 && only !== undefined) {
      ast = only;
    } else {
      const literals = members.map(literalOf);

      if (literals.every((literal) => literal !== undefined)) {
        return { description, kind: "literals", literals, optional };
      }

      return { description, kind: "json", literals: [], optional };
    }
  }

  const literal = literalOf(ast);

  if (literal !== undefined) {
    return { description, kind: "literals", literals: [literal], optional };
  }

  const kind = primitiveKind(ast);

  return { description, kind, literals: [], optional };
};

const decodeJsonInput = (
  name: string,
  field: PlainSchema,
  kind: "argument" | "flag",
  parseOptions?: SchemaAST.ParseOptions
) => {
  const decode = Schema.decodeUnknownEffect(
    Schema.fromJsonString(field),
    parseOptions
  );

  return (value: string) =>
    decode(value).pipe(
      Effect.mapError(
        (cause) =>
          new CliError.InvalidValue({
            expected: `Schema validation failed: ${cause.message}`,
            kind,
            option: name,
            value,
          })
      )
    );
};

const jsonFlag = (
  name: string,
  field: PlainSchema,
  parseOptions?: SchemaAST.ParseOptions
) =>
  Flag.String(name).pipe(
    Flag.mapEffect(decodeJsonInput(name, field, "flag", parseOptions)),
    Flag.withMetavar("JSON")
  );

const flagBuilders = {
  boolean: (name) => Flag.Boolean(name).pipe(Flag.withDefault(false)),
  json: (name, field, _spec, parseOptions) =>
    jsonFlag(name, field, parseOptions),
  literals: (name, _field, spec) => Flag.Literals(name, spec.literals),
  number: (name) => Flag.Finite(name),
  string: (name) => Flag.String(name),
} satisfies Record<
  FieldSpec["kind"],
  (
    name: string,
    field: PlainSchema,
    spec: FieldSpec,
    parseOptions?: SchemaAST.ParseOptions
  ) => Flag.Flag<unknown>
>;

const flagFor = (
  name: string,
  field: PlainSchema,
  parseOptions?: SchemaAST.ParseOptions
): Flag.Flag<unknown> => {
  const spec = describe(field);
  const base = flagBuilders[spec.kind](name, field, spec, parseOptions);

  const described =
    spec.description === undefined
      ? base
      : base.pipe(Flag.withDescription(spec.description));

  return spec.optional && spec.kind !== "boolean"
    ? described.pipe(Flag.optional, Flag.map(Option.getOrUndefined))
    : described;
};

const schemaArgument = (
  name: string,
  field: PlainSchema,
  metavar: string,
  parseOptions?: SchemaAST.ParseOptions
) =>
  Argument.String(name).pipe(
    Argument.mapEffect(decodeJsonInput(name, field, "argument", parseOptions)),
    Argument.withMetavar(metavar)
  );

const argumentBuilders = {
  boolean: (name, field, _spec, parseOptions) =>
    schemaArgument(name, field, "BOOLEAN", parseOptions),
  json: (name, field, _spec, parseOptions) =>
    schemaArgument(name, field, "JSON", parseOptions),
  literals: (name, _field, spec) => Argument.Literals(name, spec.literals),
  number: (name) => Argument.Finite(name),
  string: (name) => Argument.String(name),
} satisfies Record<
  FieldSpec["kind"],
  (
    name: string,
    field: PlainSchema,
    spec: FieldSpec,
    parseOptions?: SchemaAST.ParseOptions
  ) => Argument.Argument<unknown>
>;

const argumentFor = (
  name: string,
  field: PlainSchema,
  parseOptions?: SchemaAST.ParseOptions
): Argument.Argument<unknown> => {
  const spec = describe(field);
  const base = argumentBuilders[spec.kind](name, field, spec, parseOptions);

  const described =
    spec.description === undefined
      ? base
      : base.pipe(Argument.withDescription(spec.description));

  return spec.optional
    ? described.pipe(Argument.optional, Argument.map(Option.getOrUndefined))
    : described;
};

const JSON_FLAG = "json";

const APPROVAL_FLAG = "yes";

export const toCommand = <C extends AnyCapability>(
  capability: C,
  options?: ToCommandOptions<OutputOf<C>["Type"]>
) => {
  const { contract } = capability;
  const positional = new Set(options?.positional);
  const render = options?.render;

  const parseOptions: SchemaAST.ParseOptions | undefined =
    options?.strictInput === true ? { onExcessProperty: "error" } : undefined;

  if (render !== undefined && Object.hasOwn(contract.input.fields, JSON_FLAG)) {
    throw new Error(
      "Input field `json` conflicts with the reserved `--json` flag"
    );
  }

  if (
    contract.needsApproval &&
    Object.hasOwn(contract.input.fields, APPROVAL_FLAG)
  ) {
    throw new Error(
      "Input field `yes` conflicts with the reserved `--yes` flag"
    );
  }

  const config: Record<
    string,
    Flag.Flag<unknown> | Argument.Argument<unknown>
  > = {};

  for (const [name, field] of Object.entries(contract.input.fields)) {
    config[name] = positional.has(name)
      ? argumentFor(name, field, parseOptions)
      : flagFor(name, field, parseOptions);
  }

  if (render !== undefined) {
    config[JSON_FLAG] = Flag.Boolean(JSON_FLAG).pipe(
      Flag.withDefault(false),
      Flag.withDescription("Print machine-readable JSON")
    );
  }

  if (contract.needsApproval) {
    config[APPROVAL_FLAG] = Flag.Boolean(APPROVAL_FLAG).pipe(
      Flag.withDefault(false),
      Flag.withDescription("Approve this capability for this invocation")
    );
  }

  const decodeInput = Schema.decodeUnknownEffect(contract.input, parseOptions);
  const encodeOutput = Schema.encodeEffect(contract.output);

  // SAFETY: `C extends Any` widens the handler's channels to `unknown`; the extractors recover the concrete ones from `C`.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const run = capability.handler as (
    input: InputOf<C>["Type"]
  ) => Effect.Effect<
    OutputOf<C>["Type"],
    FailureOf<C>["Type"],
    CapabilityRequirementsOf<C>
  >;

  return Command.make(
    options?.name ?? contract.name,
    config,
    Effect.fn(`Capability.${contract.name}`)(function* runCommand(parsed) {
      const { [APPROVAL_FLAG]: yes, [JSON_FLAG]: json, ...fields } = parsed;

      const provided = Object.fromEntries(
        Object.entries(fields).filter(([, value]) => value !== undefined)
      );

      const input = yield* decodeInput(provided);

      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Decoded through `contract.input`, whose Type `C` makes precise.
      const output = yield* run(input).pipe(
        Effect.provide(yes === true ? Approval.allowAll : Approval.denyAll)
      );

      const text =
        render !== undefined && json !== true
          ? render(output)
          : JSON.stringify(yield* encodeOutput(output), null, 2);

      yield* Console.log(text);
    })
  ).pipe(Command.withDescription(contract.description));
};
