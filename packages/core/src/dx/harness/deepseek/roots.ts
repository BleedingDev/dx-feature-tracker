const PERSISTENCE_PLUGIN = "session-persistence-jsonl";

const ENTRY_START = /^\s*-\s/u;

const ROOT_LINE = /^\s*root:\s*(?<value>.+?)\s*$/u;

const HOME_PATH = /^!!js\s+dshHomePath\(\s*['"](?<child>[^'"]+)['"]\s*\)$/u;

const unquote = (value: string): string =>
  value.replace(/^(?<quote>['"])(?<inner>.*)\k<quote>$/u, "$<inner>");

export interface RootContext {
  readonly dshHome: string;
  readonly home: string;
  readonly join: (...parts: readonly string[]) => string;
}

const resolveRoot = (raw: string, context: RootContext): string | null => {
  const home = HOME_PATH.exec(raw)?.groups?.child;

  if (home !== undefined) {
    return context.join(context.dshHome, home);
  }

  if (raw.startsWith("!!")) {
    return null;
  }

  const value = unquote(raw);

  if (value === "~" || value.startsWith("~/")) {
    return context.join(context.home, value.slice(1));
  }

  return value.startsWith("/") ? value : null;
};

export const persistenceRootsIn = (
  yaml: string,
  context: RootContext
): readonly string[] => {
  const roots: string[] = [];
  let inPlugin = false;

  for (const line of yaml.split(/\r?\n/u)) {
    if (ENTRY_START.test(line)) {
      inPlugin = line.includes(PERSISTENCE_PLUGIN);
    } else if (line.includes(PERSISTENCE_PLUGIN)) {
      inPlugin = true;
    }

    const raw = ROOT_LINE.exec(line)?.groups?.value;

    if (inPlugin && raw !== undefined) {
      const root = resolveRoot(raw, context);

      if (root !== null) {
        roots.push(root);
      }
    }
  }

  return roots;
};
