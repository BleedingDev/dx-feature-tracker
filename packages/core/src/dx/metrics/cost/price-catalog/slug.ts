const EFFORT_SUFFIX =
  /-(?:thinking(?:-[a-z]+)?|fast|low|medium|high|xhigh|max|minimal|none)$/u;

const UNPRICEABLE = new Set(["auto", "default", ""]);

export type SlugMatch =
  | { readonly catalogId: string; readonly kind: "matched" }
  | { readonly kind: "unavailable"; readonly reason: string };

export const stripSlugParams = (slug: string): string => {
  let base = slug
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]$/u, "");

  while (EFFORT_SUFFIX.test(base)) {
    base = base.replace(EFFORT_SUFFIX, "");
  }

  return base;
};

const REORDERED_CLAUDE =
  /^claude-(?<version>\d+(?:[.-]\d+)?)-(?<family>opus|sonnet|haiku|fable)$/u;

export const candidateIds = (slug: string): readonly string[] => {
  const base = stripSlugParams(slug);
  const dashed = base.replaceAll(".", "-");
  const reordered = REORDERED_CLAUDE.exec(dashed);

  const claude =
    reordered === null
      ? []
      : [
          `claude-${reordered.groups?.family ?? ""}-${(reordered.groups?.version ?? "").replaceAll(".", "-")}`,
        ];

  const dotted = /^gpt-|^gemini-|^grok-/u.test(base)
    ? [base.replace(/(?<major>\d)-(?<minor>\d)/u, "$<major>.$<minor>")]
    : [];

  const ids = [...new Set([base, dashed, ...claude, ...dotted])];

  const fast = slug
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]$/u, "")
    .slice(base.length)
    .split("-")
    .includes("fast");

  return fast ? ids.map((id) => `${id}-fast`) : ids;
};

export const matchSlug = (
  slug: string | null,
  catalogIds: ReadonlySet<string>
): SlugMatch => {
  if (slug === null || UNPRICEABLE.has(stripSlugParams(slug))) {
    return {
      kind: "unavailable",
      reason:
        "Auto/default has no fixed model; Cursor does not report the model behind it",
    };
  }

  const hit = candidateIds(slug).find((id) => catalogIds.has(id));

  return hit === undefined
    ? {
        kind: "unavailable",
        reason: `no catalog entry for ${stripSlugParams(slug)}; not guessed`,
      }
    : { catalogId: hit, kind: "matched" };
};
