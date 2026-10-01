import type { StoredSession } from "../contract.js";

export const SESSION_EXTENSION = ".jsonl";

export const META_EXTENSION = ".meta.json";

const WORKFLOW_JOURNAL = "journal.jsonl";

const trimSlashes = (dir: string): string => dir.replace(/\/+$/u, "");

export const isSessionFile = (relative: string): boolean => {
  const name = relative.split(/[\\/]/u).at(-1) ?? "";

  return name.endsWith(SESSION_EXTENSION) && name !== WORKFLOW_JOURNAL;
};

export const projectSlug = (dir: string): string =>
  trimSlashes(dir).replaceAll(/[^A-Za-z0-9]/gu, "-");

export const isInside = (path: string | null, dir: string): boolean => {
  if (path === null) {
    return false;
  }

  const child = trimSlashes(path);
  const parent = trimSlashes(dir);

  return child === parent || child.startsWith(`${parent}/`);
};

export const sameFolder = (a: string, b: string): boolean =>
  trimSlashes(a) === trimSlashes(b);

export const isStrictAncestor = (path: string | null, dir: string): boolean => {
  if (path === null) {
    return false;
  }

  const ancestor = trimSlashes(path);

  return ancestor === "" || trimSlashes(dir).startsWith(`${ancestor}/`);
};

export const dirsBetween = (dir: string, path: string): readonly string[] => {
  const base = trimSlashes(dir);
  const rest = trimSlashes(path).slice(base.length + 1);

  if (rest === "") {
    return [];
  }

  const parts = rest.split("/");

  return parts.map((_, index) =>
    [base, ...parts.slice(0, index + 1)].join("/")
  );
};

export const slugMayHold = (slug: string, worktree: string): boolean => {
  const own = projectSlug(worktree);

  return (
    slug === own ||
    slug.startsWith(`${own}-`) ||
    own.startsWith(`${slug}-`) ||
    slug === "-"
  );
};

export const isOwnFolderFamily = (
  familyPath: string,
  worktree: string
): boolean =>
  trimSlashes(familyPath).split("/").at(-2) === projectSlug(worktree);

export interface SessionFamily {
  readonly dir: string;
  readonly files: readonly StoredSession[];
  readonly main: string | null;
  readonly path: string;
  readonly project: string;
  readonly sessionId: string;
}

const stripExtension = (name: string): string =>
  name.slice(0, -SESSION_EXTENSION.length);

interface Placement {
  readonly familyDir: string;
  readonly isMain: boolean;
  readonly project: string;
  readonly sessionId: string;
}

const placementOf = (root: string, file: string): Placement | null => {
  const base = trimSlashes(root);

  if (!file.startsWith(`${base}/`)) {
    return null;
  }

  const parts = file.slice(base.length + 1).split("/");
  const [project, second] = parts;

  if (project === undefined || second === undefined) {
    return null;
  }

  if (parts.length === 2) {
    const sessionId = stripExtension(second);

    return {
      familyDir: `${base}/${project}/${sessionId}`,
      isMain: true,
      project,
      sessionId,
    };
  }

  return {
    familyDir: `${base}/${project}/${second}`,
    isMain: false,
    project,
    sessionId: second,
  };
};

const orderOf = (path: string, main: string | null): string =>
  path === main ? `0${path}` : `1${path}`;

interface FamilyDraft {
  readonly files: StoredSession[];
  main: string | null;
  readonly placement: Placement;
}

export const groupFamilies = (
  roots: readonly string[],
  sessions: readonly StoredSession[]
): readonly SessionFamily[] => {
  const drafts = new Map<string, FamilyDraft>();

  for (const session of sessions) {
    const placement = roots
      .map((root) => placementOf(root, session.path))
      .find((found) => found !== null);

    if (placement !== undefined && placement !== null) {
      const draft = drafts.get(placement.familyDir) ?? {
        files: [],
        main: null,
        placement,
      };

      draft.files.push(session);

      if (placement.isMain) {
        draft.main = session.path;
      }

      drafts.set(placement.familyDir, draft);
    }
  }

  return [...drafts.entries()]
    .map(([dir, draft]): SessionFamily => ({
      dir,
      files: draft.files.toSorted((a, b) =>
        orderOf(a.path, draft.main).localeCompare(orderOf(b.path, draft.main))
      ),
      main: draft.main,
      path: draft.main ?? dir,
      project: draft.placement.project,
      sessionId: draft.placement.sessionId,
    }))
    .toSorted((a, b) => a.path.localeCompare(b.path));
};

export const familyFilesFor = (
  ref: string,
  sessions: readonly StoredSession[]
): readonly StoredSession[] => {
  const dir = ref.endsWith(SESSION_EXTENSION) ? stripExtension(ref) : ref;
  const main = sessions.find((session) => session.path === ref) ?? null;

  const members = sessions
    .filter((session) => session.path.startsWith(`${dir}/`))
    .toSorted((a, b) => a.path.localeCompare(b.path));

  return main === null ? members : [main, ...members];
};

export const projectDirOf = (
  roots: readonly string[],
  file: string
): string | null => {
  for (const root of roots) {
    const base = trimSlashes(root);

    if (file.startsWith(`${base}/`)) {
      const [project] = file.slice(base.length + 1).split("/");

      return project === undefined ? null : `${base}/${project}`;
    }
  }

  return null;
};

export const metaPathOf = (sessionFile: string): string =>
  `${stripExtension(sessionFile)}${META_EXTENSION}`;

export const subagentChatId = (sessionId: string, agentId: string): string =>
  `${sessionId}:agent-${agentId}`;
