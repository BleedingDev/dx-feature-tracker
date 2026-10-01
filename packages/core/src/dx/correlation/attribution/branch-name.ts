const FULL_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/iu;

const DETACHED = /^\(?\s*(?:head\s+detached|detached|no\s+branch)/iu;

const HEADS_PREFIX = "refs/heads/";

export const branchNameOrNull = (
  raw: string | null | undefined
): string | null => {
  const name = raw?.trim() ?? "";

  if (
    name === "" ||
    name === "HEAD" ||
    FULL_SHA.test(name) ||
    DETACHED.test(name)
  ) {
    return null;
  }

  const short = name.startsWith(HEADS_PREFIX)
    ? name.slice(HEADS_PREFIX.length)
    : name;

  return short === "" || short === "HEAD" ? null : short;
};

export const isBranchName = (raw: string | null | undefined): boolean =>
  branchNameOrNull(raw) !== null;
