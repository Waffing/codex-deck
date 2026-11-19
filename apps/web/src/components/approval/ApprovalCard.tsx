import { useCallback, useEffect, useState } from "react";
import {
  Check,
  ChevronDown,
  Clock3,
  CornerDownLeft,
  ShieldAlert,
  ShieldCheck,
  Square,
  Terminal,
} from "lucide-react";
import type { Approval, ApprovalDecision } from "@codexdeck/shared";
import { api, json } from "../../lib/api";

export type ApprovalProps = {
  approval: Approval & { expires_at?: string | null };
  workspaceName: string;
  onResolved: () => void;
  shortcut?: boolean;
};
const levels = { low: "低风险", medium: "中风险", high: "高风险" };
const intents: Record<string, string> = {
  "item/commandExecution/requestApproval": "执行终端命令",
  "item/fileChange/requestApproval": "修改工作区文件",
  "ops/app_promote_live": "将服务切换到线上环境",
  "ops/app_rollback": "回滚服务到上次发布",
  "ops/app_deploy_staging": "部署到预发布环境",
  "ops/port_allocate": "为服务分配端口",
};
export function ApprovalCard({ approval, workspaceName, onResolved, shortcut = false }: ApprovalProps) {
  const [now, setNow] = useState(Date.now);
  const [guiding, setGuiding] = useState(false);
  const [guide, setGuide] = useState("");
  const [confirmation, setConfirmation] = useState<ApprovalDecision["decision"] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const expires = approval.expires_at ? Date.parse(approval.expires_at) : 0;
  const remaining = Math.max(0, Math.ceil((expires - now) / 1000));
  const disabled = busy || (expires > 0 && !remaining);
  const body = (approval.payload && typeof approval.payload === "object" ? approval.payload : {}) as Record<
    string,
    unknown
  >;
  const command = typeof body.command === "string" ? body.command : "";
  const intent = typeof body.reason === "string" ? body.reason : (intents[approval.action] ?? "执行运维操作");
  const target =
    command ||
    (typeof body.port === "number" ? "端口 " + body.port : "") ||
    (Array.isArray(body.changes)
      ? body.changes
          .map((c) => c?.path)
          .filter((p) => typeof p === "string")
          .join("、")
      : "") ||
    String(body.path ?? body.cwd ?? body.deployment_id ?? approval.action);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const decide = useCallback(
    async (decision: ApprovalDecision["decision"]) => {
      if (disabled || done) return;
      if (decision === "deny_guide" && !guide.trim()) return;
      if (decision.startsWith("approve") && approval.risk_level === "high" && confirmation !== decision) {
        setConfirmation(decision);
        return;
      }
      setBusy(true);
      setError("");
      try {
        await api(
          "/api/approvals/" + approval.id + "/decision",
          json("POST", { decision, ...(decision === "deny_guide" && { user_guidance: guide.trim() }) }),
        );
        setDone(true);
        onResolved();
      } catch (e) {
        setError(e instanceof Error ? e.message : "提交失败");
      } finally {
        setBusy(false);
      }
    },
    [approval, confirmation, disabled, done, guide, onResolved],
  );
  useEffect(() => {
    if (!shortcut || done) return;
    const handler = (event: KeyboardEvent) => {
      if (
        event.key !== "Enter" ||
        event.repeat ||
        event.isComposing ||
        event.ctrlKey ||
        event.metaKey ||
        (event.target instanceof Element &&
          event.target.closest("button,input,textarea,select,[contenteditable=true]"))
      )
        return;
      event.preventDefault();
      void decide("approve");
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [shortcut, decide, done]);
  if (done || approval.status !== "pending") return null;
  return (
    <section
      className={"cd-approval cd-risk-" + approval.risk_level}
      aria-label="待审批操作"
      data-testid="approval-card"
    >
      <div className="cd-approval-head">
        <span className="cd-risk-icon">
          <ShieldAlert size={17} />
        </span>
        <strong>需要你的批准</strong>
        <span className="cd-risk-label">{levels[approval.risk_level]}</span>
        {expires > 0 && (
          <time title="自动拒绝倒计时">
            <Clock3 size={12} />
            {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, "0")}
          </time>
        )}
      </div>
      <div className="cd-approval-body">
        <span>{workspaceName}</span>
        <b>{intent}</b>
      </div>
      <details className="cd-review-details">
        <summary>
          <Terminal size={14} />
          <code>{target}</code>
          <ChevronDown size={13} />
        </summary>
        <pre>{JSON.stringify(body, null, 2)}</pre>
      </details>
      <div className="cd-approval-actions">
        <button className="cd-primary" disabled={disabled} onClick={() => void decide("approve")}>
          <Check size={14} />
          {confirmation === "approve" ? "确认批准本次" : "批准本次"}
          {shortcut && <CornerDownLeft size={12} />}
        </button>
        <button disabled={disabled} onClick={() => void decide("approve_session")}>
          <ShieldCheck size={14} />
          {confirmation === "approve_session" ? "确认本会话同类放行" : "本会话同类放行"}
        </button>
        <button
          disabled={disabled}
          aria-expanded={guiding}
          onClick={() => {
            setGuiding(!guiding);
            setConfirmation(null);
          }}
        >
          拒绝并给指令
        </button>
        <button disabled={disabled} onClick={() => void decide("abort")}>
          <Square size={12} />
          中止任务
        </button>
      </div>
      {guiding && (
        <form
          className="cd-guidance"
          onSubmit={(e) => {
            e.preventDefault();
            void decide("deny_guide");
          }}
        >
          <input
            autoFocus
            aria-label="纠偏指令"
            value={guide}
            placeholder="让 Codex 如何调整？"
            onChange={(e) => setGuide(e.target.value)}
          />
          <button disabled={!guide.trim() || disabled}>提交纠偏</button>
        </form>
      )}
      {error && <div role="alert">{error}</div>}
    </section>
  );
}
