import { useMemo, useState } from "react";
import { Archive, Check, ChevronDown, Clock3, GitBranch, RotateCcw, Terminal, UserRound } from "lucide-react";
import type { Artifact, ThreadEvent } from "@codexdeck/shared";
import { api, json } from "../../lib/api";
import { ArtifactChip, download } from "../files/Artifacts";
import type { DrawerTab } from "../files/DrawerContent";
export type TaskHistory = {
  id: string;
  prompt: string;
  summary: string;
  status: string;
  created_at: string;
  updated_at: string;
  checkpoint_ref: string | null;
};
export type History = { tasks: TaskHistory[]; artifacts: Artifact[] };
export function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
const labels: Record<string, string> = {
  queued: "排队中",
  running: "执行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已中止",
};
function Steps({ events, task }: { events: ThreadEvent[]; task: TaskHistory }) {
  const [open, setOpen] = useState(false);
  const modelSteps = new Map<string, string>();
  const raw = events.filter(
    (e) =>
      ![
        "task_queued",
        "task_started",
        "task_completed",
        "task_failed",
        "task_cancelled",
        "artifacts_updated",
        "item/agentMessage/delta",
      ].includes(e.type),
  );
  let read = 0,
    commands = 0;
  for (const e of raw) {
    const item = object(object(e.payload).item),
      type = String(item.type || "");
    if (item.id && !["agentMessage", "userMessage"].includes(type)) modelSteps.set(String(item.id), type);
    if (e.type === "item/completed" && type === "commandExecution") {
      commands++;
      const actions = item.commandActions;
      if (Array.isArray(actions)) read += actions.filter((a) => object(a).type === "read").length;
    }
  }
  if (!raw.length) return null;
  const elapsed = Math.max(0, (Date.parse(task.updated_at) - Date.parse(task.created_at)) / 1000);
  const finished = !["running", "queued"].includes(task.status);
  return (
    <div className="cd-step-block">
      <button className="cd-step-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Terminal size={14} />
        <span>
          {modelSteps.size ? (finished ? "已完成 " : "执行 ") + modelSteps.size + " 步" : "执行时间线"}
        </span>
        <small>
          {[
            read ? "读取 " + read + " 文件" : "",
            commands ? "执行 " + commands + " 条命令" : "",
            finished && Number.isFinite(elapsed) ? elapsed.toFixed(1) + "s" : "",
          ]
            .filter(Boolean)
            .join(" · ")}
        </small>
        <ChevronDown size={13} />
      </button>
      {open && (
        <ol>
          {raw.map((e) => (
            <li key={e.seq_id}>
              <header>
                <code>{e.type}</code>
                <time>{new Date(e.created_at).toLocaleTimeString("zh-CN")}</time>
              </header>
              <pre>{JSON.stringify(e.payload, null, 2)}</pre>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
export function Timeline({
  history,
  events,
  workspaceId,
  onOpen,
  onError,
}: {
  history: History;
  events: ThreadEvent[];
  workspaceId: string;
  onOpen: (tab: DrawerTab) => void;
  onError: (msg: string) => void;
}) {
  const [confirm, setConfirm] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const turns = useMemo(() => {
    const tasks = new Map(history.tasks.map((t) => [t.id, { ...t }]));
    const byTask = new Map<string, ThreadEvent[]>(),
      artifacts = new Map(history.artifacts.map((a) => [a.id, a]));
    for (const e of events) {
      const payload = object(e.payload),
        id = e.task_id ?? (typeof payload.turn_id === "string" ? payload.turn_id : null);
      if (!id) continue;
      const t = tasks.get(id) ?? {
        id,
        prompt: "",
        summary: "",
        created_at: e.created_at,
        updated_at: e.created_at,
        status: "queued",
        checkpoint_ref: null,
      };
      if (e.created_at >= t.updated_at) {
        if (e.type === "task_started") t.status = "running";
        if (["task_completed", "task_failed", "task_cancelled"].includes(e.type)) {
          t.status = e.type.slice(5);
          if (payload.summary) t.summary = String(payload.summary);
        }
        t.updated_at = e.created_at;
      }
      tasks.set(id, t);
      const list = byTask.get(id) ?? [];
      list.push(e);
      byTask.set(id, list);
      if (e.type === "artifacts_updated" && Array.isArray(payload.artifacts))
        for (const a of payload.artifacts as Artifact[]) artifacts.set(a.id, a);
    }
    return [...tasks.values()]
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((t) => {
        const frames = byTask.get(t.id) ?? [];
        const text = frames
          .filter((e) => e.type === "item/agentMessage/delta")
          .map((e) => object(e.payload).delta ?? "")
          .join("");
        const files = [...artifacts.values()].filter((a) => a.turn_id === t.id);
        return {
          t,
          frames,
          text: text || t.summary,
          files,
          screenshots: files.filter(
            (a) => a.change_type === "screenshot" && a.mime_type?.startsWith("image/"),
          ),
        };
      });
  }, [history, events]);
  async function restore(id: string) {
    setBusy(true);
    try {
      await api(
        "/api/workspaces/" + workspaceId + "/checkpoints/" + encodeURIComponent(id) + "/restore",
        json("POST", {}),
      );
      setConfirm(null);
    } catch (e) {
      onError(e instanceof Error ? e.message : "回滚失败");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="cd-turns">
      {turns.map(({ t, frames, text, files, screenshots }) => (
        <article className="cd-turn" key={t.id}>
          <header className="cd-turn-head">
            <span className="cd-avatar">
              <UserRound size={14} />
            </span>
            <b>你</b>
            <time>
              {new Date(t.created_at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}
            </time>
            {t.checkpoint_ref && (
              <button className="cd-checkpoint" disabled={busy} onClick={() => setConfirm(t.id)}>
                <GitBranch size={13} />
                Checkpoint
              </button>
            )}
          </header>
          {confirm === t.id && (
            <div className="cd-confirm">
              <span>还原到本轮开始前的工作区？</span>
              <button disabled={busy} onClick={() => void restore(t.id)}>
                <RotateCcw size={12} />
                确认回滚
              </button>
              <button onClick={() => setConfirm(null)}>取消</button>
            </div>
          )}
          <p className="cd-prompt">{t.prompt || "任务已提交"}</p>
          <div className="cd-agent-head">
            <span className="cd-bot-icon">
              <Terminal size={15} />
            </span>
            <b>Codex</b>
            <span className="cd-turn-status">
              {t.status === "running" ? (
                <Clock3 size={11} />
              ) : t.status === "completed" ? (
                <Check size={11} />
              ) : null}
              {labels[t.status] ?? t.status}
            </span>
          </div>
          <Steps events={frames} task={t} />
          {text && <div className="cd-answer">{text}</div>}
          {files.length > 0 && (
            <div className="cd-artifacts">
              {files.map((a) => (
                <ArtifactChip
                  key={a.id}
                  item={a}
                  screenshots={screenshots}
                  onOpen={onOpen}
                  onError={onError}
                />
              ))}
              <button
                className="cd-zip"
                onClick={() => void download({ turn_id: t.id }).catch(() => onError("打包下载失败"))}
              >
                <Archive size={13} />
                下载本轮 ZIP
              </button>
            </div>
          )}
        </article>
      ))}
    </div>
  );
}
