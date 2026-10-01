export const OMP_SESSION_SUFFIX = ".jsonl";

export const OMP_ARCHIVE_SUFFIX = ".jsonl.gz";

export const isOmpSessionPath = (file: string): boolean =>
  file.endsWith(OMP_SESSION_SUFFIX) || file.endsWith(OMP_ARCHIVE_SUFFIX);

export const isArchivedSession = (file: string): boolean =>
  file.endsWith(OMP_ARCHIVE_SUFFIX);

export const sessionStem = (file: string): string => {
  if (file.endsWith(OMP_ARCHIVE_SUFFIX)) {
    return file.slice(0, -OMP_ARCHIVE_SUFFIX.length);
  }

  return file.endsWith(OMP_SESSION_SUFFIX)
    ? file.slice(0, -OMP_SESSION_SUFFIX.length)
    : file;
};

const trimSlashes = (dir: string): string => dir.replace(/\/+$/u, "");

const dirnameOf = (file: string): string => {
  const index = trimSlashes(file).lastIndexOf("/");

  return index <= 0 ? "/" : file.slice(0, index);
};

export const basenameOf = (file: string): string =>
  trimSlashes(file).slice(trimSlashes(file).lastIndexOf("/") + 1);

export const parentSessionCandidates = (file: string): readonly string[] => {
  const dir = dirnameOf(file);

  return [`${dir}${OMP_SESSION_SUFFIX}`, `${dir}${OMP_ARCHIVE_SUFFIX}`];
};

export const subagentIdOf = (file: string): string =>
  basenameOf(sessionStem(file));

export const sessionIdFromName = (file: string): string | null => {
  const name = basenameOf(sessionStem(file));
  const index = name.indexOf("_");

  return index === -1 ? null : name.slice(index + 1);
};

const PRIVATE_ROOTS = ["/tmp", "/var", "/etc"] as const;

export const pathForms = (dir: string): readonly string[] => {
  const clean = trimSlashes(dir);
  const forms = new Set([clean]);

  for (const root of PRIVATE_ROOTS) {
    if (clean === `/private${root}` || clean.startsWith(`/private${root}/`)) {
      forms.add(clean.slice("/private".length));
    }

    if (clean === root || clean.startsWith(`${root}/`)) {
      forms.add(`/private${clean}`);
    }
  }

  return [...forms];
};

const within = (child: string, parent: string): boolean =>
  child === parent || child.startsWith(`${parent === "/" ? "" : parent}/`);

export const isInside = (child: string | null, parent: string): boolean => {
  if (child === null || child === "") {
    return false;
  }

  const parents = pathForms(parent);

  return pathForms(child).some((form) =>
    parents.some((root) => within(form, root))
  );
};

export const isStrictAncestor = (
  ancestor: string | null,
  descendant: string
): boolean => {
  if (ancestor === null || ancestor === "") {
    return false;
  }

  return (
    isInside(descendant, ancestor) &&
    !pathForms(ancestor).some((form) => pathForms(descendant).includes(form))
  );
};

const normalizeSegments = (absolute: string): string => {
  const parts: string[] = [];

  for (const part of absolute.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }

    if (part === "..") {
      parts.pop();
    } else {
      parts.push(part);
    }
  }

  return `/${parts.join("/")}`;
};

export const resolveToolPath = (
  cwd: string | null,
  target: string
): string | null => {
  if (target.startsWith("/")) {
    return normalizeSegments(target);
  }

  if (cwd === null || target.startsWith("~")) {
    return null;
  }

  return normalizeSegments(`${cwd}/${target}`);
};
