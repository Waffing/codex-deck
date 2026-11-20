import { approvalDecisionSchema, threadCreateSchema, threadMessageSchema, threadModelPatchSchema,threadCompactSchema,threadUpdateSchema } from "@codexdeck/shared";
import type { FastifyInstance } from "fastify";
import type { ServerContext } from "../app.js";
import { createRequireAdmin } from "../auth.js";
import type { ThreadManager } from "../codex/manager.js";

type ById = { Params: { id: string } };
export function registerThreadRoutes(app: FastifyInstance, context: ServerContext, manager: ThreadManager) {
  const auth = { preHandler:createRequireAdmin(context) };
  app.get<{Querystring:{workspace_id?:string}}>("/api/threads",auth,async request => manager.list(request.query.workspace_id));
  app.post("/api/threads",auth,async (request,reply) => {
    const parsed = threadCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({error:"Invalid thread."});
    const p = parsed.data;
    return reply.code(201).send(manager.createThread(p.workspace_id,p.model_alias,p.title));
  });
  app.post<ById>("/api/threads/:id/messages",auth,async (request,reply) => {
    const parsed = threadMessageSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({error:"Invalid message."});
    return reply.code(202).send(manager.submit(request.params.id,parsed.data.prompt,undefined,parsed.data.image_ids));
  });
  app.patch<ById>("/api/threads/:id",auth,async(req,reply)=>{
    const input=threadUpdateSchema.safeParse(req.body);
    if(!input.success) return reply.code(400).send({error:"Invalid thread update."});
    return manager.updateThread(req.params.id,input.data.pinned,input.data.title);
  });
  app.delete<ById>("/api/threads/:id",auth,async(req,reply)=>{
    await manager.deleteThread(req.params.id);return reply.code(204).send();
  });
  app.post<ById>("/api/threads/:id/compact",auth,async(req,reply)=>{
    const input=threadCompactSchema.safeParse(req.body??{});
    if(!input.success) return reply.code(400).send({error:"Invalid compaction options."});
    return manager.compact(req.params.id,input.data.model_alias);
  });
  app.post<ById>("/api/threads/:id/interrupt",auth,async (request,reply) => {
    await manager.interrupt(request.params.id);
    return reply.code(204).send();
  });
  app.post<ById>("/api/threads/:id/inject",auth,async (request,reply) => {
    const parsed = threadMessageSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({error:"Invalid message."});
    await manager.inject(request.params.id,parsed.data.prompt,parsed.data.image_ids);
    return reply.code(204).send();
  });
  app.patch<ById>("/api/threads/:id/model",auth,async (request,reply) => {
    const parsed = threadModelPatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({error:"Invalid model selection."});
    return manager.setModel(request.params.id,parsed.data.model_alias,parsed.data.reasoning_effort);
  });
  app.get("/api/approvals",auth,async () => manager.approvals.list());
  app.post<ById>("/api/approvals/:id/decision",auth,async (request,reply) => {
    const parsed = approvalDecisionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({error:"Invalid approval decision."});
    manager.approvals.decide(request.params.id,parsed.data);
    return reply.code(204).send();
  });
}
