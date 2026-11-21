import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { workbenchPreferencesSchema } from "@codexdeck/shared";
import type { ServerContext } from "../app.js";
import { authenticated, revokeSessions } from "../auth.js";
import { patchPreferences, readPreferences } from "../settings/preferences.js";
import { resetPanelDefaults } from "../settings/defaults.js";
import { createTempLink, listTempLinks, liveGuests, revokeTempLink, extendTempLink } from "../temp-access/service.js";
import { readSecurityConfig, updateSecurityConfig, resetSecurityConfig } from "./config.js";
import { clientIp, directLocal } from "./ingress.js";
import { securityEvent } from "./activity.js";
import { Notifications } from "../notifications/index.js";
import { activateTotp, disableTotp, enrollTotp } from "./totp.js";
import { hashPassword, signPayload, verifySignedPayload } from "./crypto.js";

const bodySchema = z.object({
  action: z.enum(["security", "security-set", "security-reset", "preferences", "preferences-set", "preferences-reset",
    "reset-password", "bans", "unban", "totp-enroll", "totp-confirm", "two-factor-off", "sessions", "session-revoke",
    "defaults-reset", "channels", "channel-create", "channel-update", "channel-delete",
    "workspaces", "audit", "temp-live", "temp-list", "temp-create", "temp-revoke", "temp-extend"]),
  input: z.unknown().optional(), id: z.string().min(1).max(128).optional(), origin: z.url().optional(),
}).strict();
const digest = (body:unknown) => createHash("sha256").update(JSON.stringify(body ?? null)).digest("hex");
export function signAdminRequest(key:Buffer, method:string, route:string, body?:unknown) {
  return signPayload({aud:"codexdeck-host-admin", method, route, body:digest(body), at:Date.now(), nonce:randomUUID()},key);
}

const used = new WeakMap<ServerContext,Map<string,number>>();
export function adminAuthorized(ctx:ServerContext, request:FastifyRequest) {
  if (authenticated(ctx,request)) return true;
  const header=request.headers["x-codexdeck-admin"];
  if (!directLocal(request) || typeof header!=="string") return false;
  const p=verifySignedPayload(header,ctx.masterKey), now=Date.now();
  if (!p || p.aud!=="codexdeck-host-admin" || p.method!==request.method || p.route!==request.url ||
      p.body!==digest(request.body) || typeof p.nonce!=="string" || typeof p.at!=="number" || p.at>now+1000 || p.at<now-30000) return false;
  const nonces=used.get(ctx) ?? new Map<string,number>();
  for (const [id,until] of nonces) if (until<now) nonces.delete(id);
  if (nonces.has(p.nonce)) return false;
  nonces.set(p.nonce,p.at+30000); used.set(ctx,nonces);
  return true;
}

export async function emergency(ctx:ServerContext, raw:unknown, ip?:string) {
  const req=bodySchema.parse(raw), db=ctx.native;
  const id=()=>z.string().min(1).parse(req.id);
  switch (req.action) {
    case "security": return readSecurityConfig(db);
    case "preferences": return readPreferences(db);
    case "channels": return new Notifications(ctx).channels();
    case "temp-list": return listTempLinks(ctx);
    case "temp-live": return liveGuests(ctx);
    case "workspaces": return db.prepare("SELECT id,name FROM workspaces ORDER BY name").all();
    case "audit": return db.prepare("SELECT * FROM audit_logs ORDER BY id DESC LIMIT 100").all();
    case "bans": return db.prepare("SELECT * FROM login_bans").all();
    case "sessions": return db.prepare("SELECT session_id,ip,user_agent,created_at,last_active_at,expires_at FROM user_sessions WHERE revoked=0 AND expires_at>? ORDER BY last_active_at DESC").all(new Date().toISOString());
  }
  let result:unknown={ok:true};
  switch (req.action) {
    case "reset-password": {
      const hash=await hashPassword(z.string().min(12).max(256).parse(req.input));
      db.transaction(()=>{
        db.prepare("INSERT INTO settings(key,value,updated_at) VALUES('admin_password_hash',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(hash,new Date().toISOString());
        db.prepare("DELETE FROM settings WHERE key='setup_nonce'").run();
        revokeSessions(db);
      })();
      break;
    }
    case "unban": db.prepare("DELETE FROM login_bans WHERE ? IS NULL OR ip=?").run(req.id??null,req.id??null); break;
    case "session-revoke": result={revoked:revokeSessions(db,id())}; break;
    case "defaults-reset": result=resetPanelDefaults(ctx,ip?"admin":"host",ip??null); break;
    case "channel-create": result=new Notifications(ctx).create(req.input); break;
    case "channel-update": result=new Notifications(ctx).update(id(),req.input); break;
    case "channel-delete": {
      if (!new Notifications(ctx).remove(id())) throw Object.assign(new Error("Notification channel missing."),{statusCode:404});
      break;
    }
    case "totp-enroll": result=enrollTotp(ctx,"cdx"); break;
    case "totp-confirm":
      result={recovery_codes:activateTotp(ctx,"cdx",z.string().regex(/^\d{6}$/).parse(req.input))};
      revokeSessions(db); securityEvent(ctx,"totp_changed","host",null,{enabled:true}); break;
    case "two-factor-off": {
      const active=readSecurityConfig(db).totp_enabled;
      disableTotp(db); revokeSessions(db);
      if (active) securityEvent(ctx,"totp_changed",ip?"admin":"host",ip??null,{enabled:false});
      break;
    }
    case "security-set": result=await updateSecurityConfig(db,req.input,ip); break;
    case "security-reset": {
      const active=readSecurityConfig(db).totp_enabled;
      if (active) securityEvent(ctx,"totp_changed",ip?"admin":"host",ip??null,{enabled:false});
      result=resetSecurityConfig(db); revokeSessions(db); break;
    }
    case "preferences-set": {
      const patch=z.record(z.string(),z.unknown()).parse(req.input);
      result=patchPreferences(db,workbenchPreferencesSchema.parse({...readPreferences(db),...patch}));
      break;
    }
    case "preferences-reset": result=patchPreferences(db,workbenchPreferencesSchema.parse({})); break;
    case "temp-create": {
      const url=new URL(z.url().parse(req.origin));
      if (!["http:","https:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid invitation address.");
      result=await createTempLink(ctx,req.input,url.origin); break;
    }
    case "temp-extend": result=await extendTempLink(ctx,id(),req.input); break;
    case "temp-revoke": result=await revokeTempLink(ctx,id()); break;
  }
  securityEvent(ctx,"admin."+req.action,ip?"admin":"host",ip??null);
  return result;
}

export function registerEmergencyRoute(app:FastifyInstance, ctx:ServerContext) {
  app.post("/api/admin/security/emergency",async (request,reply)=>{
    reply.header("Cache-Control","no-store");
    if (!adminAuthorized(ctx,request)) return reply.code(403).send({error:"Administrator required."});
    const input=bodySchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({error:"Invalid management request."});
    if (input.data.action.startsWith("totp-") && authenticated(ctx,request))
      return reply.code(403).send({error:"Use the authenticated enrollment wizard."});
    try {return await emergency(ctx,input.data,authenticated(ctx,request)?clientIp(request):undefined);}
    catch (e) {if (e instanceof z.ZodError) return reply.code(400).send({error:"Invalid management input."}); throw e;}
  });
}
