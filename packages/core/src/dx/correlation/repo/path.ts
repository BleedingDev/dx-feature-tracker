const DRIVE = /^[A-Za-z]:\//u;

const isAbsoluteNormalized = (value: string): boolean =>
  value.startsWith("/") || DRIVE.test(value);

export const normalizePath = (raw: string): string | null => {
  const slashed = raw.trim().replaceAll("\\", "/");

  if (slashed.length === 0 || !isAbsoluteNormalized(slashed)) {
    return null;
  }

  const drive = DRIVE.test(slashed) ? slashed.slice(0, 2).toUpperCase() : "";
  const rest = drive === "" ? slashed : slashed.slice(2);
  const out: string[] = [];

  for (const segment of rest.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }

    if (segment === "..") {
      out.pop();
      continue;
    }

    out.push(segment);
  }

  return `${drive}/${out.join("/")}`;
};

export const relativeWithin = (
  root: string,
  candidate: string
): string | null => {
  const normalRoot = normalizePath(root);
  const normalCandidate = normalizePath(candidate);

  if (normalRoot === null || normalCandidate === null) {
    return null;
  }

  if (normalRoot === normalCandidate) {
    return "";
  }

  const prefix = normalRoot.endsWith("/") ? normalRoot : `${normalRoot}/`;

  return normalCandidate.startsWith(prefix)
    ? normalCandidate.slice(prefix.length)
    : null;
};

export const isContained = (root: string, candidate: string): boolean =>
  relativeWithin(root, candidate) !== null;

export const containedJoin = (
  base: string,
  relative: string
): string | null => {
  const normalBase = normalizePath(base);

  if (normalBase === null) {
    return null;
  }

  const slashed = relative.replaceAll("\\", "/");

  const joined = isAbsoluteNormalized(slashed)
    ? normalizePath(slashed)
    : normalizePath(`${normalBase}/${slashed}`);

  return joined !== null && isContained(normalBase, joined) ? joined : null;
};
