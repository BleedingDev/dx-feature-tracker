import { CONTRACT_VERSION } from "../../contracts/version.js";
import type { ModuleDescriptor } from "../../model/descriptor.js";
import { DescriptorIdSchema } from "../../model/ids.js";

export const PROVIDER_USAGE_ADAPTER_ID = "provider-usage";

export const PROVIDER_USAGE_ADAPTER_VERSION = "0.1.0";

export const PROVIDER_USAGE_FIXTURE_IDS = [
  "b14-openai-usage",
  "b14-openai-costs",
  "b14-anthropic-usage",
  "b14-anthropic-cost-unsupported",
] as const;

export const providerUsageDescriptor: ModuleDescriptor = {
  contractVersion: CONTRACT_VERSION,
  fixtureIds: [...PROVIDER_USAGE_FIXTURE_IDS],
  gaps: [
    {
      code: "shape-unverified",
      message:
        "Formats follow the public OpenAI organization usage/costs and Anthropic usage-report page shapes; no real export was available on this host, so parsing is fixture-tested only.",
    },
    {
      code: "account-aggregate",
      message:
        "Provider usage is an account/project time bucket, not a branch or request; events carry scope provider-bucket and must not be treated as strong branch attribution.",
    },
    {
      code: "no-auto-fetch",
      message:
        "Only an explicitly supplied file is read. No API keys, account-wide fetch, pagination follow-up or directory scan.",
    },
    {
      code: "anthropic-cost-unsupported",
      message:
        "Anthropic cost-report exports are rejected as unsupported because their amount unit is not verified here.",
    },
    {
      code: "json-only",
      message: "CSV provider exports are not parsed by this module.",
    },
  ],
  id: DescriptorIdSchema.make(PROVIDER_USAGE_ADAPTER_ID),
  kind: "collector",
  owner: "B14",
  readiness: "degraded",
  requiredInputs: [
    "explicit --input path to a provider usage or cost JSON page export",
  ],
  supportedFields: [
    "tokens.input",
    "tokens.cached-input",
    "tokens.cache-write",
    "tokens.output",
    "requests",
    "charge",
    "model",
    "window",
  ],
  version: PROVIDER_USAGE_ADAPTER_VERSION,
};
