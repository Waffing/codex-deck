import type { FastifyInstance } from "fastify";
import type { ServerContext } from "../app.js";
import { authenticated, createRequireAdmin } from "../auth.js";

export function registerAdminAudit(app:FastifyInstance, ctx:ServerContext) {
  const tables:Record<string,string>={providers:"providers",models:"models","api-keys":"api_keys",deployments:"deployments","notification-channels":"notification_channels"};
  const safeFields=new Set(["alias","enabled","protocol","status","scopes_json","workspace_ids_json","rate_limit_rpm","active_model_alias","revoked_at"]);
  function snapshot(table:string, id:unknown) {
    if(table==="auth") return null;
    if(table==="default") return {alias:ctx.native.prepare("SELECT value FROM settings WHERE key='default_model'").pluck().get() ?? null};
    if(typeof id!=="string") return null;
    const row=ctx.native.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id) as Record<string,unknown>|undefined;
    return row ? Object.fromEntries(Object.entries(row).filter(([key])=>safeFields.has(key))) : null;
  }
  const pending=new WeakMap<object,{table:string;before:ReturnType<typeof snapshot>;id?:string;action:string}>();
  app.addHook("preHandler",async req=>{
    if(!["POST","PUT","PATCH","DELETE"].includes(req.method)) return;
    const route=req.routeOptions.url ?? "";
    const resource=route.split("/")[2] ?? "";
    const table=route==="/api/auth/password"?"auth":route==="/api/models/default"?"default":Object.hasOwn(tables,resource)?tables[resource]:undefined;
    if(!table || !authenticated(ctx,req)) return;
    const id=table==="auth"?"administrator":table==="default"?"default_model":(req.params as {id?:string}).id;
    const operation=(req.body as {action?:unknown}|null)?.action;
    const suffix=route.split("/")[4];
    const action=table==="auth"?"auth.password":table==="default"?"models.default":resource+"."+((typeof operation==="string" && /^(restart|logs|rollback|stop|verify|promote)$/.test(operation)) ? operation : suffix ?? req.method);
    pending.set(req,{table,id,before:snapshot(table,id),action});
  });
  app.addHook("onSend",async(req,reply,payload)=>{
    const item=pending.get(req);
    if (!item) return payload;
    let id=item.id;
    if(!id && typeof payload==="string" && reply.statusCode<300) {
      try { const result=JSON.parse(payload); if(typeof result?.id==="string") id=result.id; } catch { /* empty response */ }
    }
    const details=ctx.masker.maskObject({before:item.before,after:snapshot(item.table,id)});
    ctx.native.prepare("INSERT INTO admin_audit(request_id,action,target,details,status,created_at) VALUES(?,?,?,?,?,?)")
      .run(req.id,item.action,id ? ctx.masker.maskString(id) : null,JSON.stringify(details),reply.statusCode,new Date().toISOString());
    pending.delete(req);
    return payload;
  });
  app.get<{Querystring:{before?:number}}>("/api/admin/audit",{preHandler:createRequireAdmin(ctx)},async req=>{
    const before=Number(req.query.before ?? Number.MAX_SAFE_INTEGER);
    if (!Number.isSafeInteger(before)||before<1) return [];
    return ctx.native.prepare("SELECT * FROM admin_audit WHERE id<? ORDER BY id DESC LIMIT 100").all(before);
  });
}
