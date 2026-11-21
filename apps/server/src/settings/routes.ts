import type { FastifyInstance } from "fastify";
import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { workbenchPreferencesSchema, type WorkbenchPreferences } from "@codexdeck/shared";
import type { ThreadManager } from "../codex/manager.js";
import type { ServerContext } from "../app.js";
import { createRequireAdmin } from "../auth.js";
import { adminAuthorized } from "../security/emergency.js";
import { workspaceDirectory, workspaceFile } from "../security/paths.js";
import {clientIp} from "../security/ingress.js";
import {resetPanelDefaults} from "./defaults.js";
import {executionStatus,requireExecutor,saveExecutorImage} from "../codex/execution-environment.js";
import { readPreferences, patchPreferences } from "./preferences.js";

export function registerSettingsRoutes(app:FastifyInstance, ctx:ServerContext, manager:ThreadManager, dataDirectory:string) {
  const admin={preHandler:createRequireAdmin(ctx)};
  app.get("/api/settings/executor",admin,async()=>executionStatus(ctx.native));
  app.post("/api/settings/executor/detect",admin,async()=>executionStatus(ctx.native,true));
  app.patch<{Body:{image?:string}}>("/api/settings/executor",admin,async req=>{
    saveExecutorImage(ctx.native,req.body?.image);
    return executionStatus(ctx.native);
  });
  app.get("/api/settings/preferences",admin,async()=>readPreferences(ctx.native));
  app.patch("/api/settings/preferences",admin,async(req,reply)=>{
    const body=req.body;
    if (!body || typeof body !== "object" || Array.isArray(body) ||
      !workbenchPreferencesSchema.safeParse({...readPreferences(ctx.native),...body}).success)
      return reply.code(400).send({error:"Invalid preferences."});
    const patch=body as Partial<WorkbenchPreferences>;
    if(patch.automationLevel==="unrestricted")await requireExecutor(ctx.native);
    return patchPreferences(ctx.native,patch);
  });
  app.post("/api/settings/preferences/reset",admin,async()=>patchPreferences(ctx.native,workbenchPreferencesSchema.parse({})));

  app.get("/api/admin/runtime/tasks",async(req,reply)=>{
    if (!adminAuthorized(ctx,req)) return reply.code(401).send({error:"Administrator required."});
    return manager.runtimeTasks();
  });
  app.post<{Params:{threadId:string}}>("/api/admin/runtime/tasks/:threadId/kill",async(req,reply)=>{
    if (!adminAuthorized(ctx,req)) return reply.code(401).send({error:"Administrator required."});
    const result=await manager.killTask(req.params.threadId);
    ctx.native.prepare("INSERT INTO admin_audit(request_id,action,target,details,status,created_at) VALUES(?,?,?,'{}',200,?)")
      .run(req.id,"runtime.kill",result.task_id,new Date().toISOString());
    return result;
  });
  app.post("/api/settings/reset",admin,async(req)=>resetPanelDefaults(ctx,"admin",clientIp(req)));

  let exporting=false;
  app.get("/api/settings/backup",admin,async(_req,reply)=>{
    if (exporting) return reply.code(409).send({error:"A database backup is already in progress."});
    exporting=true;
    let folder:string|undefined;
    const cleanup=async()=>{
      try { if(folder) await rm(folder,{recursive:true,force:true}); }
      finally { exporting=false; }
    };
    try {
      const root=await workspaceDirectory(path.dirname(path.resolve(dataDirectory)),path.resolve(dataDirectory));
      folder=await mkdtemp(path.join(root,".backup-"));
      const file=await workspaceFile(root,path.join(folder,"codexdeck.sqlite"));
      await ctx.native.backup(file);
      const output=createReadStream(await workspaceFile(root,file));
      output.once("close",()=>{void cleanup().catch(()=>{});});
      return reply.type("application/vnd.sqlite3").header("Cache-Control","no-store")
        .header("Content-Disposition",'attachment; filename="codexdeck.sqlite"').send(output);
    } catch(err) { await cleanup(); throw err; }
  });
}
