import { createHash } from "node:crypto";
import type { Socket } from "node:net";
import type { FastifyInstance,FastifyReply } from "fastify";
import type { SecurityConfig } from "@codexdeck/shared";
import type { ServerContext } from "../app.js";
import { authenticated } from "../auth.js";
import { getGuestSession } from "../temp-access/service.js";
import { clientIp,directLocal,localPanel,secureTransport,verifiedHttps } from "./ingress.js";
import { getSetting,ipAllowed,onAccessPolicyChange,readSecurityConfig } from "./config.js";
import { failedAttempt,banSeconds } from "./attempts.js";
import { signPayload,verifySignedPayload,verifyPassword } from "./crypto.js";

function conceal(reply:FastifyReply,mode:SecurityConfig["disguise"]) {
  reply.header("cache-control","no-store").header("referrer-policy","no-referrer").type("text/html");
  if (mode==="blank_200") return reply.code(200).send("");
  if (mode==="forbidden_403") return reply.code(403).send("<html><body>403 Forbidden</body></html>");
  return reply.code(404).send("<html><head><title>404 Not Found</title></head><body><center><h1>404 Not Found</h1></center><hr><center>nginx</center></body></html>");
}
const digest=(value:string)=>createHash("sha256").update(value).digest("hex");
export function registerPublicGate(app:FastifyInstance,ctx:ServerContext) {
  ctx.masker.register(process.env.CODEXDECK_MANAGED_PROXY_TOKEN);
  readSecurityConfig(ctx.native);
  let verifiedBasic="";
  const verifying=new Set<string>();
  const streams=new Set<Socket>();
  const unsubscribe=onAccessPolicyChange(ctx.native,()=>{for(const socket of streams) socket.destroy();});
  app.addHook("onClose",async()=>{unsubscribe();});
  app.addHook("onRequest",async(req,reply)=>{
    const config=readSecurityConfig(ctx.native);
    const route=req.routeOptions.url??"",pathname=req.url.split("?")[0];
    const internal=route.startsWith("/internal/")||pathname.startsWith("/internal/")||route==="/api/auth/setup";
    if(internal) return directLocal(req) && !(route==="/api/auth/setup" && config.public_enabled)?undefined:conceal(reply,config.disguise);
    // Loopback-only operational calls still have to authenticate in the corresponding handler.
    const hostOperation=route==="/api/admin/security/emergency" || route.startsWith("/api/admin/runtime/tasks");
    if(directLocal(req) && (route==="/api/health" || route==="/health" ||
      hostOperation && !req.headers.cookie && typeof req.headers["x-codexdeck-admin"]==="string")) return;
    const local=localPanel(req),ip=clientIp(req);
    if((!local && (!config.public_enabled || !verifiedHttps(req))) || !ipAllowed(config,ip)) return conceal(reply,config.disguise);
    const entry=config.entry_enabled && req.method==="GET" && pathname===config.entry_path;
    const machine=route.startsWith("/api/v1/") || route==="/api/dl/*";
    const invite=/^\/guest\/[A-Za-z0-9_-]{43}$/.test(pathname) && ["GET","POST"].includes(req.method);
    const entryFingerprint=digest(config.entry_path);
    if(config.entry_enabled && !entry && !machine && !invite && route!=="/api/guest/logout") {
      const proof=/(?:^|;\s*)cd_entry=([A-Za-z0-9_.-]{1,768})(?:;|$)/.exec(req.headers.cookie??"")?.[1];
      const grant=proof && verifySignedPayload(proof,ctx.masterKey);
      const admitted=grant && grant.aud==="security-entry" && grant.path===entryFingerprint && grant.ip===ip &&
        typeof grant.exp==="number" && grant.exp>Date.now();
      if(!admitted && !authenticated(ctx,req) && !getGuestSession(ctx,req)) return conceal(reply,config.disguise);
    }
    if(config.basic_enabled) {
      const auth=req.headers.authorization??"";
      const hash=getSetting(ctx.native,"security.basic_hash")??"";
      const marker=digest(hash+"\n"+config.basic_user+"\n"+auth);
      if(marker!==verifiedBasic) {
        const ban=banSeconds(ctx,ip,config);
        if(ban || verifying.has(ip) || verifying.size>=16) return reply.code(429).header("Retry-After",String(ban||1)).send();
        let valid=false;
        if(auth.startsWith("Basic ") && auth.length<=2048) {
          const decoded=Buffer.from(auth.slice(6),"base64").toString("utf8");
          const split=decoded.indexOf(":");
          verifying.add(ip);
          try {
            valid=split>0 && decoded.slice(0,split)===config.basic_user && await verifyPassword(decoded.slice(split+1),hash);
          } finally {verifying.delete(ip);}
          if(!valid) failedAttempt(ctx,ip,config);
        }
        if(!valid) return reply.code(401).header("WWW-Authenticate",'Basic realm="Restricted", charset="UTF-8"').send();
        const latest=readSecurityConfig(ctx.native);
        if(latest.basic_user!==config.basic_user || getSetting(ctx.native,"security.basic_hash")!==hash) return reply.code(401).send();
        verifiedBasic=marker;
      }
    }
    if(entry) {
      const ttl=1800,grant=signPayload({aud:"security-entry",path:entryFingerprint,ip,exp:Date.now()+ttl*1000},ctx.masterKey);
      return reply.header("set-cookie","cd_entry="+grant+"; Path=/; HttpOnly; SameSite=Strict; Max-Age="+ttl+(secureTransport(req)?"; Secure":""))
        .header("Referrer-Policy","no-referrer").header("cache-control","no-store").redirect("/");
    }
    if(!["GET","HEAD","OPTIONS"].includes(req.method)) {
      const origin=req.headers.origin && URL.parse(req.headers.origin);
      const scheme=verifiedHttps(req)?"https:":"http:";
      if(req.headers["sec-fetch-site"]==="cross-site" || req.headers.origin && (!origin || origin.host!==req.headers.host || origin.protocol!==scheme))
        return reply.code(403).send({error:"Invalid request origin."});
    }
    if(req.headers.upgrade || route==="/api/v1/tasks/:id/stream") {
      const socket=req.raw.socket;
      streams.add(socket);
      const forget=()=>{streams.delete(socket);socket.off("close",forget);};
      socket.once("close",forget);
      if(!req.headers.upgrade) reply.raw.once("close",forget);
    }
  });
}
