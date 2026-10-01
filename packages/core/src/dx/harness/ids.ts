import { Schema } from "effect";

export const HarnessIdSchema = Schema.Literals([
  "cursor",
  "claude-code",
  "codex",
  "opencode",
  "pi",
  "omp",
  "deepseek",
]);

export type HarnessId = typeof HarnessIdSchema.Type;

export const HARNESS_IDS: readonly HarnessId[] = HarnessIdSchema.literals;

export const ChannelSchema = Schema.Literals([
  "session-file",
  "hooks",
  "local-db",
  "usage-api",
  "cli-stream",
  "extension",
  "otel",
  "stats-db",
  "transcript",
]);

export type Channel = typeof ChannelSchema.Type;

export const ModelProviderSchema = Schema.Literals([
  "anthropic",
  "openai",
  "google",
  "deepseek",
  "xai",
  "moonshot",
  "zhipu",
  "qwen",
  "meta",
  "mistral",
  "cursor",
  "local",
  "unknown",
]);

export type ModelProvider = typeof ModelProviderSchema.Type;

export const BranchSourceSchema = Schema.Literals([
  "harness-recorded",
  "hook",
  "git-at-time",
  "cwd-inferred",
  "tool-calls",
  "subagent-split",
  "unassigned",
]);

export type BranchSource = typeof BranchSourceSchema.Type;

export const EffortSourceSchema = Schema.Literals([
  "harness-recorded",
  "model-suffix",
  "config",
]);

export type EffortSource = typeof EffortSourceSchema.Type;
