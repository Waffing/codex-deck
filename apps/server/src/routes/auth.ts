import type { FastifyInstance } from "fastify";
import { authLoginRequestSchema, authSetupRequestSchema } from "@codexdeck/shared";
import { hashPassword, verifyPassword } from "../security/crypto.js";
import { authenticated, clearSessionCookie, setSessionCookie } from "../auth.js";
import type { ServerContext } from "../app.js";

function getAdminPasswordHash(context: ServerContext): string | null {
  const row = context.native.prepare("SELECT value FROM settings WHERE key = 'admin_password_hash'").get() as { value: string } | undefined;
  return row?.value ?? null;
}

export function registerAuthRoutes(app: FastifyInstance, context: ServerContext): void {
  app.get("/api/auth/status", async (request) => ({ authenticated: authenticated(context, request), setup_required: !getAdminPasswordHash(context) }));

  app.post("/api/auth/setup", async (request, reply) => {
    const parsed = authSetupRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid setup request." });
    if (getAdminPasswordHash(context)) return reply.code(409).send({ error: "Administrator is already configured." });

    const passwordHash = await hashPassword(parsed.data.password);
    const inserted = context.native.prepare(`INSERT OR IGNORE INTO settings(key, value, updated_at) VALUES ('admin_password_hash', ?, ?)`)
      .run(passwordHash, new Date().toISOString());
    if (!inserted.changes) return reply.code(409).send({ error: "Administrator is already configured." });
    setSessionCookie(context, reply);
    return { authenticated: true, setup_required: false };
  });

  app.post("/api/auth/login", async (request, reply) => {
    const parsed = authLoginRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid login request." });
    const passwordHash = getAdminPasswordHash(context);
    if (!passwordHash || !(await verifyPassword(parsed.data.password, passwordHash))) {
      return reply.code(401).send({ error: "Invalid credentials." });
    }
    setSessionCookie(context, reply);
    return { authenticated: true, setup_required: false };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    clearSessionCookie(context, request, reply);
    return { authenticated: false, setup_required: !getAdminPasswordHash(context) };
  });
}
