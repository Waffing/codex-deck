import { z } from "zod";

export const reasoningEffortSchema = z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]);
export const threadCreateSchema = z.object({
  workspace_id: z.string().min(1), model_alias: z.string().min(1).optional(), title: z.string().trim().min(1).max(240).optional(),
});
export const threadMessageSchema = z.object({ prompt:z.string().trim().max(200_000), image_ids:z.array(z.uuid()).max(4).optional() })
  .refine(input => Boolean(input.prompt || input.image_ids?.length));
export const threadModelPatchSchema = z.object({
  model_alias: z.string().min(1).optional(), reasoning_effort: reasoningEffortSchema.nullable().optional(),
}).refine(v => v.model_alias !== undefined || v.reasoning_effort !== undefined);
export const threadSchema = z.object({
  id: z.string(), workspace_id: z.string().nullable(), title: z.string(), status: z.string(),
  active_model_alias: z.string().nullable(), reasoning_effort: reasoningEffortSchema.nullable(),
  created_at: z.string(), updated_at: z.string(),
});
export const approvalDecisionSchema = z.object({
  decision: z.enum(["approve", "approve_session", "deny_guide", "abort"]),
  user_guidance: z.string().trim().max(16_384).optional(),
});
export const approvalSchema = z.object({
  expires_at: z.string().nullable().optional(),
  id: z.string(), thread_id: z.string(), action: z.string(), risk_level: z.enum(["low", "medium", "high"]),
  payload: z.unknown(), status: z.string(), created_at: z.string(), resolved_at: z.string().nullable(),
});
export type Thread = z.infer<typeof threadSchema>;
export type Approval = z.infer<typeof approvalSchema>;
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;
