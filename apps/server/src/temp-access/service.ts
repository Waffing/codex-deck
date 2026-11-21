import {createHash, randomBytes, randomInt, randomUUID} from "node:crypto";
import {EventEmitter} from "node:events";
import type {FastifyRequest} from "fastify";
import {tempLinkCreate,tempLinkExtend,type TempAccessLink} from "@codexdeck/shared";
import type {ServerContext} from "../app.js";
import {hashPassword,verifyPassword} from "../security/crypto.js";
import {clientIp} from "../security/ingress.js";
import {securityEvent} from "../security/activity.js";

export const deny = (message:string, statusCode=403)=>Object.assign(new Error(message),{statusCode});
const digest=(value:string)=>createHash("sha256").update(value).digest("hex");
const changes = new WeakMap<ServerContext,EventEmitter>();
function emitter(ctx:ServerContext) {
  let bus=changes.get(ctx);
  if(!bus){bus=new EventEmitter();bus.setMaxListeners(0);changes.set(ctx,bus);}
  return bus;
}
export function onLinkChange(ctx:ServerContext,id:string,cb:()=>void){
  const bus=emitter(ctx);bus.on(id,cb);return ()=>{bus.off(id,cb);};
}
type Row=Omit<TempAccessLink,"has_code"|"workspace_ids"|"bind_first_ip"|"usage_unconfirmed">&{
  workspace_ids_json:string; bind_first_ip:number;code_hash:string|null;token_hash:string;retry_after:number;first_visit:string|null;usage_unconfirmed:number;
};
function row(ctx:ServerContext,id:string) {
  const item=ctx.native.prepare("SELECT * FROM temp_access_links WHERE id=?").get(id) as Row|undefined;
  if(!item) throw deny("Invitation unavailable.",404);
  return item;
}
function status(r:Row):TempAccessLink["status"] {
  if(r.status==="revoked") return "revoked";
  if(Date.parse(r.expires_at)<=Date.now()) return "expired";
  if(r.usage_unconfirmed) return "exhausted";
  if((r.max_turns!=null && r.used_turns>=r.max_turns) || (r.max_tokens!=null && r.used_tokens>=r.max_tokens)
    || (r.max_cost!=null && r.used_cost>=r.max_cost)) return "exhausted";
  return "active";
}
export function getLink(ctx:ServerContext,id:string):TempAccessLink {
  const r=row(ctx,id), next=status(r);
  if(next!==r.status){
    ctx.native.prepare("UPDATE temp_access_links SET status=? WHERE id=?").run(next,id);
    if(next==="exhausted") securityEvent(ctx,"guest_exhausted",id,null,r.usage_unconfirmed?{reason:"upstream_usage_unavailable"}:{});
    emitter(ctx).emit(id);
  }
  return {id:r.id,name:r.name,permission:r.permission,workspace_ids:JSON.parse(r.workspace_ids_json),
    created_at:r.created_at,expires_at:r.expires_at,has_code:!!r.code_hash,bind_first_ip:!!r.bind_first_ip,
    bound_ip:r.bound_ip,usage_unconfirmed:!!r.usage_unconfirmed,used_turns:r.used_turns,used_tokens:r.used_tokens,used_cost:r.used_cost,max_turns:r.max_turns,
    max_tokens:r.max_tokens,max_cost:r.max_cost,currency:r.currency,status:next,note:r.note};
}
export function listTempLinks(ctx:ServerContext) {
  return (ctx.native.prepare("SELECT id FROM temp_access_links ORDER BY created_at DESC").pluck().all() as string[]).map(id=>getLink(ctx,id));
}
export async function createTempLink(ctx:ServerContext,input:unknown,origin:string) {
  const parsed=tempLinkCreate.safeParse(input);
  if(!parsed.success) throw deny("Invalid invitation.",400);
  const p=parsed.data, scopes=[...new Set(p.workspace_ids)];
  if(Date.parse(p.expires_at)<=Date.now() || scopes.some(id=>!ctx.native.prepare("SELECT 1 FROM workspaces WHERE id=?").get(id)))
    throw deny("Select existing workspaces and a future expiry.",400);
  const token=randomBytes(32).toString("base64url"),code=p.require_code?String(randomInt(100000,1000000)):null;
  const id=randomUUID(),hash=code?await hashPassword(code):null;
  const url=new URL("/guest/"+token,origin).href;
  ctx.native.prepare(`INSERT INTO temp_access_links(id,name,token_hash,code_hash,expires_at,workspace_ids_json,permission,
    max_turns,max_tokens,max_cost,currency,bind_first_ip,created_at,note) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id,p.name,digest(token),hash,new Date(p.expires_at).toISOString(),JSON.stringify(scopes),p.permission,p.max_turns??null,p.max_tokens??null,
      p.max_cost??null,p.currency,Number(p.bind_first_ip),new Date().toISOString(),p.note);
  securityEvent(ctx,"guest_created","admin",null,{link_id:id});
  return {link:getLink(ctx,id),url,code};
}
export function revokeTempLink(ctx:ServerContext,id:string) {
  const r=getLink(ctx,id);
  if(r.status!=="revoked"){
    ctx.native.prepare("UPDATE temp_access_links SET status='revoked' WHERE id=?").run(id);
    securityEvent(ctx,"guest_revoked","admin",null,{link_id:id});
    emitter(ctx).emit(id);
  }
  return getLink(ctx,id);
}
export function extendTempLink(ctx:ServerContext,id:string,input:unknown) {
  const parsed=tempLinkExtend.safeParse(input);
  if(!parsed.success) throw deny("Invalid extension.",400);
  const p=parsed.data,l=getLink(ctx,id);
  if(l.status==="revoked") throw deny("Revoked invitations cannot be reopened.",409);
  const plus=(current:number|null|undefined,amount:number|undefined)=>{
    if(current==null && amount!==undefined) throw deny("An unlimited quota cannot be extended.",400);
    const sum=current==null?null:current+(amount??0);
    if(sum!=null && sum>Number.MAX_SAFE_INTEGER) throw deny("Quota is too large.",400);
    return sum;
  };
  const expiry=p.hours?new Date(Math.max(Date.now(),Date.parse(l.expires_at))+p.hours*3600000).toISOString():l.expires_at;
  ctx.native.prepare(`UPDATE temp_access_links SET expires_at=?,max_turns=?,max_tokens=?,max_cost=?,
    usage_unconfirmed=CASE WHEN ? THEN 0 ELSE usage_unconfirmed END WHERE id=?`)
    .run(expiry,plus(l.max_turns,p.turns),plus(l.max_tokens,p.tokens),plus(l.max_cost,p.cost),Number(!!(p.tokens||p.cost)),id);
  securityEvent(ctx,"guest_extended","admin",null,{link_id:id});
  emitter(ctx).emit(id);
  return getLink(ctx,id);
}
export const guestCookieName="codexdeck_guest";
export function guestCookie(req:FastifyRequest) {
  return /(?:^|;\s*)codexdeck_guest=([A-Za-z0-9_-]{43})(?:;|$)/.exec(req.headers.cookie??"")?.[1];
}
export type GuestSession={id:string;link:TempAccessLink};
export function getGuestSession(ctx:ServerContext,req:FastifyRequest):GuestSession|undefined {
  const token=guestCookie(req);
  if(!token) return;
  const session=ctx.native.prepare("SELECT id,link_id FROM guest_sessions WHERE token_hash=?").get(digest(token)) as {id:string;link_id:string}|undefined;
  if(!session) return;
  const link=getLink(ctx,session.link_id);
  if(link.status!=="active" || (link.bind_first_ip && link.bound_ip!==clientIp(req))) return;
  return {id:session.id,link};
}
export function visit(ctx:ServerContext,s:GuestSession,ip:string,workspace?:string) {
  ctx.native.prepare("UPDATE guest_sessions SET ip=?,last_seen_at=?,workspace_id=coalesce(?,workspace_id) WHERE id=?")
    .run(ip,new Date().toISOString(),workspace??null,s.id);
}
export function liveGuests(ctx:ServerContext) {
  const since=new Date(Date.now()-60000).toISOString();
  const sessions=ctx.native.prepare("SELECT id,link_id,ip,workspace_id,last_seen_at FROM guest_sessions WHERE last_seen_at>? ORDER BY last_seen_at DESC").all(since) as
    {id:string;link_id:string;ip:string;workspace_id:string|null;last_seen_at:string}[];
  return sessions.map(s=>({...s,link:getLink(ctx,s.link_id)})).filter(s=>s.link.status==="active");
}
export function entry(ctx:ServerContext,token:string) {
  if(!/^[A-Za-z0-9_-]{43}$/.test(token)) throw deny("Invitation unavailable.",404);
  const r=ctx.native.prepare("SELECT id,code_hash FROM temp_access_links WHERE token_hash=?").get(digest(token)) as {id:string;code_hash:string|null}|undefined;
  if(!r || getLink(ctx,r.id).status!=="active") throw deny("Invitation unavailable.");
  return r;
}
export async function exchange(ctx:ServerContext,token:string,code:unknown,ip:string) {
  const e=entry(ctx,token);
  if(e.code_hash) {
    if(typeof code!=="string" || !/^\d{4,6}$/.test(code)) throw deny("Extraction code required.");
    const now=Date.now();
    const attempt=ctx.native.prepare(`UPDATE temp_access_links SET failed_codes=CASE WHEN retry_after>0 THEN 1 ELSE failed_codes+1 END,
      retry_after=CASE WHEN retry_after=0 AND failed_codes>=4 THEN ? ELSE 0 END WHERE id=? AND retry_after<=?`).run(now+900000,e.id,now);
    if(!attempt.changes) throw deny("Too many code attempts. Try later.",429);
    if(!await verifyPassword(code,e.code_hash)) throw deny("Invalid extraction code.");
  }
  return ctx.native.transaction(()=>{
    const link=getLink(ctx,e.id);
    if(link.status!=="active" || (link.bind_first_ip && link.bound_ip && link.bound_ip!==ip)) throw deny("Invitation unavailable.");
    const now=new Date().toISOString(),session=randomBytes(32).toString("base64url");
    const first=!row(ctx,e.id).first_visit;
    ctx.native.prepare(`UPDATE temp_access_links SET bound_ip=CASE WHEN bind_first_ip THEN coalesce(bound_ip,?) ELSE NULL END,
      first_visit=coalesce(first_visit,?),failed_codes=0,retry_after=0 WHERE id=?`).run(ip,now,e.id);
    ctx.native.prepare("INSERT INTO guest_sessions(id,link_id,token_hash,ip,last_seen_at) VALUES(?,?,?,?,?)").run(randomUUID(),e.id,digest(session),ip,now);
    securityEvent(ctx,first?"guest_online":"guest_login",e.id,ip,{});
    return session;
  }).immediate();
}
export function endSession(ctx:ServerContext,req:FastifyRequest) {
  const token=guestCookie(req);
  if(token) ctx.native.prepare("DELETE FROM guest_sessions WHERE token_hash=?").run(digest(token));
}
export function taskLink(ctx:ServerContext,taskId?:string) {
  const id=taskId && ctx.native.prepare("SELECT guest_link_id FROM tasks WHERE id=?").pluck().get(taskId);
  return typeof id==="string"?getLink(ctx,id):undefined;
}
export function assertGuestTurn(ctx:ServerContext,id:string,workspace:string) {
  const link=getLink(ctx,id);
  if(link.status!=="active" || link.permission==="readonly" || !link.workspace_ids.includes(workspace)) throw deny("Guest turn unavailable.");
  // Reserve the link's next turn until both token and cost totals settle. Other links and admin tasks run independently.
  if(ctx.native.prepare("SELECT 1 FROM tasks WHERE guest_link_id=? AND status IN ('queued','running')").get(id)) throw deny("A guest turn is already in progress.",409);
}
export function finishGuestTurn(ctx:ServerContext,taskId:string) {
  const link=taskLink(ctx,taskId);
  if(link){
    ctx.native.prepare("UPDATE temp_access_links SET used_turns=used_turns+1 WHERE id=?").run(link.id);
    getLink(ctx,link.id);
  }
}
export function recordGuestUsage(ctx:ServerContext,taskId:string|undefined,tokens:number,cost:{costUsd:number;costCny:number},uncertain:boolean) {
  const link=taskLink(ctx,taskId);
  if(!link) return;
  ctx.native.prepare("UPDATE temp_access_links SET used_tokens=used_tokens+?,used_cost=used_cost+? WHERE id=?")
    .run(tokens,link.currency==="USD"?cost.costUsd:cost.costCny,link.id);
  if(uncertain && (link.max_tokens!=null || link.max_cost!=null)) {
    // A successfully forwarded request with missing totals cannot safely continue under a finite budget.
    ctx.native.prepare("UPDATE temp_access_links SET usage_unconfirmed=1 WHERE id=?").run(link.id);
  }
  getLink(ctx,link.id);
}
