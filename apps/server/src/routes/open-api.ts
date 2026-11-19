import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ServerResponse } from "node:http";
import { apiKeyCreateSchema, apiKeyPatchSchema, createTaskRequestSchema, type ApiKey, type ThreadEvent } from "@codexdeck/shared";
import type { ServerContext } from "../app.js";
import { createRequireAdmin } from "../auth.js";
import type { WorkspaceFiles } from "../files/workspace-files.js";
import type { ThreadManager } from "../codex/manager.js";
import type { ThreadEvents } from "../ws/events.js";
import { encryptSecret } from "../security/crypto.js";
import { callbackUrl, TaskWebhooks, webhookSecret } from "../notifications/task-webhook.js";

type KeyRow = {id:string; name:string; prefix:string; scopes_json:string; workspace_ids_json:string; rate_limit_rpm:number;
  webhook_origins_json:string; created_at:string; revoked_at:string|null};
type Task = { id:string; workspace_id:string; thread_id:string; status:string; summary:string; created_at:string; updated_at:string };
function keyDto(row:KeyRow): ApiKey {
  return {id:row.id,name:row.name,prefix:row.prefix,scopes:JSON.parse(row.scopes_json),workspace_ids:JSON.parse(row.workspace_ids_json),
    rate_limit_rpm:row.rate_limit_rpm,webhook_origins:JSON.parse(row.webhook_origins_json),created_at:row.created_at,revoked_at:row.revoked_at};
}
function fail(statusCode:number,message:string):never { throw Object.assign(new Error(message),{statusCode}); }
const terminal = (status:string) => ["failed","cancelled","completed"].includes(status);

export function registerOpenApi(app:FastifyInstance,ctx:ServerContext,files:WorkspaceFiles,manager:ThreadManager,events:ThreadEvents) {
  const db = ctx.native;
  const admin = {preHandler:createRequireAdmin(ctx)};
  const webhooks = new TaskWebhooks(ctx);
  const streams = new Set<ServerResponse>();
  app.addHook("preClose",async () => { for (const out of streams) out.end(); });
  app.addHook("onReady", async () => webhooks.start());
  app.addHook("onClose",async () => webhooks.close());
  const counts = new Map<string,{since:number;count:number}>();
  function authorize(req:FastifyRequest, scope:ApiKey["scopes"][number]) {
    const token = /^Bearer (cdk_live_[A-Za-z0-9_-]+)$/.exec(req.headers.authorization ?? "")?.[1];
    if (!token) return fail(401,"Missing API key.");
    const hash = createHash("sha256").update(token).digest("hex");
    const row = db.prepare("SELECT * FROM api_keys WHERE revoked_at IS NULL AND key_hash=?").get(hash) as KeyRow | undefined;
    if (!row) return fail(401,"Invalid API key.");
    const key = keyDto(row);
    const now = Date.now();
    const previous = counts.get(key.id);
    const limit = previous && now-previous.since<60000 ? previous : {since:now,count:0};
    if (++limit.count>key.rate_limit_rpm) return fail(429,"Rate limit reached.");
    counts.set(key.id,limit);
    if (!key.scopes.includes(scope)) return fail(403,"Scope not permitted.");
    return key;
  }
  function workspaceAccess(key:ApiKey, workspace:string) {
    if (!key.workspace_ids.includes(workspace)) fail(403,"Workspace not permitted.");
  }
  function taskFor(key:ApiKey,id:string) {
    const task = db.prepare("SELECT id,workspace_id,thread_id,status,summary,created_at,updated_at FROM tasks WHERE id=?").get(id) as Task | undefined;
    if (!task) return fail(404,"Unknown task.");
    workspaceAccess(key,task.workspace_id);
    return task;
  }

  app.get("/api/api-keys",admin,async () => (db.prepare("SELECT * FROM api_keys").all() as KeyRow[]).map(keyDto));
  app.patch<{Params:{id:string}}>("/api/api-keys/:id",admin,async req => {
    const parsed = apiKeyPatchSchema.safeParse(req.body);
    if (!parsed.success) return fail(400,"Invalid key options.");
    const p = parsed.data;
    if (p.workspace_ids?.some(id => !db.prepare("SELECT 1 FROM workspaces WHERE id=?").get(id))) return fail(400,"Unknown workspace.");
    const updated = db.prepare(`UPDATE api_keys SET name=coalesce(?,name),scopes_json=coalesce(?,scopes_json),
      workspace_ids_json=coalesce(?,workspace_ids_json), rate_limit_rpm=coalesce(?,rate_limit_rpm),
      webhook_origins_json=coalesce(?,webhook_origins_json) WHERE id=? AND revoked_at IS NULL RETURNING *`).get(
      p.name ?? null,p.scopes ? JSON.stringify(p.scopes) : null,p.workspace_ids ? JSON.stringify(p.workspace_ids) : null,
      p.rate_limit_rpm ?? null,p.webhook_origins ? JSON.stringify(p.webhook_origins.map(v=>new URL(v).origin)) : null,req.params.id,
    ) as KeyRow | undefined;
    if (!updated) return fail(404,"Unknown active key.");
    return keyDto(updated);
  });
  app.post("/api/api-keys",admin,async (req,reply) => {
    const parsed = apiKeyCreateSchema.safeParse(req.body);
    if (!parsed.success) return fail(400,"Invalid key options.");
    const options = parsed.data;
    if (options.workspace_ids.some(id=>!db.prepare("SELECT 1 FROM workspaces WHERE id=?").get(id))) return fail(400,"Unknown workspace.");
    const id = randomUUID();
    const token = "cdk_live_" + randomBytes(32).toString("base64url");
    const origins = options.webhook_origins.map(origin => new URL(origin).origin);
    const record = db.prepare(`INSERT INTO api_keys(id,name,key_hash,scopes_json,created_at,prefix,workspace_ids_json,rate_limit_rpm,webhook_origins_json)
      VALUES(?,?,?,?,?,?,?,?,?) RETURNING *`).get(id,options.name,createHash("sha256").update(token).digest("hex"),JSON.stringify(options.scopes),
        new Date().toISOString(),token.slice(0,16),JSON.stringify(options.workspace_ids),options.rate_limit_rpm,JSON.stringify(origins)) as KeyRow;
    const signing = webhookSecret(ctx,id);
    ctx.masker.register(token);
    ctx.masker.register(signing);
    // These two generated values are disclosed to the administrator exactly once.
    return reply.code(201).type("application/json").send(JSON.stringify({...ctx.masker.maskObject(keyDto(record)),api_key:token,webhook_signing_secret:signing}));
  });
  app.delete<{Params:{id:string}}>("/api/api-keys/:id",admin,async (req,reply) => {
    const result = db.prepare("UPDATE api_keys SET revoked_at=? WHERE id=? AND revoked_at IS NULL").run(new Date().toISOString(),req.params.id);
    counts.delete(req.params.id);
    return reply.code(result.changes?204:404).send();
  });

  app.post("/api/v1/tasks",async (req,reply) => {
    const key = authorize(req,"tasks:write");
    const parsed = createTaskRequestSchema.safeParse(req.body);
    if (!parsed.success) return fail(400,"Invalid task.");
    const input = parsed.data;
    workspaceAccess(key,input.workspace_id);
    if (input.webhook_url) {
      try { callbackUrl(input.webhook_url,key.webhook_origins); }
      catch { return fail(400,"Webhook origin not permitted."); }
    }
    let threadId = input.thread_id;
    if (threadId) {
      const found = db.prepare("SELECT workspace_id,active_model_alias FROM threads WHERE id=?").get(threadId) as {workspace_id:string;active_model_alias:string} | undefined;
      if (!found || found.workspace_id !== input.workspace_id) return fail(403,"Thread outside workspace.");
      if (input.model_alias && found.active_model_alias !== input.model_alias) {
        manager.setModel(threadId,input.model_alias);
      }
    } else threadId = (await manager.createThread(input.workspace_id,input.model_alias)).id;
    const result = manager.submit(threadId,input.prompt);
    db.prepare("UPDATE tasks SET api_key_id=?,webhook_url=?,webhook_state=? WHERE id=?").run(key.id,
      input.webhook_url?encryptSecret(input.webhook_url,ctx.masterKey):null,input.webhook_url?"pending":null,result.task_id);
    return reply.code(202).send(result);
  });
  app.get<{Params:{id:string}}>("/api/v1/tasks/:id",async req => {
    const key = authorize(req,"tasks:read");
    const task = taskFor(key,req.params.id);
    const artifacts = db.prepare("SELECT id,path FROM artifacts WHERE workspace_id=? AND thread_id=? AND turn_id=?")
      .all(task.workspace_id,task.thread_id,task.id) as {id:string;path:string}[];
    return {task_id:task.id,thread_id:task.thread_id,workspace_id:task.workspace_id,status:task.status,summary:task.summary,
      created_at:task.created_at,updated_at:task.updated_at,artifacts: artifacts.map(a=>({
        ...a,...(key.scopes.includes("files:download") ? {download_url:files.signArtifact(a.id)} : {}),
      }))};
  });
  app.post<{Params:{id:string}}>("/api/v1/tasks/:id/cancel",async (req,reply) => {
    const task = taskFor(authorize(req,"tasks:write"),req.params.id);
    await manager.cancel(task.id);
    return reply.code(202).send({task_id:task.id});
  });
  app.get<{Params:{id:string}}>("/api/v1/tasks/:id/stream",async (req,reply) => {
    const key = authorize(req,"tasks:read");
    const task = taskFor(key,req.params.id);
    const after = Number(req.headers["last-event-id"] ?? 0);
    if (!Number.isSafeInteger(after) || after<0) return fail(400,"Invalid event cursor.");
    reply.hijack();
    const out = reply.raw;
    streams.add(out);
    out.writeHead(200,{"content-type":"text/event-stream","cache-control":"no-cache","x-accel-buffering":"no"});
    out.flushHeaders();
    const permitted = () => {
      const row = db.prepare("SELECT * FROM api_keys WHERE id=? AND revoked_at IS NULL").get(key.id) as KeyRow | undefined;
      if (!row) return false;
      const current = keyDto(row);
      return current.scopes.includes("tasks:read") && current.workspace_ids.includes(task.workspace_id);
    };
    const send = (event:ThreadEvent) => {
      if (out.destroyed || out.writableEnded) return;
      if (!permitted()) { out.end(); return; }
      if (out.writableLength>2*1024*1024) {out.destroy(); return;}
      out.write("id: "+event.seq_id+"\nevent: "+event.type.replace(/[\r\n]/g,"")+"\ndata: "+JSON.stringify(event)+"\n\n");
      if (["task_completed","task_failed","task_cancelled"].includes(event.type)) out.end();
    };
    const off = events.follow(task.thread_id,after,send,task.id);
    if (terminal(task.status) && !out.writableEnded) out.end();
    const heartbeat = setInterval(() => {
      if (!permitted()) {out.end(); return;}
      out.write(": heartbeat\n\n");
    },10000);
    heartbeat.unref();
    out.once("close",()=>{streams.delete(out);off();clearInterval(heartbeat);});
  });
}
