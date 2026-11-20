import { z } from "zod";

export const threadEventSchema = z.object({
  thread_id: z.string(), task_id: z.string().nullable(), seq_id: z.number().int().positive(),
  type: z.string(), payload: z.unknown(), created_at: z.string(),
});
export type ThreadEvent = z.infer<typeof threadEventSchema>;
export const subscriptionSchema = z.object({
  type: z.literal("subscribe"), debug:z.boolean().default(false), thread_id: z.string().optional(), last_seq_id: z.number().int().nonnegative().default(0),
});
export const wsFrameSchema = z.discriminatedUnion("type", [
  z.object({type:z.literal("cursor"),seq_id:z.number().int().positive(),thread_id:z.string()}),
  z.object({ type: z.literal("event"), event: threadEventSchema }),
  z.object({ type: z.literal("approvals_count"), count: z.number().int().nonnegative() }),
  z.object({type:z.literal("thread_changed"),thread_id:z.string()}),
  z.object({ type: z.literal("heartbeat"), timestamp: z.string(), free_memory_bytes: z.number(), load: z.array(z.number()),
    cpu_percent:z.number().nullable(),total_memory_bytes:z.number(),running_services:z.number(),gateway_healthy:z.boolean() }),
]);
export const scopeSchema = z.enum(["tasks:write", "tasks:read", "files:download"]);
export const apiKeyCreateSchema = z.object({
  name: z.string().trim().min(1).max(120), scopes: z.array(scopeSchema).nonempty(),
  workspace_ids: z.array(z.string().min(1)).nonempty(), rate_limit_rpm: z.number().int().min(1).max(10000).default(60),
  webhook_origins: z.array(z.url({ protocol: /^https?$/ })).default([]),
});
export const apiKeySchema = apiKeyCreateSchema.extend({ id: z.string(), prefix: z.string(), created_at: z.string(), revoked_at: z.string().nullable() });
export const apiKeyPatchSchema = apiKeyCreateSchema.pick({ name:true, scopes:true, workspace_ids:true }).partial().extend({
  rate_limit_rpm:z.number().int().min(1).max(10000).optional(), webhook_origins:z.array(z.url({protocol:/^https?$/})).optional(),
});
export type ApiKey = z.infer<typeof apiKeySchema>;
export const createTaskRequestSchema = z.object({
  workspace_id: z.string().min(1), thread_id: z.string().min(1).optional(), prompt: z.string().trim().min(1).max(100000),
  model_alias: z.string().min(1).optional(), webhook_url: z.url({ protocol: /^https?$/ }).optional(),
});
export const taskStatusSchema = z.enum(["queued","running","completed","failed","cancelled"]);
export const taskAcceptedSchema = z.object({ task_id: z.string(), thread_id: z.string(), status: taskStatusSchema });
export const taskStatusResponseSchema = taskAcceptedSchema.extend({
  workspace_id: z.string(), summary: z.string(), artifacts: z.array(z.object({
    id: z.string(), path: z.string(), download_url: z.string().optional(),
  })), created_at: z.string(), updated_at: z.string(),
});
export const taskSseSchema = z.object({ id: z.number().int().positive(), event: z.string(), data: threadEventSchema });
export type CreateTaskRequest = z.infer<typeof createTaskRequestSchema>;
export type TaskStatusResponse = z.infer<typeof taskStatusResponseSchema>;
export const notificationKindSchema = z.enum(["webhook", "feishu", "telegram", "bark"]);
export const notificationChannelCreateSchema = z.object({
  name: z.string().trim().min(1), type: notificationKindSchema, enabled: z.boolean().default(true),
  config: z.object({ url: z.url({ protocol: /^https?$/ }).optional(), token: z.string().min(1).optional(), chat_id: z.string().min(1).optional() }),
}).refine(c => c.type === "telegram" ? !!(c.config.token && c.config.chat_id) : !!c.config.url);
export const notificationChannelSchema = z.object({ id: z.string(), name: z.string(), type: notificationKindSchema, enabled: z.boolean(), created_at: z.string(), updated_at: z.string() });
export type NotificationChannel = z.infer<typeof notificationChannelSchema>;
