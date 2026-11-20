import { z } from "zod";
import { artifactSchema, automationLevelSchema } from "./files.js";
import { taskStatusSchema } from "./phase2.js";

export const onboardingStatusSchema = z.object({
  setup_required:z.boolean(), authenticated:z.boolean(), completed:z.boolean(),
  has_provider:z.boolean(), has_model:z.boolean(), has_workspace:z.boolean(),
});
export type OnboardingStatus = z.infer<typeof onboardingStatusSchema>;
export const localImportSchema = z.object({
  directory:z.string().min(1).max(255).refine(v => !v.startsWith(".") && !/[\\/:]/.test(v)),
  name:z.string().trim().min(1).max(120).optional(), automation_level:automationLevelSchema.default("conservative"),
});
export const usageGroupSchema = z.enum(["day","provider","model","workspace","task"]);
const metrics = z.object({
  requests:z.number(), unknown_usage:z.number().optional(), input_tokens:z.number(), output_tokens:z.number(), cost_usd:z.number(), cost_cny:z.number(),
});
export const usageReportSchema = z.object({rows:z.array(metrics.extend({label:z.string()})),totals:metrics});
export type UsageReport = z.infer<typeof usageReportSchema>;
export const threadHistorySchema = z.object({
  next_before:z.number().int().nullable(), next_artifact_before:z.number().int().nullable(),
  tasks:z.array(z.object({id:z.string(),prompt:z.string(),summary:z.string(),status:taskStatusSchema,created_at:z.string(),updated_at:z.string(),checkpoint_ref:z.string().nullable()})),
  artifacts:z.array(artifactSchema),
});
export type ThreadHistory = z.infer<typeof threadHistorySchema>;
export const adminAuditEntrySchema = z.object({
  id:z.number().int(), request_id:z.string(), action:z.string(), target:z.string().nullable(),
  details:z.string(), status:z.number().int(), created_at:z.string(),
});
export type AdminAuditEntry = z.infer<typeof adminAuditEntrySchema>;
