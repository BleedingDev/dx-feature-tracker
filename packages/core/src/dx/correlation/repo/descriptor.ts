import { CONTRACT_VERSION } from "../../contracts/version.js";
import type { ModuleDescriptor } from "../../model/descriptor.js";
import { DescriptorIdSchema } from "../../model/ids.js";

export const REPO_CORRELATION_FIXTURE_IDS = [
  "b23-worktree-porcelain",
  "b23-live-linked-worktree",
];

export const repoCorrelationDescriptor: ModuleDescriptor = {
  contractVersion: CONTRACT_VERSION,
  fixtureIds: REPO_CORRELATION_FIXTURE_IDS,
  gaps: [
    {
      code: "local-only",
      message:
        "maps local worktrees by Git common dir only; no remote/GitHub repository identity (out of scope)",
    },
    {
      code: "no-case-folding",
      message:
        "paths compare case-sensitively after realpath; case-insensitive volumes rely on realpath canonicalisation of existing paths",
    },
    {
      code: "no-submodules",
      message:
        "submodule and multi-root workspaces resolve to the innermost worktree or stay multi-root/unassigned",
    },
  ],
  id: DescriptorIdSchema.make("correlation.repo"),
  kind: "correlation",
  owner: "B23",
  readiness: "ready",
  requiredInputs: [
    "absolute observed paths (hook cwd, workspace roots, edited files)",
    "local Git common dir or any path inside a worktree",
  ],
  supportedFields: [
    "context.repoCommonDir",
    "context.worktreePath",
    "context.branch",
    "context.headSha",
    "relativePath",
  ],
  version: "1.0.0",
};
