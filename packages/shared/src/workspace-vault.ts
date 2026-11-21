import { z } from "zod";

// These variables control the runner, command lookup, loaders, or management client.
const reserved = /^(?:CODEX.*|DOCKER.*|COMPOSE.*|LD_.*|DYLD_.*|NODE_.*|NODEJS_.*|PYTHON.*|GIT_.*|NPM_CONFIG_.*|PNPM_.*|BASH_.*|BASHOPTS|SHELLOPTS|ENV|IFS|SHELL|PATH|PATHEXT|COMSPEC|SYSTEMROOT|WINDIR|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMDATA|PWD|CDPATH|TMP|TEMP|TMPDIR|PORT|HOST|HOSTNAME|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT_FILE|SSL_CERT_DIR|__PROTO__|CONSTRUCTOR|PROTOTYPE)$/i;
export const workspaceSecretNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)
  .refine(name => !reserved.test(name), "Reserved environment variable.");
const value = z.string().max(32768).refine(text => !text.includes("\0"));
const metadata = z.object({
  key_name: workspaceSecretNameSchema,
  description: z.string().max(512),
  inject_on_verify: z.boolean(),
  inject_on_deploy: z.boolean(),
});
export const workspaceSecretSchema = metadata.extend({
  id: z.string(), workspace_id: z.string(), masked_value: z.string(), created_at: z.string(), updated_at: z.string(),
});
export type WorkspaceSecret = z.infer<typeof workspaceSecretSchema>;
export const workspaceSecretCreateSchema = metadata.partial().required({key_name:true}).extend({value}).strict();
export const workspaceSecretPatchSchema = workspaceSecretCreateSchema.partial().refine(input => Object.keys(input).length > 0);
export const workspaceSecretImportSchema = metadata.pick({inject_on_verify:true,inject_on_deploy:true}).partial()
  .extend({text:z.string().min(1).max(256 * 1024)}).strict();
