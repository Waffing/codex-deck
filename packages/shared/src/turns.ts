import { z } from "zod";
import { artifactSchema } from "./files.js";
import { taskStatusSchema } from "./phase2.js";
import { timelineItemSchema, turnTelemetrySchema } from "./timeline.js";

/** Public turn IDs are the existing task IDs, independent of the remote Codex thread. */
export const turnSnapshotSchema = z.object({
  id: z.string(), thread_id: z.string(), turn_index: z.number().int().positive(),
  client_msg_id: z.string().nullable(), user_content: z.string(), assistant_markdown: z.string(),
  timeline: z.array(timelineItemSchema), artifacts: z.array(artifactSchema),
  telemetry: turnTelemetrySchema.nullable(), status: taskStatusSchema,
  latest_seq_id: z.number().int().nonnegative(), created_at: z.string(), updated_at: z.string(),
  checkpoint_ref: z.string().nullable(), summary_only: z.boolean(),
  active_answer_items: z.array(z.object({id:z.string(),text:z.string()})).optional(),
});
export const turnPageSchema = z.object({
  turns: z.array(turnSnapshotSchema), has_more: z.boolean(), latest_seq_id: z.number().int().nonnegative(),
  active_turn: turnSnapshotSchema.nullable(),
});
export const turnStepSchema = z.object({
  id:z.string(), detail:z.string(), command:z.string().optional(), stdout:z.string().optional(), stderr:z.string().optional(),
});
export type TurnSnapshot = z.infer<typeof turnSnapshotSchema>;
export type TurnPage = z.infer<typeof turnPageSchema>;
export type TurnStep = z.infer<typeof turnStepSchema>;
