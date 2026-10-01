export const OPENCODE_PLUGIN_FILE = "dft-usage.js" as const;

export const OPENCODE_PLUGIN_EVENTS = [
  "session.created",
  "session.updated",
  "session.idle",
  "session.status",
  "message.updated",
  "session.step.ended",
  "session.step.failed",
  "session.model.selected",
  "session.agent.selected",
  "session.execution.started",
] as const;

export const opencodePluginSource = (
  dftCommand: readonly string[] = ["dft"]
): string =>
  [
    `import { spawn } from "node:child_process";`,
    `const [DFT, ...DFT_ARGS] = ${JSON.stringify(dftCommand.length === 0 ? ["dft"] : dftCommand)};`,
    `const EVENTS = new Set(${JSON.stringify(OPENCODE_PLUGIN_EVENTS)});`,
    `const send = (event) => {`,
    `  try {`,
    `    const child = spawn(DFT, [...DFT_ARGS, "hook", "opencode", event.type], { stdio: ["pipe", "ignore", "ignore"], detached: true });`,
    `    child.on("error", () => {});`,
    `    child.stdin.end(JSON.stringify({ type: event.type, properties: event.properties ?? event.data ?? {} }));`,
    `    child.unref();`,
    `  } catch {}`,
    `};`,
    `export const DftUsage = async () => ({`,
    `  event: async ({ event }) => {`,
    `    if (!event || !EVENTS.has(event.type)) return;`,
    `    const info = (event.properties ?? event.data ?? {}).info;`,
    `    if (event.type === "message.updated" && (!info || info.role !== "user")) return;`,
    `    send(event);`,
    `  },`,
    `});`,
    `export default DftUsage;`,
    "",
  ].join("\n");
