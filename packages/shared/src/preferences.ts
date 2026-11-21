import { z } from "zod";
import { automationLevelSchema } from "./files.js";

export const workbenchPreferencesSchema = z.strictObject({
  theme: z.enum(["system", "light", "dark"]).default("system"),
  compactBubbles: z.boolean().default(false),
  expandTimeline: z.boolean().default(false),
  telemetry: z.boolean().default(true),
  minimap: z.boolean().default(true),
  debug: z.boolean().default(false),
  sendShortcut: z.enum(["enter", "ctrl_enter"]).default("enter"),
  contextThreshold: z.number().int().min(1).max(100).default(80),
  automationLevel: automationLevelSchema.default("conservative"),
  approvalTimeoutSeconds: z.number().int().min(10).max(86400).default(600),
});
export type WorkbenchPreferences = z.infer<typeof workbenchPreferencesSchema>;
