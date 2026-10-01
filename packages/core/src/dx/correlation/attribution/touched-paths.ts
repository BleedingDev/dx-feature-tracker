import { normalizePath } from "../repo/path.js";

export interface ToolCallTouch {
  readonly command?: string | null;
  readonly paths?: readonly (string | null | undefined)[];
  readonly workdir?: string | null;
}

export interface TouchedPathsInput {
  readonly calls: readonly ToolCallTouch[];
  readonly cwd: string | null;
  readonly home?: string | null;
}

const SEPARATORS = /&&|\|\||[;|\n]/u;

const DIRECTORY_COMMANDS: ReadonlySet<string> = new Set(["cd", "pushd"]);

const tokenize = (segment: string): readonly string[] => {
  const tokens: string[] = [];
  let current = "";
  let quote: string | null = null;
  let started = false;

  for (const char of segment) {
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/u.test(char)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
    } else {
      current += char;
      started = true;
    }
  }

  return started ? [...tokens, current] : tokens;
};

const resolveFrom = (
  base: string | null,
  target: string,
  home: string | null
): string | null => {
  const trimmed = target.trim();

  if (trimmed === "" || trimmed === "-") {
    return null;
  }

  if (trimmed === "~" || trimmed.startsWith("~/")) {
    return home === null ? null : normalizePath(`${home}/${trimmed.slice(1)}`);
  }

  const absolute = normalizePath(trimmed);

  if (absolute !== null) {
    return absolute;
  }

  return base === null ? null : normalizePath(`${base}/${trimmed}`);
};

const gitDirectoryArg = (tokens: readonly string[]): string | null => {
  const at = tokens.indexOf("-C");

  return tokens[0] === "git" && at > 0 ? (tokens[at + 1] ?? null) : null;
};

const commandPaths = (
  command: string,
  start: string | null,
  home: string | null
): readonly string[] => {
  const found: string[] = [];
  let here = start;

  for (const segment of command.split(SEPARATORS)) {
    const tokens = tokenize(segment);
    const [head = "", target = null] = tokens;

    if (DIRECTORY_COMMANDS.has(head) && target !== null) {
      const next = resolveFrom(here, target, home);

      if (next !== null) {
        found.push(next);
        here = next;
      }
    }

    const gitDir = gitDirectoryArg(tokens);
    const gitPath = gitDir === null ? null : resolveFrom(here, gitDir, home);

    if (gitPath !== null) {
      found.push(gitPath);
    }
  }

  return found;
};

export const touchedPaths = (input: TouchedPathsInput): readonly string[] => {
  const home = input.home ?? null;
  const found: string[] = [];

  for (const call of input.calls) {
    const workdir =
      call.workdir === null || call.workdir === undefined
        ? null
        : resolveFrom(input.cwd, call.workdir, home);

    const base = workdir ?? input.cwd;

    if (workdir !== null) {
      found.push(workdir);
    }

    for (const path of call.paths ?? []) {
      const resolved =
        path === null || path === undefined
          ? null
          : resolveFrom(base, path, home);

      if (resolved !== null) {
        found.push(resolved);
      }
    }

    if (call.command !== null && call.command !== undefined) {
      found.push(...commandPaths(call.command, base, home));
    }
  }

  return [...new Set(found)];
};
