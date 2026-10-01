import { OMP_HOOK_EVENTS } from "./hook.js";

export const OMP_EXTENSION_FILE = "dft-telemetry.ts";

export const OMP_EXTENSION_MARKER = "// @dft-managed-omp-extension";

export const ompExtensionSource = (command: readonly string[]): string =>
  `${OMP_EXTENSION_MARKER}
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";

const DFT_COMMAND: readonly string[] = ${JSON.stringify(command)};
const EVENTS: readonly string[] = ${JSON.stringify(OMP_HOOK_EVENTS)};

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

const subagentOf = (sessionFile: string | null): string | null => {
  if (sessionFile === null || !sessionFile.endsWith(".jsonl")) return null;
  const parent = dirname(sessionFile) + ".jsonl";
  return existsSync(parent) ? basename(sessionFile, ".jsonl") : null;
};

const sessionIdOf = (reference: unknown): string | null => {
  const value = text(reference);
  if (value === null || !value.endsWith(".jsonl")) return value;
  const name = basename(value, ".jsonl");
  const cut = name.indexOf("_");
  return cut === -1 ? name : name.slice(cut + 1);
};

const send = (event: string, payload: Record<string, unknown>): void => {
  const [program, ...args] = DFT_COMMAND;
  if (program === undefined) return;
  try {
    const child = spawn(program, [...args, "hook", "omp", event], {
      detached: true,
      env: process.env,
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.on("error", () => undefined);
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(JSON.stringify(payload));
    child.unref();
  } catch {
    return;
  }
};

export default function dftTelemetry(pi: any): void {
  for (const event of EVENTS) {
    pi.on(event, (_event: unknown, ctx: any) => {
      try {
        const manager = ctx?.sessionManager;
        const sessionFile = text(manager?.getSessionFile?.());
        const header = manager?.getHeader?.();
        const model = ctx?.model;
        const agentId = subagentOf(sessionFile);
        const parentFile = agentId === null || sessionFile === null ? null : dirname(sessionFile) + ".jsonl";
        send(event, {
          agent_id: agentId,
          cwd: text(ctx?.cwd),
          hook_event_name: event,
          model: model ? [text(model.provider), text(model.id)].filter(Boolean).join("/") : null,
          parent_session_id: sessionIdOf(header?.parentSession) ?? sessionIdOf(parentFile),
          reasoning_effort: text(pi.getThinkingLevel?.()),
          session_id: text(manager?.getSessionId?.()),
          transcript_path: sessionFile,
          turn_id: text(manager?.getLeafId?.()),
        });
      } catch {
        return;
      }
    });
  }
}
`;

export const OMP_EXTENSION_SOURCE = ompExtensionSource(["dft"]);
