import { createHash,randomBytes,randomUUID } from "node:crypto";
import type { FastifyReply,FastifyRequest } from "fastify";
import type Database from "better-sqlite3";
import type { WebSocket } from "ws";
import type { ServerContext } from "./app.js";
import { readSecurityConfig } from "./security/config.js";
import { clientIp,secureTransport } from "./security/ingress.js";
import { securityEvent } from "./security/activity.js";

const sockets=new WeakMap<Database.Database,Map<WebSocket,string>>();
const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
export function sessionId(ctx:ServerContext,req:FastifyRequest):string|undefined {
  const token=/(?:^|;\s*)codexdeck_session=([A-Za-z0-9_-]{43})(?:;|$)/.exec(req.headers.cookie??"")?.[1];
  if(!token) return;
  const row=ctx.native.prepare("SELECT session_id,last_active_at FROM user_sessions WHERE token_hash=? AND revoked=0 AND expires_at>?")
    .get(hash(token),new Date().toISOString()) as {session_id:string;last_active_at:string}|undefined;
  if(row && Date.now()-Date.parse(row.last_active_at)>=60_000) {
    ctx.native.prepare("UPDATE user_sessions SET last_active_at=? WHERE session_id=?").run(new Date().toISOString(),row.session_id);
  }
  return row?.session_id;
}
export function bindAdminSocket(ctx:ServerContext,req:FastifyRequest,socket:WebSocket) {
  const id=sessionId(ctx,req);
  if(!id) {socket.close(1008,"Session expired");return;}
  const tracked=sockets.get(ctx.native)??new Map<WebSocket,string>();
  sockets.set(ctx.native,tracked);tracked.set(socket,id);
  socket.once("close",()=>tracked.delete(socket));
}
export function revokeSessions(db:Database.Database,id?:string) {
  const result=db.prepare("UPDATE user_sessions SET revoked=1 WHERE revoked=0 AND (? IS NULL OR session_id=?)").run(id??null,id??null);
  for(const [socket,session] of sockets.get(db)??[]) {
    if(!id || session===id) socket.close(1008,"Session revoked");
  }
  return result.changes;
}
export function authenticated(context:ServerContext,request:FastifyRequest) {
  return !!sessionId(context,request);
}
function cookie(reply:FastifyReply,value:string,ttl:number) {
  reply.header("set-cookie","codexdeck_session="+value+"; Path=/; HttpOnly; SameSite=Strict; Max-Age="+ttl+(secureTransport(reply.request)?"; Secure":""));
}
export function setSessionCookie(ctx:ServerContext,reply:FastifyReply) {
  const token=randomBytes(32).toString("base64url");
  const db=ctx.native,config=readSecurityConfig(db),now=new Date().toISOString(),ttl=config.session_hours*3600;
  const ip=clientIp(reply.request),ua=ctx.masker.maskString((reply.request.headers["user-agent"]??"").slice(0,512));
  db.transaction(()=>{
    const known=db.prepare("SELECT 1 FROM user_sessions WHERE ip=? AND user_agent=? LIMIT 1").get(ip,ua);
    if(config.single_session) revokeSessions(db);
    db.prepare("DELETE FROM user_sessions WHERE expires_at<?").run(new Date(Date.now()-30*86400000).toISOString());
    db.prepare("INSERT INTO user_sessions(session_id,token_hash,ip,user_agent,created_at,last_active_at,expires_at) VALUES(?,?,?,?,?,?,?)")
      .run(randomUUID(),hash(token),ip,ua,now,now,new Date(Date.now()+ttl*1000).toISOString());
    securityEvent(ctx,"login","admin",ip);
    if(!known) securityEvent(ctx,"new_device","admin",ip);
  }).immediate();
  cookie(reply,token,ttl);
}
export function clearSessionCookie(ctx:ServerContext,req:FastifyRequest,reply:FastifyReply) {
  const id=sessionId(ctx,req);
  if(id) revokeSessions(ctx.native,id);
  cookie(reply,"",0);
}
export function createRequireAdmin(context:ServerContext) {
  return async (request:FastifyRequest, reply:FastifyReply)=>{
    if(!authenticated(context,request)) return reply.code(401).send({error:"Authentication required."});
  };
}
