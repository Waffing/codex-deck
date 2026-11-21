import {publicShareRoute} from "../security/share-ingress.js";
import type {FastifyInstance,FastifyReply,FastifyRequest} from "fastify";
import {createRequireAdmin} from "../auth.js";
import type {ServerContext} from "../app.js";
import {clientIp,secureTransport} from "../security/ingress.js";
import {securityEvent} from "../security/activity.js";
import {createTempLink,deny,endSession,entry,exchange,extendTempLink,getGuestSession,guestCookie,guestCookieName,listTempLinks,
  liveGuests,revokeTempLink,visit,type GuestSession} from "./service.js";

const authorized=new WeakMap<FastifyRequest,GuestSession>();
export const scopedGuest=(req:FastifyRequest)=>authorized.get(req);
export function scopedAccess(ctx:ServerContext){
  const admin=createRequireAdmin(ctx);
  return {preHandler:async(req:FastifyRequest,reply:FastifyReply)=>{
    if(!scopedGuest(req)) return admin(req,reply);
  }};
}
export function threadWorkspace(ctx:ServerContext,id:string) {
  return ctx.native.prepare("SELECT workspace_id FROM threads WHERE id=?").pluck().get(id);
}
function guestScope(ctx:ServerContext,req:FastifyRequest,g:GuestSession) {
  const route=req.routeOptions.url??"",method=req.method;
  const params=req.params as {id?:string;workspace?:string;turnId?:string};
  const body=req.body as {workspace_id?:string}|undefined,query=req.query as {workspace_id?:string;debug?:string};
  if(route==="/api/guest/session" || route==="/api/guest/previews" || route==="/ws/events" || route==="/api/workspaces" && method==="GET") return;
  if(route==="/api/artifacts/sign" && method==="POST" || route==="/api/dl/*" && method==="GET") return; // Subject checked against every artifact by the handler.
  if((route==="/preview/:port/*" || route==="/live/:workspace/*") && method==="GET" && !req.headers.upgrade) return; // Managed deployment ownership checked by the proxy.
  let workspace:unknown;
  if(route==="/api/threads" && method==="GET"){
    if(!query.workspace_id) return;
    workspace=query.workspace_id;
  } else if(route==="/api/threads" && method==="POST" && g.link.permission!=="readonly") {
    workspace=body?.workspace_id;
  } else if(route==="/api/turns/:turnId/steps/:stepId" && method==="GET"){
    workspace=ctx.native.prepare("SELECT workspace_id FROM tasks WHERE id=?").pluck().get(params.turnId!);
  } else if(route==="/api/threads/:id/turns" && method==="GET" || route==="/api/threads/:id/history" && method==="GET" && query.debug!=="true" ||
    route==="/api/threads/:id/messages" && method==="POST" && g.link.permission!=="readonly") {
    workspace=threadWorkspace(ctx,params.id!);
  } else if(method==="GET" && ["/api/workspaces/:id/files/content","/api/workspaces/:id/files/tree","/api/workspaces/:id/files/search",
    "/api/workspaces/:id/git/status","/api/workspaces/:id/git/diff"].includes(route) ||
    method==="POST" && route==="/api/workspaces/:id/files/upload" && g.link.permission!=="readonly") {
    workspace=params.id;
  } else throw deny("This operation requires an administrator.");
  if(typeof workspace!=="string" || !g.link.workspace_ids.includes(workspace)) throw deny("Workspace outside invitation scope.");
  return workspace;
}
export function registerTempAccess(app:FastifyInstance,ctx:ServerContext) {
  const admin={preHandler:createRequireAdmin(ctx)};
  type Id={Params:{id:string}};
  app.addHook("preHandler",async req=>{
    const route=req.routeOptions.url??"";
    if(!guestCookie(req) || publicShareRoute(req) || route==="/guest/:token" || route==="/api/guest/logout" ||
      !/^\/(api|internal|ws|live|preview)\//.test(route)) return;
    const guest=getGuestSession(ctx,req);
    if(!guest) throw deny("Invitation expired, exhausted or revoked.");
    const workspace=guestScope(ctx,req,guest);
    visit(ctx,guest,clientIp(req),workspace);
    authorized.set(req,guest);
  });
  app.get("/api/temp-access",admin,async()=>listTempLinks(ctx));
  app.get("/api/temp-access/live",admin,async()=>liveGuests(ctx));
  app.post("/api/temp-access",admin,async(req,reply)=>{
    const origin=process.env.CODEXDECK_PUBLIC_ORIGIN || (process.env.CODEXDECK_DOMAIN?"https://"+process.env.CODEXDECK_DOMAIN:
      (secureTransport(req)?"https":req.protocol)+"://"+req.host);
    return reply.code(201).header("cache-control","no-store").send(await createTempLink(ctx,req.body,origin));
  });
  app.patch<Id>("/api/temp-access/:id/extend",admin,async req=>extendTempLink(ctx,req.params.id,req.body));
  app.post<Id>("/api/temp-access/:id/revoke",admin,async req=>revokeTempLink(ctx,req.params.id));
  app.get("/api/guest/session",async(req,reply)=>{
    const g=scopedGuest(req);if(!g)return reply.code(401).send({error:"Guest login required."});
    return reply.header("cache-control","no-store").send(g.link);
  });
  app.post("/api/guest/logout",async(req,reply)=>{
    endSession(ctx,req);return reply.code(204).header("set-cookie",guestCookieName+"=; HttpOnly; SameSite=Strict; Max-Age=0; Path=/").send();
  });
  app.register(async form=>{
    form.addContentTypeParser("application/x-www-form-urlencoded",{parseAs:"string",bodyLimit:256},(_req,body,done)=>{
      const code=new URLSearchParams(String(body)).get("code");done(null,{code});
    });
    type Token={Params:{token:string}};
    function headers(reply:FastifyReply){
      return reply.header("cache-control","no-store").header("referrer-policy","strict-origin")
        .header("content-security-policy","default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
        .header("x-content-type-options","nosniff");
    }
    async function admit(req:FastifyRequest<Token>,reply:FastifyReply,code?:unknown){
      const session=await exchange(ctx,req.params.token,code,clientIp(req));
      const secure=secureTransport(req);
      return headers(reply).header("set-cookie",guestCookieName+"="+session+"; HttpOnly; SameSite=Strict; Path=/"+(secure?"; Secure":"")).redirect("/guest",303);
    }
    form.get<Token>("/guest/:token",async(req,reply)=>{
      const invitation=entry(ctx,req.params.token);
      if(!invitation.code_hash)return admit(req,reply);
      return headers(reply).type("text/html; charset=utf-8").send('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>临时访问</title><main><h1>临时访问</h1><form method="post"><label>提取码 <input name="code" inputmode="numeric" pattern="[0-9]{4,6}" maxlength="6" required autofocus></label> <button>进入工作区</button></form></main></html>');
    });
    form.post<Token>("/guest/:token",async(req,reply)=>admit(req,reply,(req.body as {code?:unknown}|null)?.code));
  });
  app.addHook("onResponse",async(req,reply)=>{
    const g=scopedGuest(req);
    if(g && req.method!=="GET" && req.method!=="HEAD"){
      securityEvent(ctx,"guest_operation",g.link.id,clientIp(req),{method:req.method,route:req.routeOptions.url,status:reply.statusCode});
    }
  });
}
