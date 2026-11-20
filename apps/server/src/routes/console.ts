import type { FastifyInstance } from "fastify";
import { localImportSchema, usageGroupSchema, type UsageReport } from "@codexdeck/shared";
import { authenticated, createRequireAdmin } from "../auth.js";
import type { ServerContext } from "../app.js";
import type { WorkspaceFiles } from "../files/workspace-files.js";

export function registerConsoleRoutes(app:FastifyInstance,ctx:ServerContext,files:WorkspaceFiles) {
  const db=ctx.native;
  const auth={preHandler:createRequireAdmin(ctx)};
  const exists=(sql:string) => !!db.prepare(sql).get();
  function status(authorized:boolean) {
    return {
      authenticated:authorized,setup_required:!exists("SELECT 1 FROM settings WHERE key='admin_password_hash'"),
      completed:authorized && exists("SELECT 1 FROM settings WHERE key='onboarding_completed' AND value='1'"),
      has_provider:authorized && exists("SELECT 1 FROM providers WHERE enabled=1"),
      has_model:authorized && exists("SELECT 1 FROM models m JOIN providers p ON m.provider_id=p.id WHERE m.enabled=1 AND p.enabled=1"),
      has_workspace:authorized && exists("SELECT 1 FROM workspaces WHERE status='ready'"),
    };
  }
  app.get("/api/onboarding/status",async req=>status(authenticated(ctx,req)));
  app.post("/api/onboarding/complete",auth,async (_req,reply)=>{
    const current=status(true);
    if (!current.has_model || !current.has_workspace) return reply.code(409).send({error:"Configure an enabled model and a ready workspace first."});
    db.prepare("INSERT OR REPLACE INTO settings(key,value,updated_at) VALUES('onboarding_completed','1',?)").run(new Date().toISOString());
    return {completed:true};
  });
  app.get("/api/workspaces/local-directories",auth,async ()=>({directories:await files.availableLocalDirectories()}));
  app.post("/api/workspaces/import",auth,async (req,reply)=>{
    const input=localImportSchema.safeParse(req.body);
    if (!input.success) return reply.code(400).send({error:"Invalid local workspace directory."});
    return reply.code(201).send(await files.importLocal(input.data));
  });
  app.get<{Params:{id:string};Querystring:{before?:string;artifact_before?:string}}>("/api/threads/:id/history",auth,async (req,reply)=>{
    if (!db.prepare("SELECT 1 FROM threads WHERE id=?").get(req.params.id)) return reply.code(404).send({error:"Unknown thread."});
    const before=Number(req.query.before??Number.MAX_SAFE_INTEGER), artifactBefore=Number(req.query.artifact_before??Number.MAX_SAFE_INTEGER);
    if (![before,artifactBefore].every(n=>Number.isSafeInteger(n)&&n>=0)) return reply.code(400).send({error:"Invalid history cursor."});
    const tasks=db.prepare(`SELECT t.rowid cursor,t.id,t.prompt,t.status,t.summary,t.created_at,t.updated_at,c.ref checkpoint_ref
      FROM tasks t LEFT JOIN checkpoints c ON c.turn_id=t.id WHERE t.thread_id=? AND t.rowid<? ORDER BY t.rowid DESC LIMIT 51`).all(req.params.id,before) as {cursor:number}[];
    const artifacts=db.prepare("SELECT rowid cursor,* FROM artifacts WHERE thread_id=? AND rowid<? ORDER BY rowid DESC LIMIT 101").all(req.params.id,artifactBefore) as {cursor:number}[];
    return {tasks:tasks.slice(0,50).reverse(),artifacts:artifacts.slice(0,100).reverse(),
      next_before:tasks.length>50?tasks[49].cursor:null,next_artifact_before:artifacts.length>100?artifacts[99].cursor:null};
  });
  app.get<{Querystring:{group_by?:string}}>("/api/usage",auth,async(req,reply)=>{
    const group=usageGroupSchema.safeParse(req.query.group_by ?? "day");
    if (!group.success) return reply.code(400).send({error:"Invalid group."});
    const expression={day:"substr(u.created_at,1,10)",provider:"coalesce(p.name,u.provider_id,'—')",model:"coalesce(m.alias,u.requested_alias)",workspace:"coalesce(u.workspace_id,'—')",task:"coalesce(u.task_id,'—')"}[group.data];
    const rows=db.prepare(`SELECT ${expression} label, count(*) requests,sum(1-u.usage_known) unknown_usage,sum(u.input_tokens) input_tokens,
      sum(u.output_tokens) output_tokens,sum(u.cost_usd) cost_usd,sum(u.cost_cny) cost_cny
      FROM usage_logs u LEFT JOIN providers p ON p.id=u.provider_id LEFT JOIN models m ON m.id=u.model_id
      GROUP BY ${expression} ORDER BY ${group.data === "day" ? "label DESC" : "requests DESC,label"}`).all() as UsageReport["rows"];
    const totals={requests:0,unknown_usage:0,input_tokens:0,output_tokens:0,cost_usd:0,cost_cny:0};
    for(const row of rows) for(const key of Object.keys(totals) as (keyof typeof totals)[]) totals[key]+=row[key]??0;
    return {rows,totals};
  });
}
