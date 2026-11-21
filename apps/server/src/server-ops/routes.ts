import type { AddressInfo } from "node:net";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { serverProfileSchema, deploymentActionSchema, opsTools, type OpsTool, type ServerProfile } from "@codexdeck/shared";
import type { ServerContext } from "../app.js";
import { createRequireAdmin } from "../auth.js";
import type { WorkspaceFiles } from "../files/workspace-files.js";
import { repositoryRoot, workspaceDirectory } from "../security/paths.js";
import { verifySignedPayload } from "../security/crypto.js";
import { PortPool, fail, probeServer } from "./probe.js";
import { Deployer,type OpsOptions } from "./deployer.js";
import { registerPreview } from "./preview-proxy.js";
import {taskLink} from "../temp-access/service.js";
import {scopedGuest} from "../temp-access/routes.js";
import {hasIsolatedRunner} from "../codex/isolated-runner.js";

interface Events {append(thread:string,type:string,payload:unknown):unknown}
interface Approver {requestOpsApproval(thread:string,tool:string,payload:Record<string,unknown>):Promise<unknown>}

export function registerOps(app:FastifyInstance,ctx:ServerContext,files:WorkspaceFiles,events:Events,manager:Approver,options:OpsOptions) {
  let profile:ServerProfile;
  let refresh:Promise<ServerProfile>|undefined;
  const pool=new PortPool(options.portPool ?? [10000,19999],()=> (app.server.address() as AddressInfo|null)?.port ?? ctx.gatewayConfig.port);
  const root=options.workspaceRoot ?? repositoryRoot;
  const dataRoot=path.isAbsolute(options.dataDirectory) ? path.dirname(options.dataDirectory) : root;
  const deployer=new Deployer(ctx,files,pool,options,root);
  const admin={preHandler:createRequireAdmin(ctx)};
  function probe() {
    refresh ??= workspaceDirectory(dataRoot,options.dataDirectory).then(dir=>probeServer(dir,dataRoot,pool))
      .then(result=>(profile=serverProfileSchema.parse(result))).finally(()=>{refresh=undefined;});
    return refresh;
  }
  function getProfile() {
    if(!profile) throw fail(503,"Server profile is not ready.");
    return profile;
  }
  app.addHook("onReady",async()=>{await probe();await deployer.recover();});
  app.addHook("onClose",async()=>deployer.close());
  app.get("/api/server/profile",admin,async()=>getProfile());
  app.get("/api/runtime/capabilities",admin,async()=>({isolated_executor:await hasIsolatedRunner(),
    deployment:getProfile().docker_available || process.env.NODE_ENV!=="production" || process.env.CODEXDECK_ALLOW_LOCAL_DEPLOYMENTS==="true"}));
  app.post("/api/server/probe",admin,probe);
  app.get("/api/deployments",admin,async()=>deployer.rows().map(row=>deployer.dto(row)));
  app.get("/api/guest/previews",async(req,reply)=>{
    const guest=scopedGuest(req);
    if(!guest)return reply.code(403).send({error:"Guest login required."});
    return deployer.rows().filter(row=>guest.link.workspace_ids.includes(row.workspace_id) && ["staging","live","rolled_back"].includes(row.status))
      .map(row=>{const {id,workspace_id,status,preview_url,live_url}=deployer.dto(row);return {id,workspace_id,status,preview_url,live_url};});
  });
  app.post<{Params:{id:string}}>("/api/deployments/:id/action",admin,async(req,reply)=>{
    const result=deploymentActionSchema.safeParse(req.body);
    if(!result.success) return reply.code(400).send({error:"Invalid deployment action."});
    const {action,...verify}=result.data;
    const id=req.params.id;
    switch(action) {
      case "restart":return deployer.restart(id);
      case "logs":return {logs:await deployer.logs(id)};
      case "rollback":return deployer.rollback(id);
      case "stop":return deployer.stop(id);
      case "verify":return deployer.verify({deployment_id:id,...verify});
      case "promote":return deployer.promote({deployment_id:id,...verify});
    }
  });
  app.post<{Params:{tool:string}}>("/internal/ops/:tool",async(req,reply)=>{
    const remote=req.raw.socket.remoteAddress ?? "";
    const bearer=/^Bearer (\S+)$/i.exec(req.headers.authorization ?? "")?.[1];
    const credential=bearer?.startsWith("cdlease_") ? ctx.resolveSessionLease?.(bearer,"ops") : bearer;
    const claims=credential && verifySignedPayload(credential,ctx.masterKey);
    const now=Math.floor(Date.now()/1000);
    if(!["::1","127.0.0.1","::ffff:127.0.0.1"].includes(remote) || !claims || claims.aud!=="codexdeck-ops" ||
      typeof claims.thread_id!=="string" || typeof claims.exp!=="number" || claims.exp<=now || typeof claims.iat!=="number" ||
      claims.iat>now+30 || claims.exp-claims.iat>86400) return reply.code(401).send({error:"Invalid local ops token."});
    const thread=claims.thread_id;
    const authorizedTask=()=>{
      const guest=taskLink(ctx,typeof claims.task_id==="string"?claims.task_id:undefined);
      if(guest && (guest.status!=="active" || guest.permission!=="full_with_approval" || req.params.tool!=="app_deploy_staging")) return false;
      return claims.task_id===undefined || (typeof claims.task_id==="string" &&
        !!ctx.native.prepare("SELECT 1 FROM tasks WHERE id=? AND thread_id=? AND status='running'").get(claims.task_id,thread));
    };
    if(!authorizedTask()) {
      return reply.code(401).send({error:"Task authorization expired."});
    }
    const row=ctx.native.prepare("SELECT workspace_id FROM threads WHERE id=?").get(thread) as {workspace_id:string}|undefined;
    if(!row?.workspace_id) return reply.code(403).send({error:"Ops token has no active workspace."});
    const workspace=row.workspace_id;
    if(!Object.hasOwn(opsTools,req.params.tool)) return reply.code(404).send({error:"Unknown operation."});
    const tool=req.params.tool as OpsTool;
    const parsed=opsTools[tool].safeParse(req.body ?? {});
    if(!parsed.success) return reply.code(400).send({error:"Invalid tool arguments."});
    const args=parsed.data as Record<string,unknown>;
    if(typeof args.deployment_id==="string") deployer.get(args.deployment_id,workspace);
    events.append(thread,"ops_requested",{tool,arguments:args});
    try {
      if(["app_promote_live","app_rollback","app_deploy_staging","port_allocate"].includes(tool)) {
        const decision=await manager.requestOpsApproval(thread,tool,args);
        if(decision!==true) throw fail(403,"Operation was denied.");
        if(!authorizedTask() || (bearer?.startsWith("cdlease_") && !ctx.resolveSessionLease?.(bearer,"ops")))
          throw fail(401,"Task authorization expired.");
      }
      let result:unknown;
      switch(tool) {
        case "server_inspect":result=getProfile();break;
        case "port_allocate":result={port:await pool.allocate(workspace),ttl_seconds:60};break;
        case "app_deploy_staging":result=await deployer.stage(workspace,thread,opsTools.app_deploy_staging.parse(args),getProfile());break;
        case "app_logs":result={logs:await deployer.logs(String(args.deployment_id),workspace)};break;
        case "verify_url":result=await deployer.verify(opsTools.verify_url.parse(args),workspace,thread);break;
        case "app_promote_live":result=await deployer.promote(opsTools.app_promote_live.parse(args),workspace,thread);break;
        case "app_rollback":result=await deployer.rollback(String(args.deployment_id),workspace);break;
      }
      events.append(thread,"ops_completed",{tool});return result;
    } catch(error) {events.append(thread,"ops_failed",{tool});throw error;}
  });
  registerPreview(app,ctx,deployer);
  return {getProfile,probe,pool,deployer};
}
export type OpsService = ReturnType<typeof registerOps>;
