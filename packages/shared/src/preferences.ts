import { z } from "zod";
import { automationLevelSchema } from "./files.js";

export const defaultArtifactExtensions = [
  ".docx", ".doc", ".pdf", ".xlsx", ".xls", ".pptx", ".csv", ".png", ".jpg", ".jpeg", ".webp",
  ".svg", ".gif", ".zip", ".tar.gz", ".7z", ".mp3", ".mp4", ".apk", ".dmg", ".exe",
];
export const workbenchPreferencesSchema = z.strictObject({
  lightSkin: z.enum(["white","paper"]).default("white"),
  darkSkin: z.enum(["obsidian","pine"]).default("obsidian"),
  accent: z.string().regex(/^#[a-f\d]{6}$/i).nullable().default(null),
  bodyFont: z.enum(["sans","serif","system"]).default("sans"),
  codeFont: z.enum(["plex","consolas","system"]).default("plex"),
  fontScale: z.union([z.literal(95),z.literal(100),z.literal(108)]).default(100),
  frostedSidebar: z.boolean().default(false),
  artifactMode: z.enum(["smart","all","off"]).default("smart"),
  artifactExtensions: z.array(z.string().toLowerCase().regex(/^\.[a-z0-9]+(?:\.[a-z0-9]+)*$/).max(32)).max(100).default(defaultArtifactExtensions),
  soundStyle: z.enum(["wood","tick","mute"]).default("wood"),
  soundComplete: z.boolean().default(false),
  soundApproval: z.boolean().default(true),
  soundError: z.boolean().default(true),
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
