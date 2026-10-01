export const PI_EXTENSION_FILE_NAME = "dft-observer.ts";

export const PI_EXTENSION_MARKER = "dft-observer:v1";

const EXTENSION_BODY = `
const send = (event, payload) => {
  try {
    const [bin, ...args] = DFT_COMMAND;
    const child = spawn(bin, [...args, "hook", "pi", event], {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.on("error", () => undefined);
    child.stdin.on("error", () => undefined);
    child.stdin.end(JSON.stringify({ ...payload, hook_event_name: event }));
    child.unref();
  } catch {
    return undefined;
  }
};

const parentIdOf = (file) => {
  if (typeof file !== "string" || file === "") {
    return null;
  }
  const name = file.split(/[\\\\/]/u).pop() ?? "";
  const stem = name.replace(/\\.jsonl$/u, "");
  const cut = stem.indexOf("_");
  return cut === -1 ? stem : stem.slice(cut + 1);
};

const sessionFields = (ctx) => {
  const manager = ctx.sessionManager;
  const header = manager.getHeader?.() ?? null;
  return {
    cwd: ctx.cwd,
    parent_session_id: parentIdOf(header?.parentSession),
    session_id: manager.getSessionId(),
    transcript_path: manager.getSessionFile() ?? null,
  };
};

const selectedModel = (ctx) =>
  ctx.model ? \`\${ctx.model.provider}/\${ctx.model.id}\` : null;

export default function dftObserver(pi) {
  pi.on("session_start", (event, ctx) => {
    send("session_start", {
      ...sessionFields(ctx),
      effort: ctx.thinkingLevel ?? null,
      model: selectedModel(ctx),
      reason: event.reason,
    });
  });

  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (message?.role !== "assistant") {
      return;
    }
    send("message_end", {
      ...sessionFields(ctx),
      effort: message.thinkingLevel ?? ctx.thinkingLevel ?? null,
      model: \`\${message.provider}/\${message.responseModel ?? message.model}\`,
      turn_id: message.responseId ?? String(message.timestamp),
    });
  });

  pi.on("turn_end", (event, ctx) => {
    send("turn_end", {
      ...sessionFields(ctx),
      effort: ctx.thinkingLevel ?? null,
      model: selectedModel(ctx),
      turn_id: event.messageEntryId ?? null,
    });
  });
}
`;

export const piExtensionSource = (command: readonly string[]): string =>
  [
    `// ${PI_EXTENSION_MARKER} -- written by dft install; dft uninstall removes it`,
    `import { spawn } from "node:child_process";`,
    "",
    `const DFT_COMMAND = ${JSON.stringify(command)};`,
    EXTENSION_BODY,
  ].join("\n");
