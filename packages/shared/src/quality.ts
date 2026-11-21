import { z } from "zod";

export const planApprovalStateSchema = z.object({
  turn_id:z.string(), markdown:z.string(), status:z.literal("ready"),
});
export type PlanApprovalState = z.infer<typeof planApprovalStateSchema>;
export const verifyGateConfigSchema = z.object({
  auto_verify_enabled:z.boolean(), verify_network_enabled:z.boolean(),
  verify_commands:z.array(z.string().trim().min(1).max(2048)).max(16),
  max_self_heal_retries:z.number().int().min(0).max(5), review_model_alias:z.string().trim().min(1).max(200).nullable(),
}).strict();
export type VerifyGateConfig = z.infer<typeof verifyGateConfigSchema>;
export const verifyGateResultSchema = z.object({
  status:z.enum(["running","passed","failed","cancelled","repairing"]), attempt:z.number().int().nonnegative(),
  max_retries:z.number().int().nonnegative(), commands:z.array(z.object({
    command:z.string(),output:z.string(),exit_code:z.number().int().nullable(),
  })),
});
export type VerifyGateResult = z.infer<typeof verifyGateResultSchema>;
export const crossModelReviewRequestSchema = z.object({
  turn_id:z.string().min(1).optional(), reviewer_model_alias:z.string().trim().min(1).max(200).optional(),
}).strict();
export type CrossModelReviewRequest = z.infer<typeof crossModelReviewRequestSchema>;
export const crossModelReviewFindingSchema = z.object({
  id:z.string().min(1).max(128), severity:z.enum(["critical","warning","suggestion"]),
  category:z.enum(["security","bug","race","performance","maintainability"]), file:z.string().min(1).max(2048),
  line:z.number().int().positive(), title:z.string().min(1).max(512),
  detail:z.string().min(1).max(8192), fix_hint:z.string().max(4096),
});
export type CrossModelReviewFinding = z.infer<typeof crossModelReviewFindingSchema>;
export const reviewContentSchema = z.object({summary:z.string().trim().min(1).max(8192),findings:z.array(crossModelReviewFindingSchema).max(100)});
export const crossModelReviewSchema = reviewContentSchema.extend({
  id:z.string(),thread_id:z.string(),workspace_id:z.string(),turn_id:z.string().nullable(),reviewer_model_alias:z.string(),
  diff_hash:z.string(),truncated:z.boolean(),created_at:z.string(),
});
export type CrossModelReview = z.infer<typeof crossModelReviewSchema>;
export const diffAnnotationSchema = z.object({
  file:z.string().min(1).max(2048),line:z.number().int().positive(),side:z.enum(["old","new"]),comment:z.string().trim().min(1).max(4096),
}).strict();
export type DiffAnnotation = z.infer<typeof diffAnnotationSchema>;
export const reviewFeedbackSchema = z.object({
  turn_id:z.string().min(1).optional(),diff_hash:z.string().regex(/^[0-9a-f]{64}$/),client_msg_id:z.uuid(),
  annotations:z.array(diffAnnotationSchema).max(40).optional(),review_id:z.string().min(1).optional(),finding_ids:z.array(z.string().min(1)).max(40).optional(),
}).strict().refine(v=>Boolean(v.annotations?.length || v.finding_ids?.length) && Boolean(v.review_id)===Boolean(v.finding_ids?.length));
export const handoffRequestSchema = z.object({
  model_alias:z.string().trim().min(1).max(200).optional(),focus_note:z.string().trim().max(4096).optional(),
}).strict();
export const handoffResultSchema = z.object({thread_id:z.string(),parent_thread_id:z.string(),handoff_doc:z.string()});
export type HandoffResult = z.infer<typeof handoffResultSchema>;
