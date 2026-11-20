import { z } from "zod";

export const analyticsQuerySchema = z.object({
  period: z.enum(["day", "week", "month"]).default("day"),
  group_by: z.enum(["period", "provider", "model", "workspace", "task"]).default("period"),
});
export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;
const measures = z.object({
  requests: z.number(), unknown_usage: z.number(),
  input_tokens: z.number(), output_tokens: z.number(), cached_input_tokens: z.number().nullable(),
  cache_hit_rate: z.number().nullable(), tokens_per_sec: z.number().nullable(), ttft_ms: z.number().nullable(),
  cost_usd: z.number(), cost_cny: z.number(),
});
export const analyticsReportSchema = z.object({
  totals: measures,
  rows: z.array(measures.extend({ id: z.string(), label: z.string() })),
  trend: z.array(measures.extend({ id: z.string(), label: z.string() })),
});
export type AnalyticsReport = z.infer<typeof analyticsReportSchema>;
const limit = z.number().positive().nullable();
export const budgetSchema = z.object({
  daily_usd: limit, monthly_usd: limit, daily_cny: limit, monthly_cny: limit,
});
export const budgetAlertSchema = z.object({
  kind: budgetSchema.keyof(), period: z.string(), limit: z.number(), spent: z.number(), created_at: z.string(),
});
export type UsageBudget = z.infer<typeof budgetSchema>;
export type BudgetAlert = z.infer<typeof budgetAlertSchema>;
