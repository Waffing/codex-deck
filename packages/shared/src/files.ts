import { z } from "zod";

export const automationLevelSchema = z.enum(["conservative", "semi", "full", "unrestricted"]);
export const workspaceCreateSchema = z.object({
  name: z.string().trim().min(1).max(120), automation_level: automationLevelSchema.default("conservative"),
});
export const workspaceCloneSchema = workspaceCreateSchema.extend({ url: z.url() });
export const workspaceSchema = workspaceCreateSchema.extend({
  id: z.string(), path: z.string(), status: z.enum(["ready", "cloning", "failed"]), created_at: z.string(), updated_at: z.string(),
});
export const changeTypeSchema = z.enum(["added", "modified", "upload", "screenshot"]);
export const artifactSchema = z.object({
  id: z.string(), workspace_id: z.string(), thread_id: z.string().nullable(), turn_id: z.string().nullable(),
  size_bytes: z.number().int().nonnegative().nullable().optional(),
  name: z.string(), path: z.string(), change_type: changeTypeSchema, mime_type: z.string().nullable(), created_at: z.string(),
});
export const filePathQuerySchema = z.object({ path: z.string().min(1) });
export const fileSaveSchema = filePathQuerySchema.extend({ content: z.string() });
export const fileContentSchema = fileSaveSchema.extend({ size: z.number().int().nonnegative(), mime_type: z.string() });
export const fileTreeSchema = z.array(z.object({ name: z.string(), path: z.string(), type: z.enum(["file","directory","symlink"]) }));
export const agentsScopeSchema = z.enum(["global","project"]).default("project");
export const agentsDocumentSchema = z.object({ scope: agentsScopeSchema, content: z.string() });
export const fileTreeQuerySchema = z.object({ path: z.string().default("") });
export const fileSaveResponseSchema = filePathQuerySchema;
export const uploadResponseSchema = z.object({ path: z.string(), artifact: artifactSchema });
export const gitStatusSchema = z.object({ porcelain: z.string() });
export const gitDiffQuerySchema = z.object({ format: z.enum(["json", "patch"]).default("json") });
export const gitDiffSchema = z.object({ diff: z.string() });
export const checkpointRestoreSchema = z.object({ restored: z.boolean() });
export const artifactSignSchema = z.union([
  z.object({ artifact_id: z.string().min(1), ttl_seconds: z.number().int().min(1).max(86400).optional() }).strict(),
  z.object({ turn_id: z.string().min(1), ttl_seconds: z.number().int().min(1).max(86400).optional() }).strict(),
]);
export const signedLinkSchema = z.object({ download_url: z.string() });
export type Workspace = z.infer<typeof workspaceSchema>;
export type Artifact = z.infer<typeof artifactSchema>;
export type ChangeType = z.infer<typeof changeTypeSchema>;
