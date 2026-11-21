import {z} from "zod";
import {artifactSchema} from "./files.js";

export const artifactCategorySchema=z.enum(["document","spreadsheet","image","web","archive","code"]);
export const artifactHubQuerySchema=z.object({
  category:z.union([z.literal("all"),artifactCategorySchema]).default("all"),
  workspace_id:z.string().min(1).optional(),
  q:z.string().trim().max(200).default(""),
  mode:z.enum(["smart","all"]).default("smart"),
  sort:z.enum(["newest","oldest"]).default("newest"),
  offset:z.coerce.number().int().min(0).default(0),
  limit:z.coerce.number().int().min(1).max(100).default(36),
});
export const artifactHubItemSchema=artifactSchema.extend({
  category:artifactCategorySchema,workspace_name:z.string(),thread_title:z.string().nullable(),
});
export const artifactHubPageSchema=z.object({items:z.array(artifactHubItemSchema),total:z.number().int().nonnegative()});
export const artifactBatchSchema=z.strictObject({
  artifact_ids:z.array(z.uuid()).min(1).max(64),
  ttl_seconds:z.number().int().min(1).max(86400).optional(),
});
export type ArtifactCategory=z.infer<typeof artifactCategorySchema>;
export type ArtifactHubPage=z.infer<typeof artifactHubPageSchema>;
export type ArtifactHubItem=z.infer<typeof artifactHubItemSchema>;
