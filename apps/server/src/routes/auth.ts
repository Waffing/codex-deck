import type { FastifyInstance } from "fastify";
import { authLoginRequestSchema, authSetupRequestSchema, authPasswordChangeSchema } from "@codexdeck/shared";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import { hashPassword, verifyPassword } from "../security/crypto.js";
import { authenticated, clearSessionCookie, setSessionCookie } from "../auth.js";
import type { ServerContext } from "../app.js";

export function installationCode(native: Database.Database, key: Buffer): string {
  native.prepare("INSERT OR IGNORE INTO settings(key,value,updated_at) VALUES('setup_nonce',?,?)")
    .run(randomBytes(24).toString("hex"), new Date().toISOString());
  const nonce = native.prepare("SELECT value FROM settings WHERE key='setup_nonce'").pluck().get();
  return createHmac("sha256",key).update("admin-setup:"+nonce).digest("base64url");
}

function getAdminPasswordHash(context: ServerContext): string | null {
  const row = context.native.prepare("SELECT value FROM settings WHERE key = 'admin_password_hash'").get() as { value: string } | undefined;
  return row?.value ?? null;
}

export function registerAuthRoutes(app: FastifyInstance, context: ServerContext): void {
  const code = getAdminPasswordHash(context) ? "" : installationCode(context.native,context.masterKey);
  if (code) context.masker.register(code);
  // There is one administrator. Count attempts across all addresses, including proxy connections.
  let attempts = 0, resetAt = 0;
  const allowed = () => {
    if (Date.now() >= resetAt) { attempts=0; resetAt=Date.now()+60_000; }
    return ++attempts <= 12;
  };
  app.get("/api/auth/status", async (request) => ({ authenticated: authenticated(context, request), setup_required: !getAdminPasswordHash(context) }));

  app.post("/api/auth/setup", async (request, reply) => {
    if (getAdminPasswordHash(context)) return reply.code(409).send({ error: "Administrator is already configured." });
    const parsed = authSetupRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid setup request." });
    const supplied = Buffer.from(parsed.data.setup_code);
    if (!code || supplied.length !== Buffer.byteLength(code) || !timingSafeEqual(Buffer.from(code),supplied))
      return reply.code(403).send({error:"Invalid installation code."});

    const passwordHash = await hashPassword(parsed.data.password);
    const inserted = context.native.prepare(`INSERT OR IGNORE INTO settings(key, value, updated_at) VALUES ('admin_password_hash', ?, ?)`)
      .run(passwordHash, new Date().toISOString());
    if (!inserted.changes) return reply.code(409).send({ error: "Administrator is already configured." });
    context.native.prepare("DELETE FROM settings WHERE key='setup_nonce'").run();
    setSessionCookie(context, reply);
    return { authenticated: true, setup_required: false };
  });

  app.post("/api/auth/login", async (request, reply) => {
    const parsed = authLoginRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid login request." });
    if (!allowed()) return reply.code(429).header("Retry-After",String(Math.ceil((resetAt-Date.now())/1000))).send({error:"Too many login attempts."});
    const passwordHash = getAdminPasswordHash(context);
    if (!passwordHash || !(await verifyPassword(parsed.data.password, passwordHash))) {
      return reply.code(401).send({ error: "Invalid credentials." });
    }
    if (getAdminPasswordHash(context) !== passwordHash) return reply.code(401).send({error:"Credentials changed."});
    attempts=0;
    setSessionCookie(context, reply);
    return { authenticated: true, setup_required: false };
  });
  app.post("/api/auth/password", async (request,reply) => {
    if (!authenticated(context,request)) return reply.code(401).send({error:"Authentication required."});
    const parsed=authPasswordChangeSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({error:"Invalid password change."});
    if (!allowed()) return reply.code(429).send({error:"Too many password attempts."});
    const old=getAdminPasswordHash(context);
    if (!old || !await verifyPassword(parsed.data.current_password,old)) return reply.code(403).send({error:"Incorrect current password."});
    const next=await hashPassword(parsed.data.new_password);
    const changed=context.native.transaction(()=>{
      if (!context.native.prepare("UPDATE settings SET value=?,updated_at=? WHERE key='admin_password_hash' AND value=?").run(next,new Date().toISOString(),old).changes) return false;
      context.native.prepare("DELETE FROM settings WHERE key LIKE 'session:%'").run();
      return true;
    })();
    if (!changed) return reply.code(409).send({error:"Credentials already changed."});
    attempts=0;
    setSessionCookie(context,reply);
    return {changed:true};
  });

  app.post("/api/auth/logout", async (request, reply) => {
    clearSessionCookie(context, request, reply);
    return { authenticated: false, setup_required: !getAdminPasswordHash(context) };
  });
}
