import type { FastifyInstance,FastifyRequest,FastifyReply } from "fastify";
import { authLoginRequestSchema,authSetupRequestSchema,authPasswordChangeSchema } from "@codexdeck/shared";
import { createHmac,randomBytes,timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import { hashPassword,verifyPassword } from "../security/crypto.js";
import { authenticated,clearSessionCookie,setSessionCookie,revokeSessions } from "../auth.js";
import { readSecurityConfig,getSetting } from "../security/config.js";
import { clientIp,directLocal } from "../security/ingress.js";
import { Captchas,banSeconds,failedAttempt } from "../security/attempts.js";
import { consumeOtp } from "../security/totp.js";
import type { ServerContext } from "../app.js";

export function installationCode(native:Database.Database,key:Buffer):string {
  native.prepare("INSERT OR IGNORE INTO settings(key,value,updated_at) VALUES('setup_nonce',?,?)")
    .run(randomBytes(24).toString("hex"),new Date().toISOString());
  return createHmac("sha256",key).update("admin-setup:"+getSetting(native,"setup_nonce")).digest("base64url");
}
export function registerAuthRoutes(app:FastifyInstance,ctx:ServerContext) {
  const db=ctx.native;
  const currentHash=()=>getSetting(db,"admin_password_hash");
  const code=currentHash()?"":installationCode(db,ctx.masterKey);
  if(code) ctx.masker.register(code);
  const captcha=new Captchas();
  const pending=new Set<string>();
  async function guard(req:FastifyRequest,reply:FastifyReply,action:(ip:string)=>Promise<unknown>) {
    const ip=clientIp(req);
    const delay=banSeconds(ctx,ip,readSecurityConfig(db));
    if(delay || pending.has(ip) || pending.size>=16) return reply.code(429).header("Retry-After",String(delay||1)).send({error:"Too many attempts."});
    pending.add(ip);
    try {return await action(ip);} finally {pending.delete(ip);}
  }
  app.get("/api/auth/status",async req=>{
    const config=readSecurityConfig(db);
    return {authenticated:authenticated(ctx,req),setup_required:!currentHash(),captcha_enabled:config.captcha_enabled,totp_enabled:config.totp_enabled};
  });
  app.get("/api/auth/captcha",async(req,reply)=>{
    if(!readSecurityConfig(db).captcha_enabled) return reply.code(404).send();
    return reply.header("Cache-Control","no-store").send(captcha.issue(clientIp(req)));
  });
  app.post("/api/auth/setup",async(req,reply)=>{
    if (!directLocal(req)) return reply.code(403).send();
    if(currentHash()) return reply.code(409).send({error:"Administrator is already configured."});
    const parsed=authSetupRequestSchema.safeParse(req.body);
    if(!parsed.success) return reply.code(400).send({error:"Invalid setup request."});
    const supplied=Buffer.from(parsed.data.setup_code);
    if(!code || supplied.length!==Buffer.byteLength(code) || !timingSafeEqual(Buffer.from(code),supplied))
      return reply.code(403).send({error:"Invalid installation code."});
    const passwordHash=await hashPassword(parsed.data.password);
    const inserted=db.prepare("INSERT OR IGNORE INTO settings(key,value,updated_at) VALUES ('admin_password_hash',?,?)")
      .run(passwordHash,new Date().toISOString());
    if(!inserted.changes) return reply.code(409).send({error:"Administrator is already configured."});
    db.prepare("DELETE FROM settings WHERE key='setup_nonce'").run();
    setSessionCookie(ctx,reply);
    return {authenticated:true,setup_required:false};
  });
  app.post("/api/auth/login",async(req,reply)=>guard(req,reply,async ip=>{
    const parsed=authLoginRequestSchema.safeParse(req.body);
    if(!parsed.success) return reply.code(400).send({error:"Invalid login request."});
    const config=readSecurityConfig(db);
    const {password,captcha_id,captcha_answer,otp}=parsed.data;
    if(config.captcha_enabled && !captcha.check(ip,captcha_id,captcha_answer)) {
      failedAttempt(ctx,ip,config);return reply.code(401).send({error:"Invalid challenge."});
    }
    const hash=currentHash();
    const valid=hash && await verifyPassword(password,hash) && hash===currentHash();
    const latest=readSecurityConfig(db);
    if(!valid || latest.totp_enabled && !consumeOtp(ctx,otp??"")) {
      failedAttempt(ctx,ip,latest);
      return reply.code(401).send({error:"Invalid credentials."});
    }
    db.prepare("DELETE FROM login_bans WHERE ip=?").run(ip);
    setSessionCookie(ctx,reply);
    return {authenticated:true,setup_required:false};
  }));
  app.post("/api/auth/password",async(req,reply)=>{
    if(!authenticated(ctx,req)) return reply.code(401).send({error:"Authentication required."});
    return guard(req,reply,async ip=>{
      const parsed=authPasswordChangeSchema.safeParse(req.body);
      if(!parsed.success) return reply.code(400).send({error:"Invalid password change."});
      const old=currentHash();
      if(!old || !await verifyPassword(parsed.data.current_password,old)) {
        failedAttempt(ctx,ip,readSecurityConfig(db)); return reply.code(403).send({error:"Incorrect current password."});
      }
      const next=await hashPassword(parsed.data.new_password);
      const changed=db.transaction(()=>{
        if(!authenticated(ctx,req) || !db.prepare("UPDATE settings SET value=?,updated_at=? WHERE key='admin_password_hash' AND value=?")
          .run(next,new Date().toISOString(),old).changes) return false;
        revokeSessions(db);return true;
      }).immediate();
      if(!changed) return reply.code(409).send({error:"Credentials already changed."});
      setSessionCookie(ctx,reply);
      return {changed:true};
    });
  });
  app.post("/api/auth/logout",async(req,reply)=>{
    clearSessionCookie(ctx,req,reply);
    return {authenticated:false,setup_required:!currentHash()};
  });
}