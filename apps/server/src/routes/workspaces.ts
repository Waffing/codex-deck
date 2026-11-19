import type { FastifyInstance } from "fastify";
import { agentsScopeSchema, agentsDocumentSchema, gitDiffQuerySchema, workspaceCloneSchema, workspaceCreateSchema } from "@codexdeck/shared";
import type { ServerContext } from "../app.js";
import { createRequireAdmin } from "../auth.js";
import type { WorkspaceFiles } from "../files/workspace-files.js";
import { fileError } from "../files/sandbox.js";
import { gitDiff, gitStatus } from "../files/git.js";

export function registerWorkspaceRoutes(app: FastifyInstance, ctx: ServerContext, files: WorkspaceFiles) {
  const auth = { preHandler: createRequireAdmin(ctx) };
  type ById = { Params: { id: string } };
  app.get("/api/workspaces", auth, async () => files.list());
  app.post("/api/workspaces", auth, async (req, reply) => {
    const p = workspaceCreateSchema.safeParse(req.body);
    if (!p.success) throw fileError(400, "Invalid workspace.");
    return reply.code(201).send(await files.create(p.data.name, p.data.automation_level));
  });
  app.post("/api/workspaces/clone", auth, async (req, reply) => {
    const p = workspaceCloneSchema.safeParse(req.body);
    if (!p.success) throw fileError(400, "Invalid repository.");
    const url = new URL(p.data.url);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw fileError(400, "Invalid repository URL.");
    return reply.code(202).send(await files.create(p.data.name, p.data.automation_level, url));
  });
  app.delete<ById>("/api/workspaces/:id", auth, async (req, reply) => {
    await files.unregister(req.params.id);
    return reply.code(204).send();
  });
  app.get<ById & { Querystring: { scope?: string } }>("/api/workspaces/:id/agents-md", auth, async req => {
    const p = agentsScopeSchema.safeParse(req.query.scope);
    if (!p.success) throw fileError(400, "Invalid scope.");
    return { scope: p.data, content: await files.agentsText(req.params.id, p.data) };
  });
  app.put<ById & { Querystring: { scope?: string }; Body: { scope?: string; content: string } }>("/api/workspaces/:id/agents-md", auth, async req => {
    const p = agentsDocumentSchema.safeParse({ scope: req.query.scope ?? req.body?.scope, content: req.body?.content });
    if (!p.success) throw fileError(400, "Invalid instructions.");
    await files.saveAgents(req.params.id, p.data.scope, p.data.content);
    return p.data;
  });
  app.get<ById>("/api/workspaces/:id/git/status", auth, async req => gitStatus(await files.getRoot(req.params.id)));
  app.get<ById & { Querystring: { format?: string } }>("/api/workspaces/:id/git/diff", auth, async (req, reply) => {
    const p = gitDiffQuerySchema.safeParse(req.query);
    if (!p.success) throw fileError(400, "Invalid diff format.");
    const patch = ctx.masker.maskString(await gitDiff(await files.getRoot(req.params.id)));
    if (p.data.format === "patch") return reply.type("text/x-patch").header("Content-Disposition",'attachment; filename="changes.patch"').send(patch);
    return { diff: patch };
  });
  app.post<{ Params: { id: string; ref: string } }>("/api/workspaces/:id/checkpoints/:ref/restore", auth, async req => {
    await files.restore(req.params.id, req.params.ref);
    return { restored: true };
  });
}
