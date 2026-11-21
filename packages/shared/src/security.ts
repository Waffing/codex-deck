import { z } from "zod";

export const alertEventSchema=z.enum(["new_device","login_ban","totp_changed","guest_online","guest_exhausted"]);
export const securityConfigSchema=z.object({
  public_enabled:z.boolean(), entry_enabled:z.boolean(),
  entry_path:z.string().regex(/^\/[A-Za-z0-9_-]{8,64}$/),
  disguise:z.enum(["nginx_404","blank_200","forbidden_403"]),
  brute_force_enabled:z.boolean(), max_failures:z.number().int().min(1).max(100),
  ban_minutes:z.number().int().min(1).max(10080), captcha_enabled:z.boolean(),
  ip_mode:z.enum(["off","allow","deny"]), ip_ranges:z.array(z.string().min(1).max(64)).max(256),
  session_hours:z.union([z.literal(2),z.literal(24),z.literal(168),z.literal(720)]),
  single_session:z.boolean(), basic_enabled:z.boolean(), basic_user:z.string().regex(/^[a-zA-Z0-9_.-]{1,64}$/),
  totp_enabled:z.boolean(), alerts:z.array(alertEventSchema).max(5)
});
export const securityPatchSchema=securityConfigSchema.omit({totp_enabled:true}).partial()
  .extend({basic_password:z.string().min(12).max(256).optional()}).strict();
export type SecurityConfig=z.infer<typeof securityConfigSchema>;
export type SecurityPatch=z.infer<typeof securityPatchSchema>;