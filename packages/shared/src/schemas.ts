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

const publicProviderFields = z.object({
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
export const authLoginRequestSchema = z.object({ password: z.string().min(1).max(256) });
export const authResponseSchema = z.object({ authenticated: z.boolean(), setup_required: z.boolean() });
export const authLogoutRequestSchema = z.object({}).optional();
export const authStatusSchema = authResponseSchema;
export type AuthSetupRequest = z.infer<typeof authSetupRequestSchema>;
export type AuthLoginRequest = z.infer<typeof authLoginRequestSchema>;

export const responseRequestSchema = z.object({
  model: z.string().min(1),
  input: z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]),
  instructions: z.string().optional(),
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
