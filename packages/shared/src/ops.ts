import { z } from "zod";

export const serverProfileSchema = z.object({
  checked_at: z.string(), os: z.string(), cpu_count: z.number(), load_average: z.array(z.number()),
  total_memory: z.number(), free_memory: z.number(), disk_free: z.number(),
  runtimes: z.record(z.string(), z.string().nullable()), occupied_ports: z.array(z.number().int()),
  docker_available: z.boolean(), port_inventory_available: z.boolean(), safe_pool: z.tuple([z.number(), z.number()]), available_ports: z.array(z.number().int()),
});
export type ServerProfile = z.infer<typeof serverProfileSchema>;
export const deploymentSchema = z.object({
  preview_url:z.string().optional(),live_url:z.string().nullable().optional(),
  last_verification:z.object({ok:z.boolean(),checked_at:z.string()}).nullable().optional(),
  id: z.string(), workspace_id: z.string(), status: z.enum(["starting","staging","live","rolled_back","stopped","failed"]),
  mode: z.enum(["local","docker","compose"]), port: z.number().int(), created_at: z.string(), updated_at: z.string(),
  previous_id: z.string().nullable(),
});
export type Deployment = z.infer<typeof deploymentSchema>;
const deploymentId = z.string().uuid();
const pathOnly = z.string().max(4096).regex(/^\/(?!\/)/).refine(s => !s.includes("\\") && !/[\x00-\x20]/.test(s));
export const verificationInput = z.object({
  deployment_id: deploymentId, path: pathOnly.default("/"), expected_content: z.string().max(2048).optional(), check_browser: z.boolean().default(false),
}).strict();
export const stagingInput = z.object({
  mode: z.enum(["auto","local","docker","compose"]).default("auto"),
  public_dir: z.string().min(1).default("public"),
  entry: z.string().min(1).max(240).optional(),
  args: z.array(z.string().max(512)).max(32).default([]),
  image: z.string().regex(/^[a-z0-9][a-z0-9._/:@-]{0,220}$/).optional(),
  container_port: z.number().int().min(1).max(65535).default(8080),
  reserved_port: z.number().int().min(1).max(65535).optional(),
}).strict();
export const opsTools = {
  server_inspect: z.object({}).strict(), port_allocate: z.object({}).strict(),
  app_deploy_staging: stagingInput, app_logs: z.object({ deployment_id: deploymentId }).strict(),
  verify_url: verificationInput, app_promote_live: verificationInput, app_rollback: z.object({deployment_id: deploymentId}).strict(),
};
export const deploymentActionSchema = z.object({
  action: z.enum(["promote","rollback","logs","stop","verify","restart"]), path: pathOnly.default("/"),
  expected_content: z.string().max(2048).optional(), check_browser: z.boolean().default(false),
}).strict();
export type OpsTool = keyof typeof opsTools;
export type StageInput = z.infer<typeof stagingInput>;
export type VerifyInput = z.infer<typeof verificationInput>;
