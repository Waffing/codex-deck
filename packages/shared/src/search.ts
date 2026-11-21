import { z } from "zod";
import { artifactSchema } from "./files.js";

export const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(160).regex(/^[^\x00-\x1f]+$/),
  scope: z.enum(["all", "messages", "artifacts", "deployments"]).default("all"),
  workspace_id: z.string().min(1).max(128).optional(),
});
export const globalSearchHitSchema = z.object({
  entity_type: z.enum(["messages", "artifacts", "deployments"]),
  entity_id: z.string(), workspace_id: z.string().nullable(), thread_id: z.string().nullable(),
  turn_index: z.number().int().nullable(), title: z.string(),
  snippet: z.array(z.object({ text: z.string(), match: z.boolean() })),
  artifact: artifactSchema.optional(),
});
export const searchResultsSchema = z.object({
  messages: z.array(globalSearchHitSchema), artifacts: z.array(globalSearchHitSchema),
  deployments: z.array(globalSearchHitSchema), indexing: z.boolean(),
});
export type SearchQuery = z.infer<typeof searchQuerySchema>;
export type GlobalSearchHit = z.infer<typeof globalSearchHitSchema>;
export type SearchResults = z.infer<typeof searchResultsSchema>;
