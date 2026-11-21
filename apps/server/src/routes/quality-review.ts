import {createHash} from "node:crypto";
import type {AddressInfo} from "node:net";
import type {FastifyInstance} from "fastify";
import {crossModelReviewRequestSchema,handoffRequestSchema,parseDiffLines,reviewFeedbackSchema} from "@codexdeck/shared";
import type {ServerContext} from "../app.js";
import {createRequireAdmin} from "../auth.js";
import {summarizeContext} from "../codex/compact.js";
import {listReviews,reviewDiff,reviewThread,runReview} from "../codex/diff-review.js";
import type {ThreadManager} from "../codex/manager.js";
import {qualityError as fail} from "../codex/quality-model.js";
import type {WorkspaceFiles} from "../files/workspace-files.js";

type ById={Params:{id:string}};
export function registerQualityReviews(app:FastifyInstance,ctx:ServerContext,files:WorkspaceFiles,manager:ThreadManager) {
  const auth={preHandler:createRequireAdmin(ctx)};
  const port=()=>(app.server.address() as AddressInfo|null)?.port??ctx.gatewayConfig.port;
  app.get<ById & {Querystring:{turn_id?:string}}>("/api/threads/:id/review-diff",auth,async req=>
    reviewDiff(ctx,files,req.params.id,req.query.turn_id));
  app.get<ById>("/api/threads/:id/reviews",auth,async req=>listReviews(ctx,req.params.id));
  app.post<ById>("/api/threads/:id/reviews",auth,async req=>{
    const input=crossModelReviewRequestSchema.safeParse(req.body??{});
    if(!input.success) throw fail(400,"Invalid review request.");
    return runReview(ctx,files,port(),req.params.id,input.data);
  });
  app.post<ById>("/api/threads/:id/review-feedback",auth,async(req,reply)=>{
    const parsed=reviewFeedbackSchema.safeParse(req.body);
    if(!parsed.success) throw fail(400,"Invalid review feedback.");
    const id=req.params.id,input=parsed.data;
    const fingerprint=createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const replay=()=>{
      const prior=ctx.native.prepare(`SELECT t.id,t.status,t.review_feedback_hash FROM tasks t JOIN thread_turns s ON s.id=t.id
        WHERE t.thread_id=? AND s.client_msg_id=?`).get(id,input.client_msg_id) as {id:string;status:string;review_feedback_hash:string|null}|undefined;
      if(!prior) return;
      if(prior.review_feedback_hash!==fingerprint) throw fail(409,"Message ID already used for different feedback.");
      return {thread_id:id,task_id:prior.id,status:prior.status,client_msg_id:input.client_msg_id};
    };
    const prior=replay();
    if(prior) return reply.code(202).send(prior);
    const diff=await reviewDiff(ctx,files,id,input.turn_id);
    if(diff.diff_hash!==input.diff_hash) throw fail(409,"The patch changed. Refresh it and check your annotations.");
    const lines=parseDiffLines(diff.patch);
    const feedback:string[]=[];
    for(const note of input.annotations??[]) {
      const source=lines.find(row=>row.file===note.file && row.line===note.line && row.side===note.side);
      if(!source) throw fail(422,"Annotation does not refer to a changed line.");
      feedback.push(JSON.stringify({...note,code:source.text.slice(0,2048)}));
    }
    if(input.review_id) {
      const [review]=listReviews(ctx,id,input.review_id);
      if(!review || review.turn_id!==(input.turn_id??null) || review.diff_hash!==diff.diff_hash) throw fail(409,"Review does not match this patch.");
      for(const findingId of new Set(input.finding_ids)) {
        const f=review.findings.find(row=>row.id===findingId);
        if(!f) throw fail(422,"Unknown review finding.");
        feedback.push(JSON.stringify(f));
      }
    }
    const prompt=ctx.masker.maskString("请按以下已选中的代码审查意见修改并验证。每项都附有文件与行号。\n"+feedback.join("\n"));
    if(prompt.length>200000) throw fail(413,"Submit fewer review items together.");
    const task=ctx.native.transaction(()=>{
      const existing=replay();
      if(existing) return existing;
      const result=manager.submit(id,prompt,undefined,[],undefined,input.client_msg_id);
      ctx.native.prepare("UPDATE tasks SET review_feedback_hash=? WHERE id=?").run(fingerprint,result.task_id);
      return result;
    }).immediate();
    return reply.code(202).send(task);
  });
  app.post<ById>("/api/threads/:id/handoff",auth,async(req,reply)=>{
    const parsed=handoffRequestSchema.safeParse(req.body??{});
    if(!parsed.success) throw fail(400,"Invalid handoff request.");
    const input=parsed.data,id=req.params.id;
    const parent=reviewThread(ctx,id),alias=input.model_alias??parent.active_model_alias;
    if(!ctx.native.prepare("SELECT 1 FROM models m JOIN providers p ON p.id=m.provider_id WHERE m.alias=? AND m.enabled AND p.enabled").get(alias))
      throw fail(400,"Handoff model unavailable.");
    const lastTurn=()=>ctx.native.prepare("SELECT id FROM tasks WHERE thread_id=? ORDER BY rowid DESC LIMIT 1").pluck().get(id);
    const isBusy=()=>ctx.native.prepare("SELECT 1 FROM tasks WHERE thread_id=? AND status IN ('running','queued') LIMIT 1").get(id);
    if(isBusy()) throw fail(409,"Wait for the current turn before handoff.");
    const snapshot=lastTurn();
    const {summary}=await summarizeContext(ctx,id,alias,port(),{focus:input.focus_note});
    const result=ctx.native.transaction(()=>{
      if(isBusy() || lastTurn()!==snapshot) throw fail(409,"The source conversation changed during handoff.");
      const child=manager.createThread(parent.workspace_id,alias,(parent.title+" · 交接").slice(0,240));
      ctx.native.prepare("UPDATE threads SET parent_thread_id=?,handoff_doc=?,last_context_tokens=0 WHERE id=?").run(id,summary,child.id);
      return {thread_id:child.id,parent_thread_id:id,handoff_doc:summary};
    }).immediate();
    return reply.code(201).send(result);
  });
}
