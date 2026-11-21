import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { projectEvent, subscriptionSchema, type ThreadEvent } from "@codexdeck/shared";
import { authenticated, createRequireAdmin,bindAdminSocket } from "../auth.js";
import {getGuestSession,onLinkChange,visit} from "../temp-access/service.js";
import {threadWorkspace} from "../temp-access/routes.js";
import {clientIp} from "../security/ingress.js";
import type { ServerContext } from "../app.js";
import {safeAnswerFragments} from "../codex/timeline.js";

export class ThreadEvents {
  private readonly changes = new EventEmitter();
  constructor(private readonly ctx: ServerContext) { this.changes.setMaxListeners(0); }

  append(threadId: string, type: string, payload: unknown, taskId?: string | null): ThreadEvent {
    const db = this.ctx.native;
    const active = taskId === undefined ? db.prepare("SELECT id FROM tasks WHERE thread_id=? AND status='running'").pluck().get(threadId) as string | undefined : taskId;
    const event = db.transaction(() => {
      const seq = db.prepare("SELECT coalesce(max(sequence),0)+1 FROM thread_events WHERE thread_id=?").pluck().get(threadId) as number;
      const value: ThreadEvent = { thread_id: threadId, task_id: active ?? null, seq_id: seq, type: this.ctx.masker.maskString(type),
        payload: this.ctx.masker.maskObject(payload ?? null), created_at: new Date().toISOString() };
      db.prepare("INSERT INTO thread_events(id,thread_id,sequence,type,payload_json,task_id,created_at) VALUES(?,?,?,?,?,?,?)")
        .run(randomUUID(), threadId, seq, value.type, JSON.stringify(value.payload), value.task_id, value.created_at);
      return value;
    }).immediate();
    this.changes.emit("event", event);
    return event;
  }

  subscribe(listener: (e: ThreadEvent) => void) {
    this.changes.on("event", listener);
    return () => { this.changes.off("event", listener); };
  }

  follow(thread: string, after: number, send: (event: ThreadEvent) => void, task?: string, onCaughtUp?:()=>void) {
    let cursor=after, replaying=true, stopped=false, next:NodeJS.Immediate|undefined;
    const masker=this.ctx.masker;
    const parts=this.ctx.native.prepare(`SELECT sequence AS seq_id,type,payload_json FROM thread_events
      WHERE thread_id=? AND task_id=? AND type='item/agentMessage/delta' ORDER BY sequence`);
    let currentTask:string|null=null, replacements=new Map<number,string>();
    const query = this.ctx.native.prepare(`SELECT thread_id, task_id, sequence AS seq_id, type, payload_json, created_at
      FROM thread_events WHERE thread_id=? AND sequence>? AND (? IS NULL OR task_id=?) ORDER BY sequence LIMIT 64`);
    function replay() {
      if(stopped) return;
      const rows=query.all(thread,cursor,task ?? null,task ?? null) as Array<Omit<ThreadEvent,"payload"> & {payload_json:string}>;
      for (const {payload_json,...base} of rows) {
        if (stopped) return;
        const payload=masker.maskObject(JSON.parse(payload_json));
        if(base.task_id && base.type==="item/agentMessage/delta") {
          if(currentTask!==base.task_id) {
            currentTask=base.task_id;
            const deltas=parts.all(thread,currentTask) as {seq_id:number;type:string;payload_json:string}[];
            replacements=safeAnswerFragments(deltas.map(v=>({...base,seq_id:v.seq_id,type:v.type,payload:JSON.parse(v.payload_json)})),masker);
          }
          if(replacements.has(base.seq_id)) payload.delta=replacements.get(base.seq_id);
        }
        send({...base,payload}); cursor=base.seq_id;
      }
      if (rows.length===64) next=setImmediate(replay);
      else { replaying=false; onCaughtUp?.(); }
    }
    const off=this.subscribe(e=>{
      if (!replaying && e.thread_id===thread && (!task || e.task_id===task) && e.seq_id>cursor) { cursor=e.seq_id; send(e); }
    });
    next=setImmediate(replay);
    return ()=>{stopped=true;if(next)clearImmediate(next);off();};
  }
}

export function registerEventRoutes(app: FastifyInstance, ctx: ServerContext, events: ThreadEvents, runningServices = () => 0) {
  const ticks=()=>cpus().reduce((sum,cpu)=>({
    idle:sum.idle+cpu.times.idle,total:sum.total+Object.values(cpu.times).reduce((a,b)=>a+b,0),
  }),{idle:0,total:0});
  let previous=ticks(), sampledAt=Date.now(), cpuPercent:number|null=null;
  function heartbeat() {
    if(Date.now()-sampledAt>=250) {
      const current=ticks(), elapsed=current.total-previous.total;
      if(elapsed>0) cpuPercent=Math.round(100*(1-(current.idle-previous.idle)/elapsed));
      previous=current; sampledAt=Date.now();
    }
    const routable=ctx.native.prepare(`SELECT m.alias,m.last_probe_json FROM models m JOIN providers p ON p.id=m.provider_id
      WHERE m.enabled AND p.enabled ORDER BY (m.alias=(SELECT value FROM settings WHERE key='default_model')) DESC,m.created_at,m.id LIMIT 1`).get() as {alias:string;last_probe_json:string|null}|undefined;
    const probe=routable?.last_probe_json ? JSON.parse(routable.last_probe_json) : null;
    const recent=routable && ctx.native.prepare("SELECT status_code,error,created_at FROM usage_logs WHERE requested_alias=? ORDER BY created_at DESC LIMIT 1").get(routable.alias) as {status_code:number;error:string|null;created_at:string}|undefined;
    const useRecent=recent && (!probe || recent.created_at>=probe.checked_at);
    const checked=useRecent ? recent.created_at : probe?.checked_at??null;
    const healthy=useRecent ? recent.status_code>=200 && recent.status_code<300 : !!probe?.ok;
    const state=!routable?"unconfigured":!checked?"unverified":Date.now()-Date.parse(checked)>86400000?"stale":healthy?"verified":"failed";
    return { type:"heartbeat",timestamp:new Date().toISOString(),load:loadavg(),free_memory_bytes:freemem(),total_memory_bytes:totalmem(),
      cpu_percent:cpuPercent,running_services:runningServices(),gateway_healthy:state==="verified",gateway_state:state,
      gateway_checked_at:checked,gateway_error:useRecent ? recent.error : probe?.error??null };
  }
  app.get("/ws/events", {
    websocket: true, preValidation: async (req, reply) => {
      const origin = req.headers.origin;
      if (origin && URL.parse(origin)?.host !== req.headers.host) return reply.code(403).send();
      const guest=getGuestSession(ctx,req);
      if(guest){
        const {thread_id}=req.query as {thread_id?:string};
        if(thread_id && !guest.link.workspace_ids.includes(String(threadWorkspace(ctx,thread_id))))return reply.code(403).send();
        return;
      }
      return createRequireAdmin(ctx)(req, reply);
    },
  }, (socket: WebSocket, req) => {
    let unsubscribe: (() => void) | undefined;
    const guest=getGuestSession(ctx,req);
    if(!guest) bindAdminSocket(ctx,req,socket);
    let expiry:NodeJS.Timeout|undefined,workspace:string|undefined;
    const check=()=>{
      if(!guest)return authenticated(ctx,req);
      const session=getGuestSession(ctx,req);
      if(!session){socket.close(1008,"Guest access ended");return false;}
      return true;
    };
    function listenExpiry(){
      if(!guest)return;
      clearTimeout(expiry);
      if(!check())return;
      const session=getGuestSession(ctx,req)!;
      expiry=setTimeout(listenExpiry,Math.max(1,Math.min(2147483647,Date.parse(session.link.expires_at)-Date.now())));expiry.unref();
    }
    const offGuest=guest && onLinkChange(ctx,guest.link.id,listenExpiry);
    listenExpiry();
    const send = (frame: unknown) => {
      if (socket.readyState !== 1) return;
      if (!check()) { socket.close(1008, "Session expired"); return; }
      if (socket.bufferedAmount > 2 * 1024 * 1024) { socket.close(1013, "Reconnect with last_seq_id"); return; }
      socket.send(JSON.stringify(frame));
    };
    const counts = () => send({ type: "approvals_count", count: ctx.native.prepare("SELECT count(*) FROM approvals WHERE status='pending'").pluck().get() });
    const subscribe = (input: unknown) => {
      const parsed = subscriptionSchema.safeParse(input);
      if (!parsed.success) { socket.close(1008, "Invalid subscription"); return; }
      unsubscribe?.();
      unsubscribe = undefined;
      if(guest && parsed.data.thread_id) {
        workspace=String(threadWorkspace(ctx,parsed.data.thread_id));
        if(!guest.link.workspace_ids.includes(workspace) || parsed.data.debug){socket.close(1008,"Scope denied");return;}
        visit(ctx,guest,clientIp(req),workspace);
      }
      if (parsed.data.thread_id) unsubscribe = events.follow(parsed.data.thread_id, parsed.data.last_seq_id, raw => {
        const event=projectEvent(raw,parsed.data.debug);
        if (event) send({type:"event",event});
        else send({type:"cursor",seq_id:raw.seq_id,thread_id:raw.thread_id});
      });
    };
    const query = req.query as { thread_id?: string; last_seq_id?: string;debug?:string };
    subscribe({ type: "subscribe", thread_id: query.thread_id, last_seq_id: Number(query.last_seq_id ?? 0),debug:query.debug==="true" });
    if(!guest){counts();send(heartbeat());}
    const offCounts = events.subscribe(e => {
      if(guest){
        if (/^(task_|model_changed)/.test(e.type) && guest.link.workspace_ids.includes(String(threadWorkspace(ctx,e.thread_id))))send({type:"thread_changed",thread_id:e.thread_id});
        return;
      }
      if (e.type.startsWith("approval")) counts();
      if (/^(approval|task_|model_changed)/.test(e.type)) send({type:"thread_changed",thread_id:e.thread_id});
    });
    socket.on("message", data => { try { subscribe(JSON.parse(data.toString())); } catch { socket.close(1008, "Invalid frame"); } });
    const timer = setInterval(() => {
      if(guest){if(check()){visit(ctx,guest,clientIp(req),workspace);send({type:"guest_status",link:getGuestSession(ctx,req)!.link});}}
      else send(heartbeat());
    }, 10000);
    timer.unref();
    socket.once("close", () => { clearInterval(timer);clearTimeout(expiry);offGuest?.(); unsubscribe?.(); offCounts(); });
  });
}
