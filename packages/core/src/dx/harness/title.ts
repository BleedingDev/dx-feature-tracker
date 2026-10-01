// @effect-diagnostics-next-line nodeBuiltinImport:off -- Prompt digests are a synchronous sha256 kept in a pure scan state; Effect Crypto is effectful.
import { createHash } from "node:crypto";

export const MAX_TITLE_CHARS = 200;

const PROMPT_DIGEST_CHARS = 32;

export const titleText = (value: string | null | undefined): string | null => {
  const title = value?.trim() ?? "";

  return title === "" ? null : title.slice(0, MAX_TITLE_CHARS).trimEnd();
};

export const promptDigest = (text: string): string =>
  createHash("sha256")
    .update(text.replaceAll(/\s+/gu, " ").trim())
    .digest("hex")
    .slice(0, PROMPT_DIGEST_CHARS);

export const titleUnlessPrompt = (
  name: string | null,
  prompts: readonly string[] | null
): string | null =>
  name === null || prompts === null || prompts.includes(promptDigest(name))
    ? null
    : titleText(name);
