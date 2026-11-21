import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { workspaceSecretCreateSchema, workspaceSecretImportSchema, workspaceSecretPatchSchema,
  workspaceSecretNameSchema, type WorkspaceSecret } from "@codexdeck/shared";
import type { ServerContext } from "../app.js";
import { createRequireAdmin } from "../auth.js";
import { decryptSecret, encryptSecret } from "./crypto.js";

type StoredSecret = Omit<WorkspaceSecret, "masked_value" | "inject_on_verify" | "inject_on_deploy"> & {
  value_enc: string; inject_on_verify: number; inject_on_deploy: number;
};
type VaultContext = Pick<ServerContext, "native" | "masterKey" | "masker">;
const fail = (statusCode: number, message: string): never => { throw Object.assign(new Error(message), {statusCode}); };

export function registerWorkspaceSecret(ctx: Pick<VaultContext,"masker">, value: string) {
  ctx.masker.register(value);
  // Process output and event logs can deliver multiline credentials one line at a time.
  if (/[\r\n]/.test(value)) for (const line of value.split(/[\r\n]+/)) ctx.masker.register(line);
}

export function registerStoredWorkspaceSecrets(ctx: VaultContext) {
  for (const row of ctx.native.prepare("SELECT value_enc FROM workspace_secrets").iterate() as Iterable<{value_enc:string}>) {
    registerWorkspaceSecret(ctx, decryptSecret(row.value_enc, ctx.masterKey));
  }
}

export function workspaceSecretNames(ctx: VaultContext, workspaceId: string): string[] {
  return ctx.native.prepare("SELECT key_name FROM workspace_secrets WHERE workspace_id=? ORDER BY key_name")
    .pluck().all(workspaceId) as string[];
}

export function workspaceSecretEnv(ctx: VaultContext, workspaceId: string, scope: "verify" | "deploy"): Record<string,string> {
  const flag = scope === "verify" ? "inject_on_verify" : "inject_on_deploy";
  const rows = ctx.native.prepare("SELECT key_name,value_enc FROM workspace_secrets WHERE workspace_id=? AND " + flag + "=1").all(workspaceId) as StoredSecret[];
  return Object.fromEntries(rows.map(row => [workspaceSecretNameSchema.parse(row.key_name), decryptSecret(row.value_enc, ctx.masterKey)]));
}

function dto(ctx: VaultContext, row: StoredSecret): WorkspaceSecret {
  const value = decryptSecret(row.value_enc, ctx.masterKey);
  const description = row.description ? ctx.masker.maskString(decryptSecret(row.description,ctx.masterKey)) : "";
  return {id:row.id, workspace_id:row.workspace_id, key_name:row.key_name, description,
    created_at:row.created_at, updated_at:row.updated_at, inject_on_verify:!!row.inject_on_verify, inject_on_deploy:!!row.inject_on_deploy,
    masked_value: "••••" + (value.length > 4 ? value.slice(-4) : "")};
}

// Parse literal .env assignments, including quoted multiline values. Never evaluate substitutions.
function parseDotEnv(text: string): Map<string,string> {
  const source = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = source.split("\n");
  const entries = new Map<string,string>();
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n].trimStart();
    if (!line || line.startsWith("#")) continue;
    const assignment = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!assignment) return fail(400, "Invalid .env assignment at line " + (n + 1) + ".");
    const [, name, raw] = assignment;
    let value = raw;
    if (value.startsWith('"') || value.startsWith("'") || value.startsWith("`")) {
      const quote = value[0];
      value = value.slice(1);
      let end = value.indexOf(quote);
      while (end < 0 && n + 1 < lines.length) {
        const offset = value.length;
        value += "\n" + lines[++n];
        end = value.indexOf(quote, offset);
      }
      if (end < 0 || !/^\s*(?:#.*)?$/.test(value.slice(end + 1))) fail(400, "Invalid quoted .env value.");
      value = value.slice(0, end);
      if (quote === '"') value = value.replace(/\\n/g, "\n");
    } else value = value.split("#", 1)[0].trimEnd();
    if (!workspaceSecretCreateSchema.safeParse({key_name:name,value}).success || entries.has(name)) {
      fail(400, "Invalid or duplicate .env key.");
    }
    entries.set(name, value);
  }
  if (!entries.size) fail(400, "Provide at least one .env assignment.");
  return entries;
}

export function registerWorkspaceSecretRoutes(app: FastifyInstance, ctx: ServerContext) {
  const admin = {preHandler:createRequireAdmin(ctx)};
  const base = "/api/workspaces/:id/secrets";
  type Workspace = {Params:{id:string}};
  type Item = {Params:{id:string;secretId:string}};
  const ensureWorkspace = (id:string) => {
    if (!ctx.native.prepare("SELECT 1 FROM workspaces WHERE id=?").get(id)) fail(404, "Workspace not found.");
  };
  const find = (workspace:string, id:string) => ctx.native.prepare("SELECT * FROM workspace_secrets WHERE workspace_id=? AND id=?")
    .get(workspace,id) as StoredSecret | undefined;
  const existing = (workspace:string, name:string) => ctx.native.prepare("SELECT * FROM workspace_secrets WHERE workspace_id=? AND key_name=?")
    .get(workspace,name) as StoredSecret | undefined;

  type Input = {key_name?:string; value?:string; description?:string; inject_on_verify?:boolean; inject_on_deploy?:boolean};
  function save(workspace:string, input:Input, old?:StoredSecret) {
    const id = old?.id ?? randomUUID();
    const now = new Date().toISOString();
    const name = input.key_name ?? old!.key_name;
    const envelope = input.value === undefined ? old!.value_enc : encryptSecret(input.value, ctx.masterKey);
    const verify = Number(input.inject_on_verify ?? old?.inject_on_verify ?? false);
    const deploy = Number(input.inject_on_deploy ?? old?.inject_on_deploy ?? false);
    if (input.value !== undefined) registerWorkspaceSecret(ctx, input.value);
    const description = input.description === undefined ? old?.description ?? "" :
      input.description && encryptSecret(ctx.masker.maskString(input.description),ctx.masterKey);
    ctx.native.prepare(`INSERT INTO workspace_secrets(id,workspace_id,key_name,value_enc,description,inject_on_verify,inject_on_deploy,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET key_name=excluded.key_name,value_enc=excluded.value_enc,description=excluded.description,
      inject_on_verify=excluded.inject_on_verify,inject_on_deploy=excluded.inject_on_deploy,updated_at=excluded.updated_at`)
      .run(id,workspace,name,envelope,description,verify,deploy,old?.created_at ?? now,now);
    return id;
  }
  // An administrator may have pasted a value into a description before importing it as a secret.
  // Remove it permanently so a subsequent key rotation or deletion cannot reveal it.
  function redactDescriptions() {
    const rows=ctx.native.prepare("SELECT id,description FROM workspace_secrets WHERE description<>''").all() as {id:string;description:string}[];
    const update=ctx.native.prepare("UPDATE workspace_secrets SET description=? WHERE id=?");
    for(const row of rows) {
      const text=decryptSecret(row.description,ctx.masterKey), masked=ctx.masker.maskString(text);
      if(masked!==text) update.run(encryptSecret(masked,ctx.masterKey),row.id);
    }
  }

  app.get<Workspace>(base, admin, async (req,reply) => {
    ensureWorkspace(req.params.id);
    reply.header("Cache-Control","private, no-store");
    return (ctx.native.prepare("SELECT * FROM workspace_secrets WHERE workspace_id=? ORDER BY key_name")
      .all(req.params.id) as StoredSecret[]).map(row => dto(ctx,row));
  });
  app.post<Workspace>(base, admin, async (req,reply) => {
    ensureWorkspace(req.params.id);
    const parsed = workspaceSecretCreateSchema.safeParse(req.body);
    if (!parsed.success) return fail(400, "Invalid secret fields or reserved environment name.");
    if (existing(req.params.id,parsed.data.key_name)) return fail(409, "Key name already exists.");
    const id = ctx.native.transaction(() => {
      const result = save(req.params.id,parsed.data);
      if(parsed.data.value) redactDescriptions();
      return result;
    })();
    return reply.code(201).send(dto(ctx,find(req.params.id,id)!));
  });
  app.patch<Item>(base+"/:secretId", admin, async req => {
    const old = find(req.params.id,req.params.secretId) ?? fail(404, "Secret not found.");
    const parsed = workspaceSecretPatchSchema.safeParse(req.body);
    if (!parsed.success) return fail(400, "Invalid secret fields or reserved environment name.");
    const name = parsed.data.key_name;
    if (name && name !== old.key_name && existing(req.params.id,name)) return fail(409, "Key name already exists.");
    ctx.native.transaction(() => {
      save(req.params.id, parsed.data, old);
      if(parsed.data.value) redactDescriptions();
    })();
    return dto(ctx,find(req.params.id,old.id)!);
  });
  app.delete<Item>(base+"/:secretId", admin, async (req,reply) => {
    if (!ctx.native.prepare("DELETE FROM workspace_secrets WHERE workspace_id=? AND id=?").run(req.params.id,req.params.secretId).changes) {
      return fail(404, "Secret not found.");
    }
    return reply.code(204).send();
  });
  app.post<Workspace>(base+"/import", admin, async req => {
    ensureWorkspace(req.params.id);
    const parsed = workspaceSecretImportSchema.safeParse(req.body);
    if (!parsed.success) return fail(400, "Invalid .env import settings.");
    const {text, ...flags} = parsed.data;
    const entries = parseDotEnv(text);
    ctx.native.transaction(() => {
      for (const [name,value] of entries) save(req.params.id,{key_name:name,value,...flags},existing(req.params.id,name));
      redactDescriptions();
    })();
    return {imported:entries.size};
  });
}
