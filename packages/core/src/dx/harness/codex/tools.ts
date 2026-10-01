import { Option, Schema } from "effect";

const Text = Schema.optional(Schema.NullOr(Schema.String));

export const ToolTouchSchema = Schema.Struct({
  command: Schema.optionalKey(Schema.NullOr(Schema.String)),
  paths: Schema.optionalKey(Schema.Array(Schema.String)),
  workdir: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

export type ToolTouch = typeof ToolTouchSchema.Type;

const CommandField = Schema.optional(
  Schema.NullOr(Schema.Union([Schema.String, Schema.Array(Schema.String)]))
);

type Command = string | readonly string[] | null | undefined;

const ToolCallLineSchema = Schema.fromJsonString(
  Schema.Struct({
    payload: Schema.Struct({
      action: Schema.optional(
        Schema.NullOr(
          Schema.Struct({ command: CommandField, working_directory: Text })
        )
      ),
      arguments: Text,
      input: Text,
      name: Text,
      type: Schema.String,
    }),
  })
);

const decodeToolCallLine = Schema.decodeUnknownOption(ToolCallLineSchema);

const ArgumentsSchema = Schema.fromJsonString(
  Schema.Struct({
    cmd: CommandField,
    command: CommandField,
    cwd: Text,
    filePath: Text,
    file_path: Text,
    input: Text,
    path: Text,
    workdir: Text,
  })
);

const decodeArguments = Schema.decodeUnknownOption(ArgumentsSchema);

const isText = Schema.is(Schema.String);

const SHELL_FLAGS: ReadonlySet<string> = new Set(["-c", "-lc", "-ic"]);

export const commandOf = (value: Command): string | null => {
  if (value === null || value === undefined) {
    return null;
  }

  if (isText(value)) {
    return value;
  }

  const flag = value.findIndex((part) => SHELL_FLAGS.has(part));
  const script = flag === -1 ? undefined : value[flag + 1];

  return script ?? value.join(" ");
};

const textValue = (value: string | null | undefined): string | null =>
  value === null || value === undefined || value.trim() === "" ? null : value;

const PATCH_TARGET =
  /^\*\*\* (?:Update File|Add File|Delete File|Move to): (?<path>.+)$/gmu;

export const patchPaths = (patch: string): readonly string[] =>
  [...patch.matchAll(PATCH_TARGET)].flatMap((match) => {
    const target = match.groups?.path?.trim() ?? "";

    return target === "" ? [] : [target];
  });

const decodeJsonText = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.String)
);

const JS_STRING =
  /\b(?<key>workdir|cmd|command|cwd)\s*:\s*(?:"(?<double>(?:[^"\\\n]|\\.)*)"|'(?<single>(?:[^'\\\n]|\\.)*)'|`(?<template>[^`$]*)`)/gu;

const jsString = (match: RegExpMatchArray): string | null => {
  const { double, single, template } = match.groups ?? {};

  if (double !== undefined) {
    return Option.getOrNull(decodeJsonText(`"${double}"`));
  }

  return single?.replaceAll("\\'", "'") ?? template ?? null;
};

export const scriptTouches = (script: string): readonly ToolTouch[] =>
  [...script.matchAll(JS_STRING)].flatMap((match): ToolTouch[] => {
    const value = jsString(match);

    if (value === null) {
      return [];
    }

    return match.groups?.key === "workdir" || match.groups?.key === "cwd"
      ? [{ workdir: value }]
      : [{ command: value }];
  });

const argumentTouches = (
  name: string | null,
  text: string
): readonly ToolTouch[] =>
  Option.match(decodeArguments(text), {
    onNone: () => [],
    onSome: (args): ToolTouch[] => {
      const input = textValue(args.input);

      const paths = [args.path, args.file_path, args.filePath].flatMap(
        (value) => {
          const path = textValue(value);

          return path === null ? [] : [path];
        }
      );

      return [
        {
          command: commandOf(args.cmd) ?? commandOf(args.command),
          paths:
            name === "apply_patch" && input !== null
              ? [...paths, ...patchPaths(input)]
              : paths,
          workdir: textValue(args.workdir) ?? textValue(args.cwd),
        },
      ];
    },
  });

export interface ToolCallFacts {
  readonly touches: readonly ToolTouch[];
  readonly webSearch: boolean;
}

export const toolCallFacts = (text: string): ToolCallFacts =>
  Option.match(decodeToolCallLine(text), {
    onNone: () => ({ touches: [], webSearch: false }),
    onSome: ({ payload }): ToolCallFacts => {
      const name = payload.name ?? null;

      if (payload.type === "web_search_call") {
        return { touches: [], webSearch: true };
      }

      if (payload.type === "local_shell_call") {
        return {
          touches: [
            {
              command: commandOf(payload.action?.command),
              workdir: payload.action?.working_directory ?? null,
            },
          ],
          webSearch: false,
        };
      }

      if (payload.type === "custom_tool_call") {
        const input = payload.input ?? "";

        return {
          touches:
            name === "apply_patch"
              ? [{ paths: patchPaths(input) }]
              : scriptTouches(input),
          webSearch: false,
        };
      }

      return {
        touches: argumentTouches(name, payload.arguments ?? ""),
        webSearch: false,
      };
    },
  });
