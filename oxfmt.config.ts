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
    "packages/core/test/dx/fixtures/c12/garbage.batch.json",
    "packages/core/test/dx/fixtures/c12/truncated.batch.json",
    "packages/core/test/dx/fixtures/b46/cumulative-unverified/22/2222222222/1/metadata.json",
    "packages/core/test/dx/fixtures/b48/dir/ignored.json",
    "packages/core/test/dx/fixtures/b10/result.json",
  ],
});
