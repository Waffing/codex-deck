import type { FastifyInstance } from "fastify";
import { agentsScopeSchema, agentsDocumentSchema, gitDiffQuerySchema, workspaceCloneSchema, workspaceCreateSchema } from "@codexdeck/shared";
import type { ServerContext } from "../app.js";
import { scopedAccess, scopedGuest } from "../temp-access/routes.js";
import type { WorkspaceFiles } from "../files/workspace-files.js";
import { fileError } from "../files/sandbox.js";
import {requireExecutor} from "../codex/execution-environment.js";
import {readPreferences} from "../settings/preferences.js";
import { readEditable, writeEditable } from "../files/editor.js";
import {verifyGateConfigSchema} from "@codexdeck/shared";
import {createRequireAdmin} from "../auth.js";
import {detectVerifyCommands,readVerifyConfig} from "../codex/verify-gate.js";

export function registerWorkspaceRoutes(app: FastifyInstance, ctx: ServerContext, files: WorkspaceFiles) {
  const auth = scopedAccess(ctx);
  type ById = { Params: { id: string } };
  const admin={preHandler:createRequireAdmin(ctx)};
  app.get<ById>("/api/workspaces/:id/quality",admin,async req=>ctx.masker.maskObject(readVerifyConfig(ctx,req.params.id)));
  app.patch<ById>("/api/workspaces/:id/quality",admin,async req=>{
    const prior=readVerifyConfig(ctx,req.params.id);
    const input=verifyGateConfigSchema.partial().strict().safeParse(req.body);
    if(!input.success) throw fileError(400,"Invalid quality settings.");
    const cfg={...prior,...input.data};
    if(cfg.auto_verify_enabled && !cfg.verify_commands.length) throw fileError(400,"Configure at least one verification command.");
    if(cfg.verify_commands.some(cmd=>cmd.includes("\0") || ctx.masker.maskString(cmd)!==cmd)) throw fileError(400,"Use environment references in verification commands.");
    if(cfg.review_model_alias && !ctx.native.prepare("SELECT id FROM models WHERE alias=? AND enabled").get(cfg.review_model_alias)) throw fileError(400,"Invalid review model.");
    ctx.native.prepare("UPDATE workspaces SET auto_verify_enabled=?,verify_network_enabled=?,verify_commands_json=?,max_self_heal_retries=?,review_model_alias=?,updated_at=? WHERE id=?")
      .run(+cfg.auto_verify_enabled,+cfg.verify_network_enabled,JSON.stringify(cfg.verify_commands),cfg.max_self_heal_retries,cfg.review_model_alias,new Date().toISOString(),req.params.id);
    return cfg;
  });
  app.post<ById>("/api/workspaces/:id/verify-commands/detect",admin,async req=>({commands:await detectVerifyCommands(await files.getRoot(req.params.id))}));
  app.get("/api/workspaces", auth, async req => {
    const guest=scopedGuest(req);
    return guest ? files.list().filter(w=>guest.link.workspace_ids.includes(w.id)).map(({path:_path,...w})=>w) : files.list();
  });
  app.patch<ById>("/api/workspaces/:id",auth,async req=>{
    const p=workspaceCreateSchema.pick({automation_level:true}).required().strict().safeParse(req.body);
    if (!p.success || !(req.body && typeof req.body==="object" && "automation_level" in req.body)) throw fileError(400,"Invalid automation level.");
    if (p.data.automation_level==="unrestricted") await requireExecutor(ctx.native);
    const row=ctx.native.prepare("UPDATE workspaces SET automation_level=?,updated_at=? WHERE id=? RETURNING *")
      .get(p.data.automation_level,new Date().toISOString(),req.params.id);
    if (!row) throw fileError(404,"Workspace not found.");
    return row;
  });
  app.post("/api/workspaces", auth, async (req, reply) => {
    const p = workspaceCreateSchema.safeParse({automation_level:readPreferences(ctx.native).automationLevel,...(req.body as object)});
    if (!p.success) throw fileError(400, "Invalid workspace.");
    if (p.data.automation_level==="unrestricted") await requireExecutor(ctx.native);
    return reply.code(201).send(await files.create(p.data.name, p.data.automation_level));
  });
  app.post("/api/workspaces/clone", auth, async (req, reply) => {
    const p = workspaceCloneSchema.safeParse({automation_level:readPreferences(ctx.native).automationLevel,...(req.body as object)});
    if (!p.success) throw fileError(400, "Invalid repository.");
    const url = new URL(p.data.url);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw fileError(400, "Invalid repository URL.");
    if (p.data.automation_level==="unrestricted") await requireExecutor(ctx.native);
    return reply.code(202).send(await files.create(p.data.name, p.data.automation_level, url));
  });
  app.delete<ById>("/api/workspaces/:id", auth, async (req, reply) => {
    await files.unregister(req.params.id);
    return reply.code(204).send();
  });
  app.get<ById & { Querystring: { scope?: string } }>("/api/workspaces/:id/agents-md", auth, async req => {
    const p = agentsScopeSchema.safeParse(req.query.scope);
    if (!p.success) throw fileError(400, "Invalid scope.");
    const root = await files.instructionRoot(req.params.id,p.data);
    try { return {scope:p.data,...await readEditable(root,"AGENTS.md",ctx.masker)}; }
    catch (e) { if ((e as {statusCode?:number}).statusCode !== 404) throw e; }
    return {scope:p.data,content:"",revision:"missing",read_only:false};
  });
  app.put<ById & { Querystring: { scope?: string }; Body: { scope?: string; content: string } }>("/api/workspaces/:id/agents-md", auth, async req => {
    const p = agentsDocumentSchema.safeParse({ scope: req.query.scope ?? req.body?.scope, content: req.body?.content });
    if (!p.success) throw fileError(400, "Invalid instructions.");
    const root = await files.instructionRoot(req.params.id,p.data.scope);
    const revision = await writeEditable(root,"AGENTS.md",p.data.content,req.headers["if-match"],ctx.masker);
    ctx.native.prepare("INSERT OR REPLACE INTO settings VALUES('modules.instructions.revision',?,?)").run(revision,new Date().toISOString());
    return {...p.data,revision};
  });
  app.get<ById>("/api/workspaces/:id/git/status", auth, async req => ctx.masker.maskObject(await files.track(req.params.id, "status")));
  app.get<ById & { Querystring: { format?: string } }>("/api/workspaces/:id/git/diff", auth, async (req, reply) => {
    const p = gitDiffQuerySchema.safeParse(req.query);
    if (!p.success) throw fileError(400, "Invalid diff format.");
    const patch = ctx.masker.maskString(await files.track(req.params.id, "diff"));
    if (p.data.format === "patch") return reply.type("text/x-patch").header("Content-Disposition",'attachment; filename="changes.patch"').send(patch);
    return { diff: patch };
  });
  app.post<{ Params: { id: string; ref: string } }>("/api/workspaces/:id/checkpoints/:ref/restore", auth, async req => {
    await files.restore(req.params.id, req.params.ref);
    return { restored: true };
  });
}
