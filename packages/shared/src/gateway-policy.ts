import {z} from "zod";

export const providerProtocolSchema=z.enum(["openai_responses","openai_chat","anthropic_messages","gemini_openai"]);
export const patchRulesSchema=z.object({
  developer_to_system:z.boolean().optional(), map_max_tokens:z.boolean().optional(),
  strip_fields:z.array(z.string().regex(/^[a-z][a-z_0-9]*$/)).max(32).optional(),
  include_usage:z.boolean().optional(), extra_body:z.record(z.string(),z.json()).optional(),
}).strict();
export const circuitConfigSchema=z.object({failure_threshold:z.number().int().min(1).max(100).optional(),
  cooldown_seconds:z.number().int().min(1).max(86400).optional()});
export const providerPolicyFields={
  protocol_type:providerProtocolSchema.nullable().optional(), patch_rules:patchRulesSchema.optional(),
  circuit_breaker:circuitConfigSchema.optional(), weight:z.number().int().min(1).max(1000).optional(),
  rpm_limit:z.number().int().min(0).max(1000000).optional(), daily_budget:z.number().nonnegative().optional(),
  monthly_budget:z.number().nonnegative().optional(),budget_action:z.enum(["alert","block"]).optional(),
};
export const keyQuotaFields={
  allowed_models:z.array(z.string().trim().min(1).max(160)).max(500).optional(),
  tpm_limit:z.number().int().min(0).max(1_000_000_000).optional(),
  daily_budget:z.number().nonnegative().optional(), monthly_budget:z.number().nonnegative().optional(),
};
export const routeStrategySchema=z.enum(["pinned","priority_failover","weighted_rr","lowest_latency"]);
export const routingProfileSchema=z.object({slug:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/),name:z.string().trim().min(1).max(120),
  description:z.string().max(1000).default(""), strategy:routeStrategySchema.default("pinned"),
  targets:z.array(z.object({model_id:z.string().min(1),weight:z.number().int().min(1).max(1000).optional()})).min(1).max(128),
  active_target_index:z.number().int().nonnegative().default(0),is_global_default:z.boolean().default(false),enabled:z.boolean().default(true)});
export type RoutingProfile=z.infer<typeof routingProfileSchema> & {id:string;created_at:string;updated_at:string};
