import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ServerContext } from "./app.js";

const cookieName = "codexdeck_session";
const ttl = 12 * 60 * 60;
function transportFlags(reply: FastifyReply) {
  return reply.request.protocol === "https" || process.env.CODEXDECK_COOKIE_SECURE === "true" || !!process.env.CODEXDECK_DOMAIN ? "; Secure" : "";
}

function cookieKey(request: FastifyRequest): string | undefined {
  const token = /(?:^|;\s*)codexdeck_session=([A-Za-z0-9_-]{43})(?:;|$)/.exec(request.headers.cookie ?? "")?.[1];
  return token && "session:" + createHash("sha256").update(token).digest("hex");
}

export function authenticated(context: ServerContext, request: FastifyRequest): boolean {
  const key = cookieKey(request);
  return !!key && !!context.native.prepare("SELECT 1 FROM settings WHERE key = ? AND value > ?")
    .get(key, new Date().toISOString());
}

export function setSessionCookie(context: ServerContext, reply: FastifyReply): void {
  const token = randomBytes(32).toString("base64url");
  const key = "session:" + createHash("sha256").update(token).digest("hex");
  const now = Date.now();
  context.native.prepare("DELETE FROM settings WHERE key LIKE 'session:%' AND value <= ?").run(new Date(now).toISOString());
  context.native.prepare("INSERT INTO settings(key,value,updated_at) VALUES(?,?,?)")
    .run(key, new Date(now + ttl * 1000).toISOString(), new Date(now).toISOString());
  reply.header("set-cookie", cookieName + "=" + token + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=" + ttl + transportFlags(reply));
}

export function clearSessionCookie(context: ServerContext, request: FastifyRequest, reply: FastifyReply): void {
  const key = cookieKey(request);
  if (key) context.native.prepare("DELETE FROM settings WHERE key = ?").run(key);
  reply.header("set-cookie", cookieName + "=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0" + transportFlags(reply));
}

export function createRequireAdmin(context: ServerContext) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!authenticated(context, request)) return reply.code(401).send({ error: "Authentication required." });
  };
}
