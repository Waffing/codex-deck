import { z } from "zod";

export const providerPresetSchema = z.enum([
  "openai_official",
  "oneapi_newapi",
  "openrouter",
  "deepseek",
  "ollama",
  "custom",
]);

const baseUrl = z.string().url().refine((input) => {
  const url = URL.parse(input);
  return url && ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
}, "Expected an HTTP(S) base URL without credentials, query or fragment.");
const headersSchema = z.record(z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/).refine(
  (name) => !["host", "connection", "content-length", "transfer-encoding", "upgrade", "cookie", "proxy-authorization"].includes(name.toLowerCase()),
), z.string().regex(/^[\t\x20-\x7e]*$/));
const providerFields = z.object({
  api_keys: z.array(z.string().trim().min(1).max(16384)).max(64).optional(),
  retain_key_ids: z.array(z.string().min(1)).max(64).optional(),
  rotation_strategy: z.enum(["round_robin","failover"]).optional(),
  balance_endpoint: z.string().max(2048).nullable().optional(),
  balance_token: z.string().max(16384).optional(),
  balance_user_id: z.string().regex(/^[0-9]{0,24}$/).nullable().optional(),
  name: z.string().trim().min(1).max(120),
  preset: providerPresetSchema,
  base_url: baseUrl,
  api_key: z.string().max(16384),
  headers: headersSchema,
  quirks: z.object({ strip_reasoning: z.boolean(), force_chat: z.boolean().optional() }),
  enabled: z.boolean(),
});
export const providerCreateSchema = providerFields.extend({
  api_key: providerFields.shape.api_key.default(""),
  headers: headersSchema.default({}),
  quirks: providerFields.shape.quirks.default({ strip_reasoning: false }),
  enabled: z.boolean().default(true),
});
export const providerPatchSchema = providerFields.partial();

export const providerBalanceSchema = z.object({
  status:z.enum(["ok","unsupported","unauthorized","error"]),amount:z.number().nullable(),
  unit:z.string().nullable(),checked_at:z.string(),balance_at:z.string().nullable(),error:z.string().optional(),
});
const publicProviderFields = z.object({
  rotation_strategy: z.enum(["round_robin","failover"]).default("round_robin"),
  keys: z.array(z.object({id:z.string(),masked:z.string(),status:z.enum(["ready","cooldown","unauthorized"]),cooldown_until:z.string().nullable()})).default([]),
  balance_endpoint: z.string().nullable().default(null),
  has_balance_token: z.boolean().default(false),
  balance_user_id: z.string().nullable().default(null),
  last_balance: providerBalanceSchema.nullable().default(null),
  id: z.string(),
  name: z.string(),
  preset: providerPresetSchema,
  base_url: z.string(),
  api_key_masked: z.string().nullable(),
  headers: z.record(z.string(), z.string()),
  quirks: providerFields.shape.quirks,
  enabled: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
});

const modelFields = z.object({
  context_window: z.number().int().positive().max(2147483647),
  max_output_tokens: z.number().int().positive().max(2147483647),
  cache_read_price_per_1m: z.number().finite().nonnegative(),
  capabilities: z.array(z.string().trim().min(1).max(40)).max(20),
  confirmed_free: z.boolean().optional(),
  pricing_currency: z.enum(["USD","CNY"]),
  cost_input_cny_per_million: z.number().nonnegative(),
  cost_output_cny_per_million: z.number().nonnegative(),
  provider_id: z.string().min(1),
  alias: z.string().trim().min(1).max(120),
  model_id: z.string().trim().min(1).max(240),
  protocol: z.enum(["auto", "responses", "chat"]),
  fallback_model_ids: z.array(z.string().min(1)),
  cost_input_usd_per_million: z.number().nonnegative(),
  cost_output_usd_per_million: z.number().nonnegative(),
  enabled: z.boolean(),
});
export const modelCreateSchema = modelFields.extend({
  context_window: modelFields.shape.context_window.default(128000),
  max_output_tokens: modelFields.shape.max_output_tokens.default(16384),
  cache_read_price_per_1m: modelFields.shape.cache_read_price_per_1m.default(0),
  capabilities: modelFields.shape.capabilities.default([]),
  pricing_currency: modelFields.shape.pricing_currency.default("USD"),
  cost_input_cny_per_million: modelFields.shape.cost_input_cny_per_million.default(0),
  cost_output_cny_per_million: modelFields.shape.cost_output_cny_per_million.default(0),
  protocol: modelFields.shape.protocol.default("auto"),
  fallback_model_ids: modelFields.shape.fallback_model_ids.default([]),
  cost_input_usd_per_million: modelFields.shape.cost_input_usd_per_million.default(0),
  cost_output_usd_per_million: modelFields.shape.cost_output_usd_per_million.default(0),
  enabled: z.boolean().default(true),
});
export const modelPatchSchema = modelFields.partial();
export const discoveredModelSchema = z.object({model_id:modelFields.shape.model_id, context_window:modelFields.shape.context_window, context_source:z.enum(["upstream","inferred"]),capabilities:modelFields.shape.capabilities});
export const fetchModelsResponseSchema = z.object({models:z.array(discoveredModelSchema)});
export const modelBatchSchema = z.object({provider_id:modelFields.shape.provider_id, models:z.array(discoveredModelSchema.partial({context_window:true,context_source:true,capabilities:true}).extend({alias:modelFields.shape.alias.optional()})).min(1).max(500)});
export const benchmarkRequestSchema = z.object({model_ids:z.array(z.string().min(1)).min(1).max(200),concurrency:z.number().int().min(1).max(8).default(3),sample_tokens:z.union([z.literal(1),z.literal(32)]).default(1)});
export const benchmarkResultSchema = z.object({model_id:z.string(),ttft_ms:z.number().nullable(),tokens_per_sec:z.number().nullable(),sample_tokens:z.union([z.literal(1),z.literal(32)]),output_tokens:z.number().int().nonnegative().nullable(),status:z.enum(["ok","failed"]),tested_at:z.string(),error:z.string().optional()});
export const benchmarkResponseSchema = z.object({results:z.array(benchmarkResultSchema)});
export type BenchmarkResult = z.infer<typeof benchmarkResultSchema>;
export type DiscoveredModel = z.infer<typeof discoveredModelSchema>;
export type ProviderBalance = z.infer<typeof providerBalanceSchema>;

export const probeCapabilitiesSchema = z.object({
  responses: z.boolean(),
  chat: z.boolean(),
  tools: z.boolean(),
  vision: z.boolean(),
  latency_ms: z.number().nullable(),
});

export const probeResultSchema = z.object({
  provider_id: z.string(),
  ok: z.boolean(),
  models: z.array(z.string()),
  capabilities: probeCapabilitiesSchema,
  checked_at: z.string(),
  error: z.string().optional(),
});

export const modelSchema = z.object({
  context_window: modelFields.shape.context_window.default(128000),
  max_output_tokens: modelFields.shape.max_output_tokens.default(16384),
  cache_read_price_per_1m: modelFields.shape.cache_read_price_per_1m.default(0),
  capabilities: modelFields.shape.capabilities.default([]),
  last_benchmark: benchmarkResultSchema.nullable().default(null),
  confirmed_free:z.boolean().optional(),
  last_probe: probeResultSchema.nullable().optional(),
  pricing_currency: modelFields.shape.pricing_currency.default("USD"),
  cost_input_cny_per_million: modelFields.shape.cost_input_cny_per_million.default(0),
  cost_output_cny_per_million: modelFields.shape.cost_output_cny_per_million.default(0),
  id: z.string(),
  provider_id: z.string(),
  alias: z.string(),
  model_id: z.string(),
  protocol: z.enum(["auto", "responses", "chat"]),
  fallback_model_ids: z.array(z.string()),
  cost_input_usd_per_million: z.number(),
  cost_output_usd_per_million: z.number(),
  enabled: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const providerSchema = publicProviderFields.extend({ last_probe: probeResultSchema.nullable() });
export const modelBatchResponseSchema = z.object({imported:z.array(modelSchema),skipped:z.array(z.string())});
export const providerListSchema = z.array(providerSchema);
export const modelListSchema = z.array(modelSchema);
export const apiErrorSchema = z.object({ error: z.string() });

export const gatewayConfigSchema = z.object({
  host: z.string().default("127.0.0.1"),
  port: z.number().int().min(1).max(65535),
  upstream_timeout_ms: z.number().int().positive().max(600000).default(30000),
  internal_token_ttl_seconds: z.number().int().positive().max(86400).default(3600),
  default_model: z.string().optional(),
});

export const authSetupRequestSchema = z.object({ password: z.string().min(12).max(256), setup_code: z.string().min(1).max(128) });
export const authPasswordChangeSchema = z.object({ current_password: z.string().min(1).max(256), new_password: z.string().min(12).max(256) });
export const authLoginRequestSchema = z.object({ password:z.string().min(1).max(256), otp:z.string().max(64).optional(),
  captcha_id:z.string().max(64).optional(), captcha_answer:z.string().max(16).optional() });
export const authResponseSchema = z.object({ authenticated: z.boolean(), setup_required: z.boolean() });
export const authLogoutRequestSchema = z.object({}).optional();
export const authStatusSchema = authResponseSchema;
export type AuthSetupRequest = z.infer<typeof authSetupRequestSchema>;
export type AuthLoginRequest = z.infer<typeof authLoginRequestSchema>;

export const responseRequestSchema = z.object({
  model: z.string().min(1),
  input: z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]),
  instructions: z.string().optional(),
  max_output_tokens: z.number().int().positive().optional(),
  tools: z.array(z.record(z.string(), z.unknown())).optional(),
  tool_choice: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  stream: z.boolean().default(false),
}).passthrough();

export type ProviderPreset = z.infer<typeof providerPresetSchema>;
export type ProviderCreate = z.infer<typeof providerCreateSchema>;
export type ProviderPatch = z.infer<typeof providerPatchSchema>;
export type Provider = z.infer<typeof providerSchema>;
export type ModelCreate = z.infer<typeof modelCreateSchema>;
export type ModelPatch = z.infer<typeof modelPatchSchema>;
export type Model = z.infer<typeof modelSchema>;
export type ProbeResult = z.infer<typeof probeResultSchema>;
export type GatewayConfig = z.infer<typeof gatewayConfigSchema>;
export type AuthResponse = z.infer<typeof authResponseSchema>;
export type ResponseRequest = z.infer<typeof responseRequestSchema>;
