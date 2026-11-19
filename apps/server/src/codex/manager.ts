import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { threadSchema, type Thread, type ApprovalDecision } from "@codexdeck/shared";
import type { ServerContext } from "../app.js";
import type { WorkspaceFiles } from "../files/workspace-files.js";
import { generateCodexConfig } from "./config-gen.js";
import { RpcClient, type Json, type RpcId } from "./rpc-client.js";
import { ApprovalEngine, type EventSink, type NoticeSink } from "./approval.js";
import { WorkspaceQueue } from "./queue.js";

export interface ManagerOptions {
  dataDirectory: string; workspaceRoot?: string; port?: () => number; codexBin?: string; opsEntry?: string;
  approvalTimeoutMs?: number; notifyAfterMs?: number; profile?: () => unknown;
}

type Files = Pick<WorkspaceFiles, "getRoot" | "beforeTurn" | "afterTurn" | "agentsText">;
type ThreadRow = Thread & { remote_thread_id: string | null; codex_home: string | null };
type Terminal = "completed" | "failed" | "cancelled";
type Turn = { taskId: string; threadId: string; workspaceId: string; prompt: string; remoteId?: string;
  cancelled: boolean; summary: string; done: Promise<Terminal>; finish: (status: Terminal) => void };
type Session = { client: RpcClient; remoteId: string; expires: number };

function error(statusCode: number, message: string) { return Object.assign(new Error(message),{statusCode}); }
function textInput(text: string) { return [{ type: "text", text, text_elements: [] }]; }

export class ThreadManager {
  readonly approvals: ApprovalEngine;
  private queue = new WorkspaceQueue();
  private sessions = new Map<string, Session>();
  private connecting = new Map<string, Promise<Session>>();
  private jobs = new Map<string, Turn>();
  private active = new Map<string, Turn>();
  private fileChanges = new Map<string, Map<string, unknown[]>>();
  private stopping = false;
  private recovered = false;

  constructor(private context: ServerContext, private files: Files, private events: EventSink,
    private notifications: NoticeSink, private options: ManagerOptions) {
    this.approvals = new ApprovalEngine(context,events,notifications,options.approvalTimeoutMs,options.notifyAfterMs);
  }

  private row(id: string) {
    const row = this.context.native.prepare("SELECT * FROM threads WHERE id=?").get(id) as ThreadRow | undefined;
    if (!row) throw error(404,"Thread not found.");
    return row;
  }

  list(workspaceId?: string) {
    const sql = `SELECT t.*, (SELECT s.status FROM tasks s WHERE s.thread_id=t.id
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
    const row = this.row(id);
    const model = alias ? this.modelName(alias) : row.active_model_alias;
    this.context.native.prepare("UPDATE threads SET active_model_alias=?,reasoning_effort=?,updated_at=? WHERE id=?")
      .run(model,effort === undefined ? row.reasoning_effort : effort,new Date().toISOString(),id);
    this.events.append(id,"model_changed",{model_alias:model,reasoning_effort:effort ?? null});
    return threadSchema.parse(this.row(id));
  }

  submit(threadId: string, prompt: string, taskId: string = randomUUID()) {
    if (this.stopping) throw error(503,"Manager is shutting down.");
    const row = this.row(threadId);
    if (!row.workspace_id) throw error(404,"Workspace unavailable.");
    const now = new Date().toISOString();
    const safePrompt = this.context.masker.maskString(prompt);
    this.context.native.prepare(`INSERT INTO tasks(id,thread_id,workspace_id,prompt,status,summary,created_at,updated_at)
      VALUES(?,?,?,?,'queued','',?,?)`).run(taskId,threadId,row.workspace_id,safePrompt,now,now);
    this.events.append(threadId,"task_queued",{task_id:taskId},taskId);
    this.enqueue(row.workspace_id, threadId, taskId, prompt);
    return { task_id:taskId,thread_id:threadId,status:"queued" as const };
  }

  private enqueue(workspaceId: string, threadId: string, taskId: string, prompt: string) {
    let finish!: Turn["finish"];
    const done = new Promise<Terminal>(resolve => { finish = resolve; });
    const turn: Turn = { taskId,threadId,workspaceId,prompt,cancelled:false,summary:"",done,finish };
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
    const previous = db.prepare("SELECT id,thread_id,workspace_id,prompt,status FROM tasks WHERE status IN ('queued','running') ORDER BY rowid").all() as
      Array<{id: string; thread_id: string; workspace_id: string; prompt: string; status: string}>;
    for (const task of previous) {
      if (this.jobs.has(task.id)) continue;
      if (task.status === "queued") { this.enqueue(task.workspace_id,task.thread_id,task.id,task.prompt); continue; }
      const summary = "The host stopped during execution.";
      db.prepare("UPDATE tasks SET status='failed',summary=?,updated_at=? WHERE id=?").run(summary,now,task.id);
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
    this.context.native.prepare("UPDATE tasks SET status=?,summary=?,updated_at=? WHERE id=?").run(status,summary,now,turn.taskId);
    const event = { task_id:turn.taskId,thread_id:turn.threadId,workspace_id:turn.workspaceId,status,summary };
    this.events.append(turn.threadId,"task_" + status,event,turn.taskId);
    void this.notifications.send("task_" + status,event);
  }

  private async run(turn: Turn) {
    const { threadId, workspaceId, taskId } = turn;
    this.active.set(threadId,turn);
    let snapshot: Awaited<ReturnType<Files["beforeTurn"]>> | undefined;
    let terminal: Terminal = "failed";
    try {
      if (this.stopping || turn.cancelled) { terminal = "cancelled"; return; }
      const now = new Date().toISOString();
      this.context.native.prepare("UPDATE tasks SET status='running',updated_at=? WHERE id=?").run(now,taskId);
      this.context.native.prepare("UPDATE threads SET status='running',updated_at=? WHERE id=?").run(now,threadId);
      this.events.append(threadId,"task_started",{task_id:taskId},taskId);
      snapshot = await this.files.beforeTurn(workspaceId,threadId,taskId);
      const session = await this.connect(threadId);
      if (this.stopping || turn.cancelled) { terminal = "cancelled"; return; }
      const row = this.row(threadId);
      const response = await session.client.call("turn/start", {
        threadId:session.remoteId, input:textInput(turn.prompt), ...(row.reasoning_effort && { effort:row.reasoning_effort }),
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
      this.fileChanges.delete(threadId);
      this.context.native.prepare("UPDATE threads SET status='idle',updated_at=? WHERE id=?").run(new Date().toISOString(),threadId);
      this.terminal(turn,terminal);
    }
  }

  private connect(threadId: string): Promise<Session> {
    if (this.stopping) return Promise.reject(error(503,"Manager closed."));
    const prior = this.sessions.get(threadId);
    if (prior?.client.alive && prior.expires > Date.now()) return Promise.resolve(prior);
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

  private async open(threadId: string) {
    const row = this.row(threadId);
    const workspaceId = row.workspace_id;
    if (!workspaceId) throw error(404,"Workspace unavailable.");
    const cwd = await this.files.getRoot(workspaceId);
    const globalInstructions = await this.files.agentsText(workspaceId,"global");
    const ttl = this.context.gatewayConfig.internal_token_ttl_seconds;
    const cfg = await generateCodexConfig({ ...this.options,native:this.context.native,masterKey:this.context.masterKey,
      port:this.options.port?.() ?? this.context.gatewayConfig.port, defaultModel:row.active_model_alias ?? undefined,tokenTtlSeconds:ttl,
      thread:{ id:threadId,home:row.codex_home,globalInstructions,opsEntry:this.options.opsEntry
        ?? fileURLToPath(new URL("../../../../packages/ops-mcp/dist/index.js",import.meta.url)) },
    });
    this.context.masker.register(cfg.env.CODEXDECK_INTERNAL_TOKEN);
    this.context.masker.register(cfg.env.CODEXDECK_OPS_TOKEN);
    this.context.native.prepare("UPDATE threads SET codex_home=? WHERE id=?").run(cfg.codexHome,threadId);
    if (this.stopping) throw error(503,"Manager closed.");
    const client: RpcClient = await RpcClient.start(cwd,cfg.env,{
      request:(method,params,id) => { void this.serverRequest(threadId,client,method,params,id).catch(() => {
        if (client.alive) client.unsupported(id);
      }); },
      notify:(method,params) => this.notify(threadId,method,params),
      stderr:line => this.events.append(threadId,"stderr",{text:line},this.active.get(threadId)?.taskId),
      exit:() => {
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
    try {
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
      const session = { client,remoteId,expires:Date.now() + Math.max(1,ttl-5)*1000 };
      this.context.native.prepare("UPDATE threads SET remote_thread_id=? WHERE id=?").run(remoteId,threadId);
      this.sessions.set(threadId,session);
      this.events.append(threadId,row.remote_thread_id ? "process_resumed" : "process_started",{remote_thread_id:remoteId});
      return session;
    } catch (err) { await client.close(); throw err; }
  }

  private notify(threadId: string, method: string, params: Json) {
    const turn = this.active.get(threadId);
    this.events.append(threadId,method,params,turn?.taskId);
    if (!turn) return;
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

  private async serverRequest(threadId: string, client: RpcClient, method: string, params: Json, id: RpcId) {
    const turn = this.active.get(threadId);
    if (!turn || !["item/commandExecution/requestApproval","item/fileChange/requestApproval"].includes(method)) {
      client.unsupported(id); return;
    }
    const changes = method === "item/fileChange/requestApproval" && this.fileChanges.get(threadId)?.get(String(params.itemId));
    const result = await this.approvals.request(threadId,method,changes ? {...params,changes} : params,turn.taskId);
    if (!client.alive) return;
    const decision = result.decision.startsWith("approve") ? "accept" : result.decision === "abort" ? "cancel" : "decline";
    if (result.decision === "deny_guide" && result.user_guidance) await this.inject(threadId,result.user_guidance);
    client.answer(id,{decision});
    if (result.decision === "abort") await this.interrupt(threadId);
  }

  async inject(threadId: string, prompt: string) {
    const turn = this.active.get(threadId), session = this.sessions.get(threadId);
    if (!turn?.remoteId || !session) throw error(409,"No active Codex turn.");
    await session.client.call("turn/steer",{threadId:session.remoteId,expectedTurnId:turn.remoteId,input:textInput(prompt)});
  }

  async interrupt(threadId: string) {
    const turn = this.active.get(threadId);
    if (!turn) throw error(409,"No active turn.");
    turn.cancelled = true;
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

  async close() {
    this.stopping = true;
    this.queue.stop();
    this.approvals.disconnect();
    for (const turn of this.jobs.values()) {
      turn.cancelled = true;
      turn.finish("cancelled");
      if (!this.active.has(turn.threadId) || this.active.get(turn.threadId) !== turn) this.terminal(turn,"cancelled");
    }
    await Promise.allSettled(this.connecting.values());
    await Promise.allSettled([...this.sessions.values()].map(session => session.client.close()));
    await this.queue.drain();
  }
}
