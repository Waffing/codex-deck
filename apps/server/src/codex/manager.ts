import { createHash, randomUUID, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { threadSchema, type Thread, type TurnTelemetry, type ApprovalDecision } from "@codexdeck/shared";
import type { ServerContext } from "../app.js";
import type { WorkspaceFiles } from "../files/workspace-files.js";
import { generateCodexConfig } from "./config-gen.js";
import { RpcClient, type Json, type RpcId } from "./rpc-client.js";
import { ApprovalEngine, type EventSink, type NoticeSink } from "./approval.js";
import { WorkspaceQueue } from "./queue.js";
import { snapshotFiles } from "../files/tracker.js";
import { signPayload } from "../security/crypto.js";
import { OutputMasker } from "./output-masker.js";
import {summarizeContext} from "./compact.js";
import {completeAnswer,turnMetrics} from "./timeline.js";
import {assertGuestTurn,finishGuestTurn,taskLink} from "../temp-access/service.js";
import {runGuestTurn} from "../temp-access/turn.js";

export interface ManagerOptions {
  dataDirectory: string; workspaceRoot?: string; port?: () => number; codexBin?: string; opsEntry?: string;
  approvalTimeoutMs?: number; notifyAfterMs?: number; profile?: () => unknown;
}

type Files = Pick<WorkspaceFiles, "getRoot" | "beforeTurn" | "afterTurn" | "agentsText" | "openArtifact">;
type ThreadRow = Thread & { remote_thread_id: string | null; codex_home: string | null };
type Terminal = "completed" | "failed" | "cancelled";
type Turn = { taskId: string; threadId: string; workspaceId: string; prompt: string; imageIds:string[]; remoteId?: string;
  modelAlias?:string|null; startedAt?:number; guestAbort?:AbortController;
  cancelled: boolean; summary: string; done: Promise<Terminal>; finish: (status: Terminal) => void };
type Session = { client: RpcClient; remoteId:string; settings:Json; catalog:string; leases:Record<"model"|"ops",string>; idle?:NodeJS.Timeout };
type Compacted=Omit<Awaited<ReturnType<typeof summarizeContext>>,"taskId">;

function error(statusCode: number, message: string) { return Object.assign(new Error(message),{statusCode}); }
function textInput(text: string) { return [{ type: "text", text, text_elements: [] }]; }
// Historical notifications predate the denormalized thread fields. Use the event cursor to invalidate old reports on model change.
const threadUsageColumns=`coalesce((SELECT max(sequence) FROM thread_events WHERE thread_id=t.id AND type='model_changed'
  AND coalesce(json_extract(payload_json,'$.alias_changed'),1)),0)`;
const effectiveWindow=`(SELECT json_extract(e.payload_json,'$.tokenUsage.modelContextWindow') FROM thread_events e
  WHERE e.thread_id=t.id AND e.type='thread/tokenUsage/updated' AND e.sequence>${threadUsageColumns}
  AND coalesce(json_extract(e.payload_json,'$.model_alias'),t.active_model_alias)=t.active_model_alias
  AND json_type(e.payload_json,'$.tokenUsage.modelContextWindow')='integer' AND json_extract(e.payload_json,'$.tokenUsage.modelContextWindow')>0 ORDER BY e.sequence DESC LIMIT 1)`;

export class ThreadManager {
  readonly approvals: ApprovalEngine;
  private queue:WorkspaceQueue;
  private readonly queueLimit:number;
  private readonly idleMs:number;
  private sessions = new Map<string, Session>();
  private startingClients = new Map<string,RpcClient>();
  private connecting = new Map<string, Promise<Session>>();
  private jobs = new Map<string, Turn>();
  private active = new Map<string, Turn>();
  private readonly compacting=new Map<string,Promise<Compacted>>();
  private fileChanges = new Map<string, Map<string, unknown[]>>();
  private stopping = false;
  private recovered = false;

  constructor(private context: ServerContext, private files: Files, private events: EventSink,
    private notifications: NoticeSink, private options: ManagerOptions) {
    this.approvals = new ApprovalEngine(context,events,notifications,options.approvalTimeoutMs,options.notifyAfterMs);
    const setting = (name:string, fallback:number) => {
      const value=Number(process.env[name] ?? fallback);
      if (!Number.isSafeInteger(value) || value<1) throw new Error("Invalid setting: "+name);
      return value;
    };
    this.queue=new WorkspaceQueue(setting("CODEXDECK_MAX_ACTIVE_TASKS",2));
    this.queueLimit=setting("CODEXDECK_MAX_TASKS",64);
    this.idleMs=setting("CODEXDECK_IDLE_SESSION_MS",300000);
    context.resolveSessionLease=(credential,kind)=>{
      for (const [id,session] of this.sessions) {
        const turn=this.active.get(id);
        if (this.stopping || !session.client.alive || !turn || turn.cancelled || credential!==session.leases[kind] || taskLink(context,turn.taskId)) continue;
        const now=Math.floor(Date.now()/1000);
        return signPayload({aud:kind==="model"?"codexdeck-internal":"codexdeck-ops",thread_id:id,task_id:turn.taskId,
          nonce:randomUUID(),iat:now,exp:now+context.gatewayConfig.internal_token_ttl_seconds},context.masterKey);
      }
      return null;
    };
  }

  private row(id: string) {
    const row = this.context.native.prepare(`SELECT t.*,${threadUsageColumns} AS model_changed_seq,${effectiveWindow} AS effective_context_window FROM threads t WHERE t.id=?`).get(id) as ThreadRow | undefined;
    if (!row) throw error(404,"Thread not found.");
    return row;
  }

  list(workspaceId?: string) {
    const sql = `SELECT t.*,${threadUsageColumns} AS model_changed_seq,${effectiveWindow} AS effective_context_window, (SELECT s.status FROM tasks s WHERE s.thread_id=t.id
      ORDER BY CASE s.status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END,s.created_at DESC,s.rowid DESC
      LIMIT 1) AS task_status FROM threads t` + (workspaceId ? " WHERE t.workspace_id=?" : "") + " ORDER BY t.created_at,t.id";
    const rows = this.context.native.prepare(sql).all(...workspaceId ? [workspaceId] : []) as (ThreadRow & {task_status:string|null})[];
    return rows.map(row=>threadSchema.parse({...row,status:["queued","running","failed"].includes(row.task_status ?? "") ? row.task_status : row.status}));
  }

  private modelName(preferred?: string) {
    const model = this.context.native.prepare(`SELECT m.alias FROM models m JOIN providers p ON p.id=m.provider_id
      WHERE p.enabled AND m.enabled AND (? IS NULL OR m.alias=?) ORDER BY m.created_at,m.id LIMIT 1`).pluck().get(preferred ?? null,preferred ?? null);
    if (!model) throw error(400,"No matching enabled model.");
    return String(model);
  }

  createThread(workspaceId: string, modelAlias?: string, title = "New thread"): Thread {
    if (!this.context.native.prepare("SELECT id FROM workspaces WHERE id=?").get(workspaceId)) throw error(404,"Workspace unavailable.");
    const preferred = modelAlias ?? this.context.native.prepare("SELECT value FROM settings WHERE key='default_model'").pluck().get() as string | undefined;
    const id = randomUUID(), now = new Date().toISOString();
    this.context.native.prepare(`INSERT INTO threads(id,workspace_id,title,status,active_model_alias,created_at,updated_at)
      VALUES(?,?,?,'idle',?,?,?)`).run(id,workspaceId,title,this.modelName(preferred),now,now);
    return threadSchema.parse(this.row(id));
  }

  setModel(id: string, alias?: string, effort?: string | null) {
    if(this.compacting.has(id)) throw error(409,"Thread is compacting.");
    const row = this.row(id);
    const model = alias ? this.modelName(alias) : row.active_model_alias;
    const changed=model!==row.active_model_alias;
    this.context.native.prepare("UPDATE threads SET active_model_alias=?,reasoning_effort=?,last_context_tokens=CASE WHEN ? THEN NULL ELSE last_context_tokens END,updated_at=? WHERE id=?")
      .run(model,effort === undefined ? row.reasoning_effort : effort,Number(changed),new Date().toISOString(),id);
    this.events.append(id,"model_changed",{model_alias:model,alias_changed:changed,reasoning_effort:effort??row.reasoning_effort});
    return threadSchema.parse(this.row(id));
  }

  private imageTypes(row:ThreadRow, ids:string[]) {
    if (!ids.length) return [];
    const probe=this.context.native.prepare("SELECT last_probe_json FROM models WHERE alias=?").pluck().get(row.active_model_alias);
    if (typeof probe !== "string" || JSON.parse(probe)?.capabilities?.vision!==true) throw error(422,"The selected model has not verified image support.");
    return ids.map(id=>{
      const mime=this.context.native.prepare("SELECT mime_type FROM artifacts WHERE id=? AND workspace_id=? AND change_type='upload'")
        .pluck().get(id,row.workspace_id);
      if (typeof mime!=="string" || !["image/png","image/jpeg","image/webp","image/gif"].includes(mime)) throw error(400,"Invalid image upload.");
      return mime;
    });
  }

  private async userInput(row:ThreadRow,prompt:string,ids:string[]) {
    const input:Array<Record<string,unknown>>=prompt ? textInput(prompt) : [];
    const types=this.imageTypes(row,ids);
    let length=0;
    for (const [index,id] of ids.entries()) {
      const file=await this.files.openArtifact(id);
      try {
        length+=(await file.stat()).size;
        if (length>16*1024*1024) throw error(413,"Images exceed the 16 MiB input limit.");
        input.push({type:"image",url:`data:${types[index]};base64,${(await file.readFile()).toString("base64")}`});
      } finally { await file.close(); }
    }
    return input;
  }

  submit(threadId: string, prompt: string, taskId: string = randomUUID(), imageIds:string[] = [], guestId?:string) {
    if(this.compacting.has(threadId)) throw error(409,"Thread is compacting.");
    if (this.stopping) throw error(503,"Manager is shutting down.");
    if (this.jobs.size>=this.queueLimit) throw error(429,"Task queue is full.");
    const row = this.row(threadId);
    this.imageTypes(row,imageIds);
    if (!row.workspace_id) throw error(404,"Workspace unavailable.");
    const now = new Date().toISOString();
    const safePrompt = this.context.masker.maskString(prompt);
    const workspace=row.workspace_id;
    this.context.native.transaction(()=>{
      if(guestId) assertGuestTurn(this.context,guestId,workspace);
      this.context.native.prepare(`INSERT INTO tasks(id,thread_id,workspace_id,prompt,status,summary,created_at,updated_at,image_ids_json,guest_link_id)
        VALUES(?,?,?,?,'queued','',?,?,?,?)`).run(taskId,threadId,workspace,safePrompt,now,now,JSON.stringify(imageIds),guestId??null);
    }).immediate();
    this.events.append(threadId,"task_queued",{task_id:taskId},taskId);
    this.enqueue(row.workspace_id, threadId, taskId, prompt,imageIds);
    return { task_id:taskId,thread_id:threadId,status:"queued" as const };
  }

  private enqueue(workspaceId: string, threadId: string, taskId: string, prompt: string,imageIds:string[]) {
    let finish!: Turn["finish"];
    const done = new Promise<Terminal>(resolve => { finish = resolve; });
    const turn: Turn = { taskId,threadId,workspaceId,prompt,imageIds,cancelled:false,summary:"",done,finish };
    this.jobs.set(taskId,turn);
    this.queue.enqueue(workspaceId,{ id:taskId, run:() => this.run(turn) });
  }

  /** A previous host may have stopped after side effects. Only unstarted work can be replayed. */
  recover() {
    if (this.recovered) return;
    this.recovered = true;
    const db = this.context.native;
    const now = new Date().toISOString();
    const staleApprovals = db.prepare("SELECT id,thread_id FROM approvals WHERE status='pending'").all() as
      Array<{id: string; thread_id: string}>;
    for (const item of staleApprovals) {
      db.prepare("UPDATE approvals SET status='disconnected',resolved_at=? WHERE id=?").run(now,item.id);
      this.events.append(item.thread_id,"approval_resolved",{id:item.id,decision:"disconnected"});
    }
    const previous = db.prepare("SELECT id,thread_id,workspace_id,prompt,status,image_ids_json FROM tasks WHERE status IN ('queued','running') ORDER BY rowid").all() as
      Array<{id: string; thread_id: string; workspace_id: string; prompt: string; status: string; image_ids_json:string}>;
    for (const task of previous) {
      if (this.jobs.has(task.id)) continue;
      if (task.status === "queued") { this.enqueue(task.workspace_id,task.thread_id,task.id,task.prompt,JSON.parse(task.image_ids_json)); continue; }
      const summary = "The host stopped during execution.";
      db.transaction(()=>{
        db.prepare("UPDATE tasks SET status='failed',summary=?,updated_at=? WHERE id=?").run(summary,now,task.id);
        finishGuestTurn(this.context,task.id);
      })();
      db.prepare("UPDATE threads SET status='idle',updated_at=? WHERE id=?").run(now,task.thread_id);
      const result = {thread_id:task.thread_id,task_id:task.id,workspace_id:task.workspace_id,status:"failed",summary};
      this.events.append(task.thread_id,"task_failed",result,task.id);
      void this.notifications.send("task_failed",result);
    }
  }

  private terminal(turn: Turn, status: Terminal) {
    if (!this.jobs.delete(turn.taskId)) return;
    const summary = this.context.masker.maskString(turn.summary);
    const now = new Date().toISOString();
    this.context.native.transaction(()=>{
      this.context.native.prepare("UPDATE tasks SET status=?,summary=?,updated_at=? WHERE id=?").run(status,summary,now,turn.taskId);
      finishGuestTurn(this.context,turn.taskId);
    })();
    const event = { task_id:turn.taskId,thread_id:turn.threadId,workspace_id:turn.workspaceId,status,summary };
    this.events.append(turn.threadId,"task_" + status,event,turn.taskId);
    void this.notifications.send("task_" + status,event);
  }

  private async run(turn: Turn) {
    const started=Date.now();
    const { threadId, workspaceId, taskId } = turn;
    if (!this.context.native.prepare("SELECT 1 FROM tasks WHERE id=?").get(taskId)) { this.jobs.delete(taskId); return; }
    turn.startedAt=started;
    this.active.set(threadId,turn);
    let snapshot: Awaited<ReturnType<Files["beforeTurn"]>> | undefined;
    let terminal: Terminal = "failed";
    try {
      if (this.stopping || turn.cancelled) { terminal = "cancelled"; return; }
      const now = new Date().toISOString();
      this.context.native.prepare("UPDATE tasks SET status='running',updated_at=? WHERE id=?").run(now,taskId);
      this.context.native.prepare("UPDATE threads SET status='running',updated_at=? WHERE id=?").run(now,threadId);
      this.events.append(threadId,"task_started",{task_id:taskId},taskId);
      const guest=taskLink(this.context,taskId);
      if(guest && guest.status!=="active") throw error(403,"Guest access ended.");
      snapshot = await this.files.beforeTurn(workspaceId,threadId,taskId);
      if(guest){
        turn.guestAbort=new AbortController();
        if(turn.cancelled || this.stopping) {terminal="cancelled";return;}
        const row=this.row(threadId),input=await this.userInput(row,turn.prompt,turn.imageIds);
        await runGuestTurn(this.context,{linkId:guest.id,root:await this.files.getRoot(workspaceId),workspace:workspaceId,
          thread:threadId,task:taskId,port:this.options.port?.()??this.context.gatewayConfig.port,model:row.active_model_alias!,
          input:input.map(part=>part.type==="image"?{type:"input_image",image_url:part.url}:{type:"input_text",text:part.text}),
          approvals:this.approvals,events:this.events,signal:turn.guestAbort.signal});
        terminal="completed";return;
      }
      const session = await this.connect(threadId);
      if (this.stopping || turn.cancelled) { terminal = "cancelled"; return; }
      const row = this.row(threadId);
      turn.modelAlias=row.active_model_alias;
      const response = await session.client.call("turn/start", {
        threadId:session.remoteId, input:await this.userInput(row,turn.prompt,turn.imageIds), ...(row.reasoning_effort && { effort:row.reasoning_effort }),
      });
      turn.remoteId = String((response.turn as Json).id);
      if (turn.cancelled) await this.interrupt(threadId);
      terminal = await turn.done;
    } catch (err) {
      terminal = turn.cancelled || this.stopping ? "cancelled" : "failed";
      turn.summary = err instanceof Error ? err.message : "Codex turn failed.";
    } finally {
      this.approvals.disconnect(threadId);
      if (snapshot !== undefined) {
        try { await this.files.afterTurn(workspaceId,threadId,taskId,snapshot); }
        catch { terminal = "failed"; turn.summary = "Could not record workspace artifacts."; }
      }
      this.active.delete(threadId);
      const db=this.context.native;
      const answer=completeAnswer(db,threadId,taskId,this.context.masker);
      if(answer) {
        db.prepare("UPDATE tasks SET answer_markdown=? WHERE id=?").run(answer,taskId);
        if(terminal==="completed") turn.summary=answer.slice(-8192);
      }
      const patch=db.prepare("SELECT turn_diff_json FROM tasks WHERE id=?").pluck().get(taskId) as string|null;
      const {files,diff}=patch?JSON.parse(patch):{files:[],diff:""};
      this.events.append(threadId,"turn_telemetry",turnMetrics(db,threadId,taskId,started,files,diff),taskId);
      const session=this.sessions.get(threadId);
      if (session) {
        if (turn.cancelled) { this.sessions.delete(threadId); await session.client.close(); }
        else {
          session.idle=setTimeout(()=>{
            if (this.active.has(threadId) || this.sessions.get(threadId)!==session) return;
            this.sessions.delete(threadId); void session.client.close();
          },this.idleMs);
          session.idle.unref();
        }
      }
      this.fileChanges.delete(threadId);
      this.context.native.prepare("UPDATE threads SET status='idle',updated_at=? WHERE id=?").run(new Date().toISOString(),threadId);
      this.terminal(turn,terminal);
    }
  }

  private connect(threadId: string): Promise<Session> {
    if (this.stopping) return Promise.reject(error(503,"Manager closed."));
    const prior = this.sessions.get(threadId);
    if (prior?.client.alive && prior.catalog===this.catalogLimits(threadId)) { clearTimeout(prior.idle); return Promise.resolve(prior); }
    const existing = this.connecting.get(threadId);
    if (existing) return existing;
    const open = async () => {
      if (prior) { this.sessions.delete(threadId); await prior.client.close(); }
      return this.open(threadId);
    };
    const pending = open().finally(() => this.connecting.delete(threadId));
    this.connecting.set(threadId,pending);
    return pending;
  }

  private catalogLimits(threadId:string) {
    const model=this.context.native.prepare("SELECT m.context_window,m.max_output_tokens,m.last_probe_json FROM threads t JOIN models m ON m.alias=t.active_model_alias WHERE t.id=?").get(threadId);
    return JSON.stringify(model);
  }

  private async open(threadId: string) {
    const row = this.row(threadId);
    const workspaceId = row.workspace_id;
    if (!workspaceId) throw error(404,"Workspace unavailable.");
    const cwd = await this.files.getRoot(workspaceId);
    const globalInstructions = await this.files.agentsText(workspaceId,"global");
    const ttl = this.context.gatewayConfig.internal_token_ttl_seconds;
    const cfg = await generateCodexConfig({ ...this.options,native:this.context.native,masterKey:this.context.masterKey,
      port:this.options.port?.() ?? this.context.gatewayConfig.port, defaultModel:row.active_model_alias ?? undefined,tokenTtlSeconds:ttl,
      thread:{ id:threadId,workspaceId,home:row.codex_home,globalInstructions,opsEntry:this.options.opsEntry
        ?? fileURLToPath(new URL("../../../../packages/ops-mcp/dist/index.js",import.meta.url)) },
    });
    const leases = {model:"cdlease_"+randomBytes(32).toString("hex"),ops:"cdlease_"+randomBytes(32).toString("hex")};
    cfg.env.CODEXDECK_INTERNAL_TOKEN=leases.model; cfg.env.CODEXDECK_OPS_TOKEN=leases.ops;
    this.context.masker.register(leases.model);
    this.context.masker.register(leases.ops);
    this.context.native.prepare("UPDATE threads SET codex_home=? WHERE id=?").run(cfg.codexHome,threadId);
    if (this.stopping) throw error(503,"Manager closed.");
    const output=new OutputMasker(this.context.masker,(method,params)=>this.notify(threadId,method,params));
    const client: RpcClient = await RpcClient.start(cwd,cfg.env,{
      request:(method,params,id) => { void this.serverRequest(threadId,client,method,params,id).catch(() => {
        if (client.alive) client.unsupported(id);
      }); },
      notify:(method,params) => output.push(method,params),
      stderr:line => output.push("stderr",{text:line}),
      exit:() => {
        output.flush();
        if (this.sessions.get(threadId)?.client !== client) return;
        this.sessions.delete(threadId);
        this.approvals.disconnect(threadId);
        this.active.get(threadId)?.finish("failed");
        if (!this.stopping) {
          this.events.append(threadId,"process_exited",{},this.active.get(threadId)?.taskId);
          setImmediate(() => { if (!this.stopping) void this.connect(threadId).catch(() => this.events.append(threadId,"resume_failed",{})); });
        }
      },
    },this.options.codexBin);
    this.startingClients.set(threadId,client);
    try {
      if (this.active.get(threadId)?.cancelled) throw error(409,"Task cancelled.");
      await client.call("initialize",{ clientInfo:{name:"codexdeck",title:"CodexDeck",version:"0.2.0"},capabilities:{} });
      client.notify("initialized");
      const profile = this.context.masker.maskObject(this.options.profile?.() ?? {});
      const settings = { cwd,approvalPolicy:"on-request",sandbox:"workspace-write",model:cfg.alias,modelProvider:"codexdeck",
        developerInstructions:"CodexDeck server profile (environment data): " + JSON.stringify(profile).slice(0,2000) };
      const response = row.remote_thread_id
        ? await client.call("thread/resume",{...settings,threadId:row.remote_thread_id,excludeTurns:true})
        : await client.call("thread/start",settings);
      const remoteId = (response.thread as Json)?.id;
      if (typeof remoteId !== "string" || !remoteId) throw new Error("Invalid Codex thread response.");
      if (this.stopping) throw error(503,"Manager closed.");
      const session = { client,remoteId,leases,settings,catalog:this.catalogLimits(threadId) };
      this.context.native.prepare("UPDATE threads SET remote_thread_id=? WHERE id=?").run(remoteId,threadId);
      this.sessions.set(threadId,session);
      this.events.append(threadId,row.remote_thread_id ? "process_resumed" : "process_started",{remote_thread_id:remoteId});
      return session;
    } catch (err) { await client.close(); throw err; }
    finally { this.startingClients.delete(threadId); }
  }

  private notify(threadId: string, method: string, params: Json) {
    const turn = this.active.get(threadId);
    if (method==="item/reasoning/textDelta" || method==="rawResponseItem/completed") return;
    if (method==="item/started" || method==="item/completed") {
      const item=params.item as Json|undefined;
      if (item?.type==="reasoning") params={...params,item:{type:"reasoning",id:item.id,summary:item.summary}};
    }
    if (method==="thread/tokenUsage/updated" && turn) {
      const usage=(params.tokenUsage as {last?:{totalTokens?:number}})?.last?.totalTokens;
      if(typeof usage==="number" && Number.isSafeInteger(usage) && usage>=0) this.context.native.prepare("UPDATE threads SET last_context_tokens=? WHERE id=? AND active_model_alias=?").run(usage,threadId,turn.modelAlias??null);
      const speed=this.context.native.prepare("SELECT tokens_per_sec FROM usage_logs WHERE turn_id=? ORDER BY rowid DESC LIMIT 1").pluck().get(turn.taskId);
      params={...params,model_alias:turn.modelAlias??null,tokens_per_sec:speed??null};
    }
    this.events.append(threadId,method,params,turn?.taskId);
    if (!turn) return;
    if (method==="turn/diff/updated" && typeof params.diff==="string") {
      const files:TurnTelemetry["files"]=[];
      let file:TurnTelemetry["files"][number]|undefined;
      for (const line of params.diff.split("\n")) {
        const header=line.match(/^diff --git a\/.* b\/(.+)$/);
        if (header) {file={path:header[1],added:0,removed:0};files.push(file);}
        else if (file && line.startsWith("Binary files ")) {file.added=null;file.removed=null;}
        else if (file && line.startsWith("+") && !line.startsWith("+++") && file.added!==null) file.added++;
        else if (file && line.startsWith("-") && !line.startsWith("---") && file.removed!==null) file.removed++;
      }
      this.context.native.prepare("UPDATE tasks SET turn_diff_json=? WHERE id=?").run(JSON.stringify(this.context.masker.maskObject({files,diff:params.diff.slice(0,256*1024)})),turn.taskId);
    }
    if (method === "item/started") {
      const item = params.item as Json | undefined;
      if (item?.type === "fileChange" && typeof item.id === "string" && Array.isArray(item.changes)) {
        const changes = this.fileChanges.get(threadId) ?? new Map<string, unknown[]>();
        changes.set(item.id, item.changes);
        this.fileChanges.set(threadId, changes);
      }
    }
    if (method === "item/agentMessage/delta" && typeof params.delta === "string") turn.summary = (turn.summary + params.delta).slice(-8192);
    if (method === "turn/started") turn.remoteId = String((params.turn as Json)?.id ?? "");
    if (method === "turn/completed") {
      const result = params.turn as Json;
      if (!result || (turn.remoteId && result.id !== turn.remoteId)) return;
      turn.finish(result.status === "completed" ? "completed" : result.status === "interrupted" ? "cancelled" : "failed");
    }
  }

  updateThread(id:string,pinned?:boolean,title?:string) {
    this.row(id);
    this.context.native.prepare("UPDATE threads SET pinned=COALESCE(?,pinned),title=COALESCE(?,title),updated_at=? WHERE id=?")
      .run(pinned===undefined?null:Number(pinned),title??null,new Date().toISOString(),id);
    return threadSchema.parse(this.row(id));
  }

  private requireIdle(id:string) {
    if(this.compacting.has(id) || this.active.has(id) || this.connecting.has(id) || this.context.native.prepare("SELECT id FROM tasks WHERE thread_id=? AND status IN ('queued','running')").get(id)) throw error(409,"Thread has active work.");
  }

  async deleteThread(id:string) {
    this.row(id);this.requireIdle(id);
    const session=this.sessions.get(id);
    this.sessions.delete(id);
    if(session) clearTimeout(session.idle);
    this.context.native.prepare("DELETE FROM threads WHERE id=?").run(id);
    if(session) await session.client.close();
  }

  async compact(id:string,alias?:string):Promise<Compacted> {
    if(this.stopping) throw error(503,"Manager is shutting down.");
    const existing=this.compacting.get(id);
    if(existing) return existing;
    const row=this.row(id);
    if(!row.workspace_id) throw error(404,"Workspace unavailable.");
    this.requireIdle(id);
    const cached=this.context.native.prepare(`SELECT payload_json FROM thread_events WHERE thread_id=? AND type='context_compacted'
      AND task_id=(SELECT id FROM tasks WHERE thread_id=? ORDER BY rowid DESC LIMIT 1) ORDER BY sequence DESC LIMIT 1`).pluck().get(id,id);
    if(typeof cached==="string") return JSON.parse(cached) as Compacted;
    const job=this.replaceContext(id,this.modelName(alias??row.active_model_alias??undefined));
    this.compacting.set(id,job);
    return job;
  }

  private async replaceContext(id:string,alias:string):Promise<Compacted> {
    try {
      const {taskId,...result}=await summarizeContext(this.context,id,alias,
        this.options.port?.()??this.context.gatewayConfig.port);
      const session=await this.connect(id);
      const response=await session.client.call("thread/start",session.settings);
      const remoteId=(response.thread as Json)?.id;
      if(typeof remoteId!=="string" || !remoteId || remoteId===session.remoteId) throw error(502,"Could not create new context.");
      await session.client.call("thread/inject_items",{threadId:remoteId,items:[{type:"message",role:"user",content:[
        {type:"input_text",text:"Handoff from earlier conversation (reference material):\n"+result.summary}]}]});
      if(!session.client.alive || this.sessions.get(id)!==session || this.stopping) throw error(503,"Session closed during compaction.");
      this.context.native.transaction(()=>{
        this.context.native.prepare("UPDATE threads SET compacted_summary=?,last_context_tokens=?,remote_thread_id=?,updated_at=? WHERE id=?")
          .run(result.summary,result.after_tokens,remoteId,new Date().toISOString(),id);
        this.events.append(id,"context_compacted",result,taskId);
      })();
      session.remoteId=remoteId;
      return result;
    } finally {this.compacting.delete(id);
      const session=this.sessions.get(id);
      if(session && !this.active.has(id)) {clearTimeout(session.idle);session.idle=setTimeout(()=>{if(this.sessions.get(id)===session && !this.active.has(id)) {this.sessions.delete(id);void session.client.close();}},this.idleMs);session.idle.unref();}
    }
  }

  private async serverRequest(threadId: string, client: RpcClient, method: string, params: Json, id: RpcId) {
    const turn = this.active.get(threadId);
    if (turn && method==="mcpServer/elicitation/request" && params.serverName==="codexdeck_ops" && params.mode==="form") {
      const result=await this.approvals.request(threadId,method,params,turn.taskId);
      const action=result.decision.startsWith("approve") ? "accept" : result.decision==="abort" ? "cancel" : "decline";
      if (client.alive) client.answer(id,{action,content:action==="accept" ? {} : null});
      if (result.decision==="abort") await this.interrupt(threadId);
      return;
    }
    if (!turn || !["item/commandExecution/requestApproval","item/fileChange/requestApproval"].includes(method)) {
      if (turn) this.events.append(threadId,"unsupported_request",{method},turn.taskId);
      client.unsupported(id); return;
    }
    const changes = method === "item/fileChange/requestApproval" && this.fileChanges.get(threadId)?.get(String(params.itemId));
    let scriptRevision:string|undefined;
    if (/^(?:npm|pnpm|yarn) (?:test|build|install)\b/.test(String(params.command ?? ""))) {
      const snapshot=await snapshotFiles(await this.files.getRoot(turn.workspaceId));
      scriptRevision=createHash("sha256").update(JSON.stringify([turn.workspaceId,[...snapshot].sort()])).digest("hex");
    }
    const result = await this.approvals.request(threadId,method,changes ? {...params,changes} : params,turn.taskId,scriptRevision);
    if (!client.alive) return;
    const decision = result.decision.startsWith("approve") ? "accept" : result.decision === "abort" ? "cancel" : "decline";
    if (result.decision === "deny_guide" && result.user_guidance) await this.inject(threadId,result.user_guidance);
    client.answer(id,{decision});
    if (result.decision === "abort") await this.interrupt(threadId);
  }

  async inject(threadId: string, prompt: string, imageIds:string[] = []) {
    const turn = this.active.get(threadId), session = this.sessions.get(threadId);
    if (!turn?.remoteId || !session) throw error(409,"No active Codex turn.");
    await session.client.call("turn/steer",{threadId:session.remoteId,expectedTurnId:turn.remoteId,input:await this.userInput(this.row(threadId),prompt,imageIds)});
  }

  async interrupt(threadId: string) {
    const turn = this.active.get(threadId);
    if (!turn) throw error(409,"No active turn.");
    turn.cancelled = true;
    turn.guestAbort?.abort();
    const session = this.sessions.get(threadId);
    if (turn.remoteId && session) await session.client.call("turn/interrupt",{threadId:session.remoteId,turnId:turn.remoteId});
  }

  async cancel(taskId: string) {
    const turn = this.jobs.get(taskId);
    if (!turn) throw error(409,"Task is no longer active.");
    turn.cancelled = true;
    if (this.queue.remove(taskId)) this.terminal(turn,"cancelled");
    else if (this.active.get(turn.threadId) === turn) await this.interrupt(turn.threadId);
  }

  async requestOpsApproval(threadId: string, tool: string, payload: Record<string,unknown>) {
    const turn = this.active.get(threadId);
    if (!turn) return false;
    const result = await this.approvals.request(threadId,"ops/" + tool,payload,turn.taskId);
    if (result.decision === "deny_guide" && result.user_guidance) await this.inject(threadId,result.user_guidance);
    if (result.decision === "abort") await this.interrupt(threadId);
    return result.decision.startsWith("approve");
  }

  runtimeTasks() {
    return [...this.active.values()].map(turn => ({
      thread_id:turn.threadId, task_id:turn.taskId, workspace_id:turn.workspaceId,
      pid:turn.guestAbort?null:(this.sessions.get(turn.threadId)?.client ?? this.startingClients.get(turn.threadId))?.pid ?? null,
      elapsed_ms:Math.max(0,Date.now()-(turn.startedAt ?? Date.now())),
    }));
  }

  async killTask(threadId: string) {
    const turn=this.active.get(threadId);
    if (!turn) throw error(404,"No running task on this thread.");
    turn.cancelled=true;
    turn.guestAbort?.abort();
    const client=this.sessions.get(threadId)?.client ?? this.startingClients.get(threadId);
    this.sessions.delete(threadId);
    this.approvals.disconnect(threadId);
    turn.finish("cancelled");
    if (client) await client.close(true);
    return {task_id:turn.taskId,thread_id:threadId,terminated:true};
  }

  async close() {
    this.stopping = true;
    this.queue.stop();
    this.approvals.disconnect();
    for (const turn of this.jobs.values()) {
      turn.cancelled = true;
      turn.guestAbort?.abort();
      turn.finish("cancelled");
      if (!this.active.has(turn.threadId) || this.active.get(turn.threadId) !== turn) this.terminal(turn,"cancelled");
    }
    await Promise.allSettled(this.connecting.values());
    await Promise.allSettled(this.compacting.values());
    await Promise.allSettled([...this.sessions.values()].map(session => session.client.close()));
    await this.queue.drain();
  }
}
