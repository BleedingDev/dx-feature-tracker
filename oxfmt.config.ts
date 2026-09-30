import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  ignorePatterns: [
    ...(ultracite.ignorePatterns ?? []),
    "plans/",
    "research/",
    "docs/execution/",
    "IDEA.md",
    "README.md",
  ],
});
