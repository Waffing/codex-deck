import { z } from "zod";

const expiresAt = z.iso.datetime({ offset: true });
export const shareLimitsSchema = z.object({
  expires_at: expiresAt.optional(),
  max_views: z.number().int().min(1).max(1_000_000).nullable().optional(),
  allow_download: z.boolean().optional(),
}).strict();
export const shareCreateSchema = shareLimitsSchema.extend({
  artifact_id: z.string().min(1).max(128),
  title: z.string().trim().min(1).max(200).optional(),
  passcode: z.string().min(4).max(64).optional(),
});
export const shareVerifySchema = z.object({ passcode: z.string().max(64).optional() }).strict();
export const publicShareSchema = z.object({
  id: z.string(), slug: z.string(), workspace_id: z.string(), artifact_id: z.string(),
  rel_path: z.string(), title: z.string(), share_type: z.string(), requires_passcode: z.boolean(),
  expires_at: expiresAt, max_views: z.number().int().nullable(), view_count: z.number().int(),
  allow_download: z.boolean(), status: z.enum(["active", "expired", "exhausted", "revoked"]), created_at: expiresAt,
});
export type PublicShare = z.infer<typeof publicShareSchema>;
export type ShareReaderState = {state:"locked"|"unavailable"} | {state:"ready";name:string;title:string;allow_download:boolean;expires_at:string;size:number};
