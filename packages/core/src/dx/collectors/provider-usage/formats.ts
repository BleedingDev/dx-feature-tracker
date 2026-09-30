import { Schema } from "effect";

const OptionalCount = Schema.optional(Schema.NullOr(Schema.Finite));

const OptionalText = Schema.optional(Schema.NullOr(Schema.String));

export const OpenAiUsageResultSchema = Schema.Struct({
  api_key_id: OptionalText,
  input_cached_tokens: OptionalCount,
  input_tokens: OptionalCount,
  model: OptionalText,
  num_model_requests: OptionalCount,
  object: Schema.Literal("organization.usage.completions.result"),
  output_tokens: OptionalCount,
  project_id: OptionalText,
});

export type OpenAiUsageResult = typeof OpenAiUsageResultSchema.Type;

export const OpenAiCostResultSchema = Schema.Struct({
  amount: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        currency: OptionalText,
        value: OptionalCount,
      })
    )
  ),
  line_item: OptionalText,
  object: Schema.Literal("organization.costs.result"),
  project_id: OptionalText,
});

export type OpenAiCostResult = typeof OpenAiCostResultSchema.Type;

const openAiPage = <Row extends Schema.Top>(row: Row) =>
  Schema.Struct({
    data: Schema.Array(
      Schema.Struct({
        end_time: Schema.Finite,
        results: Schema.Array(row),
        start_time: Schema.Finite,
      })
    ),
    has_more: Schema.optional(Schema.NullOr(Schema.Boolean)),
    object: Schema.Literal("page"),
  });

export const OpenAiUsagePageSchema = openAiPage(OpenAiUsageResultSchema);

export const OpenAiCostPageSchema = openAiPage(OpenAiCostResultSchema);

export const AnthropicUsageResultSchema = Schema.Struct({
  api_key_id: OptionalText,
  cache_creation: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        ephemeral_1h_input_tokens: OptionalCount,
        ephemeral_5m_input_tokens: OptionalCount,
      })
    )
  ),
  cache_read_input_tokens: OptionalCount,
  model: OptionalText,
  output_tokens: OptionalCount,
  uncached_input_tokens: Schema.NullOr(Schema.Finite),
  workspace_id: OptionalText,
});

export type AnthropicUsageResult = typeof AnthropicUsageResultSchema.Type;

export const AnthropicCostResultSchema = Schema.Struct({
  amount: Schema.String,
  currency: Schema.String,
});

const anthropicPage = <Row extends Schema.Top>(row: Row) =>
  Schema.Struct({
    data: Schema.Array(
      Schema.Struct({
        ending_at: Schema.String,
        results: Schema.Array(row),
        starting_at: Schema.String,
      })
    ),
    has_more: Schema.optional(Schema.NullOr(Schema.Boolean)),
  });

export const AnthropicUsagePageSchema = anthropicPage(
  AnthropicUsageResultSchema
);

export const AnthropicCostPageSchema = anthropicPage(AnthropicCostResultSchema);

export const ProviderUsageFormatSchema = Schema.Literals([
  "openai-usage-completions",
  "openai-costs",
  "anthropic-usage-messages",
]);

export type ProviderUsageFormat = typeof ProviderUsageFormatSchema.Type;
