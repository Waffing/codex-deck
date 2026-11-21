import {readPreferences} from "../settings/preferences.js";
import { createHash, randomUUID } from "node:crypto";
import type { ApprovalDecision } from "@codexdeck/shared";
import type { ServerContext } from "../app.js";
import { taskLink } from "../temp-access/service.js";

export interface EventSink { append(thread: string, type: string, payload: unknown, taskId?: string): unknown }
export interface NoticeSink { send(kind: string, payload: Record<string, unknown>): unknown }
export type ApprovalResult = ApprovalDecision | { decision: "timeout" | "disconnected"; user_guidance?: undefined };
type Risk = "low" | "medium" | "high";

function riskOf(action: string, payload: Record<string, unknown>): Risk {
  if (["ops/server_inspect", "ops/app_logs", "ops/verify_url"].includes(action)) return "low";
  if (["ops/app_promote_live", "ops/app_rollback"].includes(action)) return "high";
  if (["ops/port_allocate", "ops/app_deploy_staging"].includes(action)) return "medium";
  if (action === "item/fileChange/requestApproval") {
    const changes = payload.changes;
    if (payload.grantRoot || !Array.isArray(changes) || !changes.length) return "high";
    const ordinary = changes.every(change => change && ["add", "update"].includes(change.kind?.type)
      && !change.kind.move_path && typeof change.path === "string"
      && !/(?:^|[\\/])(?:migrations?|nginx|caddy)(?:[\\/.]|$)|\.(?:sql|sqlite|db)$/i.test(change.path));
    return ordinary ? "medium" : "high";
  }
  const command = String(payload.command ?? "");
  // Match the entire command. Shell composition, substitutions, paths and extra flags require human review.
  if (/^(?:git (?:status(?: --short)?|diff --stat)|(?:node|python|go|docker) --version)$/.test(command)) return "low";
  if (/^(?:npm|pnpm|yarn) (test|build|install)(?: [a-zA-Z0-9@._/-]+)*$/.test(command)) return "medium";
  return "high";
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, field]) => [key, stable(field)]));
  return value;
}

function signature(action: string, payload: Record<string,unknown>) {
  const details = { ...payload };
  for (const key of ["threadId", "turnId", "itemId", "approvalId", "startedAtMs", "reason"]) delete details[key];
  return createHash("sha256").update(JSON.stringify([action,stable(details)])).digest("hex");
}

export class ApprovalEngine {
  private pending = new Map<string, { threadId: string; taskId?: string; rule: string; risk: Risk;
    resolve: (decision: ApprovalResult) => void; timeout: NodeJS.Timeout; reminder: NodeJS.Timeout }>();

  constructor(private context: ServerContext, private events: EventSink, private notifications: NoticeSink,
    private timeoutMs?: number, private reminderMs = 30_000,
    private isolatedAdmin:(thread:string,task?:string)=>boolean=()=>false) {}

  list() {
    return (this.context.native.prepare("SELECT * FROM approvals ORDER BY created_at DESC").all() as
      Array<{ payload_json: string }>).map(({payload_json, ...row}) => ({ ...row, payload: JSON.parse(payload_json) }));
  }

  request(threadId: string, action: string, payload: Record<string,unknown>, taskId?: string, scriptRevision?:string): Promise<ApprovalResult> {
    const state = this.context.native.prepare(`SELECT t.session_rules_json,w.automation_level FROM threads t
      JOIN workspaces w ON w.id=t.workspace_id WHERE t.id=?`).get(threadId) as { session_rules_json: string; automation_level: string } | undefined;
    if (!state) throw new Error("Thread unavailable.");
    const risk = riskOf(action, payload);
    const script = /^(?:npm|pnpm|yarn) (?:test|build|install)\b/.test(String(payload.command ?? ""));
    const rule = signature(action, script ? {...payload,scriptRevision} : payload);
    const rules: string[] = JSON.parse(state.session_rules_json);
    const guest=taskLink(this.context,taskId);
    if(guest && (guest.status!=="active" || guest.permission!=="full_with_approval"))return Promise.resolve({decision:"abort"});
    const auto = (!guest && this.isolatedAdmin(threadId,taskId)) || (!guest || risk==="low") && risk !== "high" && ((!script || Boolean(scriptRevision)) && rules.includes(rule) ||
      (!script && ((risk === "low" && state.automation_level !== "conservative") || state.automation_level === "full")));
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    const timeoutMs=this.timeoutMs ?? readPreferences(this.context.native).approvalTimeoutSeconds*1000;
    const expiresAt = new Date(Date.now() + timeoutMs).toISOString();
    const safe = this.context.masker.maskObject(payload);
    this.context.native.prepare(`INSERT INTO approvals (id,thread_id,action,payload_json,status,risk_level,created_at,resolved_at,expires_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(id,threadId,action,JSON.stringify(safe),auto ? "approved_auto" : "pending",risk,timestamp,auto ? timestamp : null,auto ? null : expiresAt);
    if (auto) {
      this.events.append(threadId,"approval_resolved",{id, decision:"approved_auto", risk_level:risk},taskId);
      return Promise.resolve({ decision:"approve" });
    }
    return new Promise(resolve => {
      const timeout = setTimeout(() => this.settle(id,{decision:"timeout"}),timeoutMs);
      const reminder = setTimeout(() => this.notifications.send("approval_pending",{thread_id:threadId, approval_id:id, risk_level:risk}),this.reminderMs);
      this.pending.set(id,{threadId,taskId,rule,risk,resolve,timeout,reminder});
      this.events.append(threadId,"approval_req",{id,action,payload:safe,risk_level:risk,expires_at:expiresAt},taskId);
    });
  }

  decide(id: string, decision: ApprovalDecision) {
    if (!this.pending.has(id)) throw Object.assign(new Error("Approval is no longer pending."),{statusCode:409});
    this.settle(id,decision);
  }

  private settle(id: string, result: ApprovalResult) {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timeout); clearTimeout(entry.reminder);
    this.context.native.transaction(() => {
      this.context.native.prepare("UPDATE approvals SET status=?,resolved_at=? WHERE id=?").run(result.decision,new Date().toISOString(),id);
      if (result.decision === "approve_session" && entry.risk !== "high") {
        const row = this.context.native.prepare("SELECT session_rules_json FROM threads WHERE id=?").pluck().get(entry.threadId);
        const rules = new Set<string>(JSON.parse(String(row)));
        rules.add(entry.rule);
        this.context.native.prepare("UPDATE threads SET session_rules_json=? WHERE id=?").run(JSON.stringify([...rules]),entry.threadId);
      }
    })();
    this.events.append(entry.threadId,"approval_resolved",{id,...result},entry.taskId);
    entry.resolve(result);
  }

  disconnect(threadId?: string) {
    for (const [id, entry] of this.pending) if (!threadId || entry.threadId === threadId) this.settle(id,{decision:"disconnected"});
  }
}
