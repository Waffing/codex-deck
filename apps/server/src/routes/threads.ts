import { approvalDecisionSchema, threadCreateSchema, threadMessageSchema, threadModelPatchSchema,threadCompactSchema,threadUpdateSchema } from "@codexdeck/shared";
import type { FastifyInstance } from "fastify";
import type { ServerContext } from "../app.js";
import { scopedAccess,scopedGuest } from "../temp-access/routes.js";
import type { ThreadManager } from "../codex/manager.js";
import {createRequireAdmin} from "../auth.js";
import {requireExecutor} from "../codex/execution-environment.js";
import {z} from "zod";

type ById = { Params: { id: string } };
export function registerThreadRoutes(app: FastifyInstance, context: ServerContext, manager: ThreadManager) {
  const auth = scopedAccess(context);
  app.get<{Querystring:{workspace_id?:string}}>("/api/threads",auth,async request => {
    const guest=scopedGuest(request);
    if(guest && !request.query.workspace_id)return guest.link.workspace_ids.flatMap(id=>manager.list(id));
    return manager.list(request.query.workspace_id);
  });
  app.post("/api/threads",auth,async (request,reply) => {
    const parsed = threadCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({error:"Invalid thread."});
    const p = parsed.data;
    return reply.code(201).send(manager.createThread(p.workspace_id,scopedGuest(request)?undefined:p.model_alias,p.title));
  });
  app.post<ById>("/api/threads/:id/messages",auth,async (request,reply) => {
    const parsed = threadMessageSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({error:"Invalid message."});
    const guest=scopedGuest(request);
    const id=request.params.id;
    if(!guest && context.native.prepare(`SELECT 1 FROM workspaces w JOIN threads t ON t.workspace_id=w.id
      WHERE t.id=? AND w.automation_level='unrestricted'
      AND NOT EXISTS (SELECT 1 FROM thread_turns WHERE thread_id=t.id AND client_msg_id=?)`)
      .get(id,parsed.data.client_msg_id??null)) {
      await requireExecutor(context.native);
    }
    return reply.code(202).send(manager.submit(id,parsed.data.prompt,undefined,parsed.data.image_ids,guest?.link.id,parsed.data.client_msg_id,{mode:parsed.data.mode}));
  });
  app.post<ById>("/api/threads/:id/warmup",auth,async(request,reply)=>{
    await manager.warmup(request.params.id);
    return reply.code(204).send();
  });
  app.patch<ById>("/api/threads/:id",auth,async(req,reply)=>{
    const input=threadUpdateSchema.safeParse(req.body);
    if(!input.success) return reply.code(400).send({error:"Invalid thread update."});
    return manager.updateThread(req.params.id,input.data.pinned,input.data.title,input.data.execution_mode);
  });
  const admin={preHandler:createRequireAdmin(context)};
  app.get<ById>("/api/threads/:id/quality",admin,async req=>manager.quality(req.params.id));
  const plan=z.object({turn_id:z.string().uuid()});
  app.post<ById>("/api/threads/:id/verify",admin,async(req,reply)=>{
    const input=plan.extend({reviewed:z.literal(true)}).strict().safeParse(req.body);
    if(!input.success) return reply.code(400).send({error:"Explicit workspace review required."});
    return reply.code(202).send(manager.verifyReviewed(req.params.id,input.data.turn_id));
  });
  app.post<ById>("/api/threads/:id/plan/approve",admin,async(req,reply)=>{
    const input=plan.strict().safeParse(req.body);
    if(!input.success) return reply.code(400).send({error:"Invalid plan."});
    return reply.code(202).send(manager.decidePlan(req.params.id,input.data.turn_id));
  });
  app.post<ById>("/api/threads/:id/plan/revise",admin,async(req,reply)=>{
    const input=plan.extend({feedback:z.string().trim().min(1).max(8192)}).strict().safeParse(req.body);
    if(!input.success) return reply.code(400).send({error:"Invalid revision."});
    return reply.code(202).send(manager.decidePlan(req.params.id,input.data.turn_id,input.data.feedback));
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
