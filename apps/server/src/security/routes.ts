import type { FastifyInstance } from "fastify";
import type { ServerContext } from "../app.js";
import { createRequireAdmin,revokeSessions,sessionId } from "../auth.js";
import { clientIp } from "./ingress.js";
import { readSecurityConfig,updateSecurityConfig,resetSecurityConfig } from "./config.js";
import { securityEvent } from "./activity.js";
import { activateTotp,consumeOtp,disableTotp,enrollTotp } from "./totp.js";

export function registerSecurityRoutes(app:FastifyInstance,ctx:ServerContext) {
  const db=ctx.native;
  const admin={preHandler:createRequireAdmin(ctx)};
  app.get("/api/security/config",admin,async()=>readSecurityConfig(db));
  app.patch("/api/security/config",admin,async req=>{
    const ip=clientIp(req);
    const result=await updateSecurityConfig(db,req.body,ip);
    securityEvent(ctx,"security.config","admin",ip,{fields:Object.keys(req.body as object)});
    return result;
  });
  app.post("/api/security/reset",admin,async req=>{
    const active=readSecurityConfig(db).totp_enabled;
    if(active) securityEvent(ctx,"totp_changed","admin",clientIp(req),{enabled:false});
    const config=resetSecurityConfig(db);
    securityEvent(ctx,"security.reset","admin",clientIp(req));
    return config;
  });
  app.get("/api/security/my-ip",admin,async req=>({ip:clientIp(req)}));
  app.get("/api/security/bans",admin,async()=>db.prepare("SELECT ip,failures,strftime('%Y-%m-%dT%H:%M:%fZ',banned_until/1000.0,'unixepoch') AS banned_until FROM login_bans WHERE login_bans.banned_until>? ORDER BY login_bans.banned_until DESC").all(Date.now()));
  app.delete<{Params:{ip:string}}>("/api/security/bans/:ip",admin,async(req,reply)=>{
    db.prepare("DELETE FROM login_bans WHERE ip=?").run(req.params.ip);
    securityEvent(ctx,"ip.unban","admin",clientIp(req),{ip:req.params.ip});
    return reply.code(204).send();
  });
  app.delete("/api/security/bans",admin,async(req,reply)=>{
    db.prepare("DELETE FROM login_bans").run();
    securityEvent(ctx,"ip.unban_all","admin",clientIp(req));
    return reply.code(204).send();
  });
  app.get("/api/security/sessions",admin,async req=>{
    const active=sessionId(ctx,req);
    return db.prepare("SELECT session_id,ip,user_agent,created_at,last_active_at,expires_at FROM user_sessions WHERE revoked=0 AND expires_at>? ORDER BY last_active_at DESC")
      .all(new Date().toISOString()).map(row=>({...row as object,current:(row as {session_id:string}).session_id===active}));
  });
  app.delete<{Params:{id:string}}>("/api/security/sessions/:id",admin,async(req,reply)=>{
    const count=revokeSessions(db,req.params.id);
    if(count) securityEvent(ctx,"session.revoked","admin",clientIp(req),{session_id:req.params.id});
    return reply.code(count?204:404).send();
  });
  app.post("/api/security/totp/enroll",admin,async(req,reply)=>reply.header("cache-control","no-store").send(enrollTotp(ctx,sessionId(ctx,req)!)));
  app.post<{Body:{otp?:unknown}}>("/api/security/totp/activate",admin,async(req,reply)=>{
    if(typeof req.body?.otp!=="string") return reply.code(400).send({error:"Enter the six-digit code."});
    const active=sessionId(ctx,req)!;
    const recovery_codes=activateTotp(ctx,active,req.body.otp);
    for (const id of db.prepare("SELECT session_id FROM user_sessions WHERE session_id<>? AND revoked=0").pluck().all(active) as string[]) revokeSessions(db,id);
    securityEvent(ctx,"totp_changed","admin",clientIp(req),{enabled:true});
    return reply.header("cache-control","no-store").send({recovery_codes});
  });
  app.post<{Body:{otp?:unknown}}>("/api/security/totp/disable",admin,async(req,reply)=>{
    if(typeof req.body?.otp!=="string" || !consumeOtp(ctx,req.body.otp)) return reply.code(403).send({error:"Invalid two-factor code."});
    disableTotp(db);
    securityEvent(ctx,"totp_changed","admin",clientIp(req),{enabled:false});
    return {totp_enabled:false};
  });
  app.get("/api/security/audit",admin,async()=>db.prepare("SELECT id,event AS action,actor,ip,created_at,details_json FROM audit_logs ORDER BY id DESC LIMIT 200").all());
}
