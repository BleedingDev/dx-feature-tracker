// @effect-diagnostics-next-line nodeBuiltinImport:off -- The Cursor hook entrypoint reads its JSON payload from stdin (fd 0) synchronously, with no Effect runtime work before responding.
import { readFileSync } from "node:fs";

import { toCommand } from "@rat-stack/capability";
import { capabilities, formatFileStats, inspectFile } from "@rat-stack/core";
import { runCursorHook } from "@rat-stack/core/dx";
import { Console, DateTime, Effect, Layer } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import {
  SERVE_HOST,
  DEVTOOLS_MCP_PATH,
  codeMode,
  devtoolsWebServer,
  dxCapabilities,
  dxStoreLive,
  http,
  mcpServer,
  webServer,
} from "./surfaces.js";
import { VERSION } from "./version.js";

export { VERSION } from "./version.js";

const capabilityCommands = capabilities.map((capability) => {
  const command =
    capability === inspectFile
      ? toCommand(capability, {
          positional: ["path"],
          render: formatFileStats,
        }).pipe(Command.withAlias("stats"))
      : toCommand(capability);

  return command;
});

const openapiCommand = Command.make("openapi", {}, () =>
  Console.log(JSON.stringify(http.openApi(), null, 2))
).pipe(Command.withDescription("Print the OpenAPI document for the REST API"));

const devtoolsFlag = Flag.Boolean("devtools").pipe(
  Flag.withDefault(false),
  Flag.withDescription(
    "Record every capability call and add the rat_* devtools tools"
  )
);

const serveCommand = Command.make(
  "serve",
  {
    devtools: devtoolsFlag,
    port: Flag.Int("port").pipe(
      Flag.withDefault(3000),
      Flag.withDescription("TCP port to listen on")
    ),
  },
  ({ devtools, port }) =>
    devtools
      ? Console.error(
          `🐀 devtools MCP: http://${SERVE_HOST}:${port}${DEVTOOLS_MCP_PATH}`
        ).pipe(
          Effect.andThen(Layer.launch(devtoolsWebServer(port))),
          Effect.orDie
        )
      : Layer.launch(webServer(port))
).pipe(
  Command.withDescription(
    "Serve the REST API, /openapi.json, and /docs until interrupted; --devtools adds MCP at /__rat/mcp on 127.0.0.1"
  )
);

const mcpCommand = Command.make(
  "mcp",
  {
    codeMode: Flag.Boolean("code-mode").pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        "Expose search and execute instead of one tool per capability"
      )
    ),
    devtools: devtoolsFlag,
  },
  ({ codeMode: enabled, devtools }) => {
    if (devtools) {
      return enabled
        ? Layer.launch(mcpServer.devtoolsCodeMode).pipe(Effect.orDie)
        : Layer.launch(mcpServer.devtools).pipe(Effect.orDie);
    }

    return enabled
      ? Layer.launch(mcpServer.codeMode).pipe(Effect.orDie)
      : Layer.launch(mcpServer.tools).pipe(Effect.orDie);
  }
).pipe(
  Command.withDescription("Serve the capabilities as an MCP server over stdio")
);

const catalogCommand = Command.make(
  "catalog",
  {
    types: Flag.Boolean("types").pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        "Print the TypeScript declarations a code-mode program sees"
      )
    ),
  },
  ({ types }) =>
    Console.log(
      types ? codeMode.declarations : JSON.stringify(codeMode.catalog, null, 2)
    )
).pipe(
  Command.withDescription(
    "Print the capability catalog as JSON Schema, or as TypeScript with --types"
  )
);

const dxCommandNames = {
  dx_analyze: "analyze",
  dx_chats: "chats",
  dx_collect: "collect",
  dx_evidence: "evidence",
  dx_explain: "explain",
  dx_history: "history",
  dx_mark: "mark",
  dx_status: "status",
} as const;

const dxCapabilityCommands = dxCapabilities.map((capability) =>
  toCommand(capability, {
    name: dxCommandNames[capability.contract.name],
  }).pipe(Command.provide(dxStoreLive))
);

const readStdin = (): string => {
  try {
    return readFileSync(0, "utf-8");
  } catch {
    return "";
  }
};

const dxHookCommand = Command.make("hook", {}, () =>
  DateTime.now.pipe(
    Effect.map((now) =>
      runCursorHook(readStdin(), process.cwd(), DateTime.toDate(now))
    ),
    Effect.flatMap((result) => Console.log(result.stdout))
  )
).pipe(
  Command.withDescription(
    "Cursor project hook entrypoint: read one hook JSON payload on stdin, spool sanitized metadata locally, print the hook response"
  )
);

const dxCommand = Command.make("dx").pipe(
  Command.withDescription(
    "dx-feature-tracker: record and analyze local AI engineering cost per Git branch"
  ),
  Command.withSubcommands([...dxCapabilityCommands, dxHookCommand])
);

export const rootCommand = Command.make("rat-stack").pipe(
  Command.withDescription("Agent-first file inspection: CLI, REST, and MCP"),
  Command.withSubcommands([
    ...capabilityCommands,
    catalogCommand,
    openapiCommand,
    serveCommand,
    mcpCommand,
    dxCommand,
  ])
);

export const runCommand = Command.runWith(rootCommand, { version: VERSION });
