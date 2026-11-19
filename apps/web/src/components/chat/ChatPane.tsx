import { useEffect, useRef, useState } from "react";
import { ArrowUp, FileText, Paperclip, ShieldCheck, Square, X } from "lucide-react";
import type { Approval, Model, Provider, Thread, ThreadEvent, Workspace } from "@codexdeck/shared";
import { api, json } from "../../lib/api";
import { ApprovalCard } from "../approval/ApprovalCard";
import type { DrawerTab } from "../files/DrawerContent";
import { ModelPicker, automationLabels } from "./ModelPicker";
import { Welcome } from "./Playbooks";
import { Timeline, type History } from "./Timeline";
import "./chat.css";
type ChatProps = {
  workspace: Workspace;
  thread: Thread | null;
  events: ThreadEvent[];
  approvals: Approval[];
  models: Model[];
  providers: Provider[];
  onCreateThread: () => Promise<Thread>;
  onRefresh: () => void;
  onOpen: (tab: DrawerTab) => void;
  mobileApprovalId?: string;
};
const empty: History = { tasks: [], artifacts: [] };
export function ChatPane(props: ChatProps) {
  return <ChatBody key={props.workspace.id + ":" + (props.thread?.id ?? "new")} {...props} />;
}
function ChatBody({
  workspace,
  thread,
  events,
  approvals,
  models,
  providers,
  onCreateThread,
  onRefresh,
  onOpen,
  mobileApprovalId,
}: ChatProps) {
  const [history, setHistory] = useState<History>(empty),
    [draft, setDraft] = useState(""),
    [paths, setPaths] = useState<string[]>([]);
  const [working, setWorking] = useState(false),
    [uploading, setUploading] = useState(false),
    [drag, setDrag] = useState(false),
    [error, setError] = useState("");
  const scroll = useRef<HTMLDivElement>(null),
    follow = useRef(true),
    upload = useRef<HTMLInputElement>(null);
  const [compact, setCompact] = useState(() => window.matchMedia("(max-width: 767px)").matches);
  useEffect(() => {
    const viewport = window.matchMedia("(max-width: 767px)");
    const resize = () => setCompact(viewport.matches);
    resize();
    viewport.addEventListener("change", resize);
    return () => viewport.removeEventListener("change", resize);
  }, []);
  const pending = approvals.filter((a) =>
    a.status === "pending" && a.thread_id === thread?.id && !(compact && a.id === mobileApprovalId)
  );
  const lifecycle = events.filter((e) => e.type.startsWith("task_"));
  const activeTasks = new Set(history.tasks.filter((t) => t.status === "running").map((t) => t.id));
  for (const event of lifecycle) {
    if (!event.task_id) continue;
    if (event.type === "task_started") activeTasks.add(event.task_id);
    if (["task_completed", "task_failed", "task_cancelled"].includes(event.type))
      activeTasks.delete(event.task_id);
  }
  const running =
    activeTasks.size > 0 || (!lifecycle.length && !history.tasks.length && thread?.status === "running");
  const marker = events.reduce(
    (n, e) =>
      [
        "task_completed",
        "task_queued",
        "task_failed",
        "task_cancelled",
        "artifacts_updated",
        "task_started",
      ].includes(e.type)
        ? e.seq_id
        : n,
    0,
  );
  useEffect(() => {
    if (!thread?.id) return;
    let alive = true;
    api<History>("/api/threads/" + thread.id + "/history")
      .then((r) => {
        if (alive) setHistory(r);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [thread?.id, marker]);
  useEffect(() => {
    if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [events, history, pending.length]);
  async function attach(files: FileList | File[]) {
    if (uploading || !files.length) return;
    setUploading(true);
    setError("");
    try {
      for (const f of Array.from(files)) {
        const form = new FormData();
        form.append("file", f);
        const r = await api<{ path: string }>("/api/workspaces/" + workspace.id + "/files/upload", {
          method: "POST",
          body: form,
        });
        setPaths((prev) => [...prev, r.path]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "上传失败");
    } finally {
      setUploading(false);
      if (upload.current) upload.current.value = "";
    }
  }
  async function send(message?: string) {
    const prompt = [message ?? draft, ...paths.map((p) => "@" + p)].filter((x) => x.trim()).join("\n");
    if (!prompt || working || uploading) return;
    setWorking(true);
    setError("");
    try {
      const current = thread ?? (await onCreateThread());
      await api("/api/threads/" + current.id + (running ? "/inject" : "/messages"), json("POST", { prompt }));
      setDraft("");
      setPaths([]);
      follow.current = true;
      onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "发送失败");
    } finally {
      setWorking(false);
    }
  }
  async function interrupt() {
    if (!thread) return;
    setWorking(true);
    try {
      await api("/api/threads/" + thread.id + "/interrupt", json("POST", {}));
      onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "中止失败");
    } finally {
      setWorking(false);
    }
  }
  const hasContent = history.tasks.length > 0 || lifecycle.length > 0;
  return (
    <div className="cd-chat-pane">
      <div
        ref={scroll}
        className="cd-chat-scroll"
        onScroll={(e) => {
          const t = e.currentTarget;
          follow.current = t.scrollHeight - t.clientHeight - t.scrollTop < 120;
        }}
      >
        {hasContent ? (
          <Timeline
            history={history}
            events={events}
            workspaceId={workspace.id}
            onOpen={onOpen}
            onError={setError}
          />
        ) : (
          <Welcome
            workspaceId={workspace.id}
            workspaceName={workspace.name}
            onSelect={(prompt) => void send(prompt)}
          />
        )}
      </div>
      {pending.length > 0 && (
        <aside className="cd-pending-stack">
          {pending.map((a, i) => (
            <ApprovalCard
              key={a.id}
              approval={a}
              workspaceName={workspace.name}
              onResolved={onRefresh}
              shortcut={i === 0}
            />
          ))}
        </aside>
      )}
      <div className="cd-compose-zone">
        <form
          className={"cd-composer" + (drag ? " cd-drag" : "")}
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes("Files")) {
              e.preventDefault();
              setDrag(true);
            }
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrag(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            void attach(e.dataTransfer.files);
          }}
        >
          {paths.length > 0 && (
            <div className="cd-chips">
              {paths.map((p) => (
                <button
                  type="button"
                  title={p}
                  key={p}
                  onClick={() => setPaths((old) => old.filter((x) => x !== p))}
                >
                  <FileText size={12} />
                  {p
                    .split("/")
                    .pop()
                    ?.replace(/^\d+-[a-f0-9-]{36}-/, "")}
                  <X size={12} />
                </button>
              ))}
            </div>
          )}
          <textarea
            aria-label="任务指令"
            placeholder={running ? "补充指令，调整本轮执行方向…" : "输入任务指令，或拖入文件…"}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={(e) => {
              if (e.clipboardData.files.length) {
                e.preventDefault();
                void attach(e.clipboardData.files);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div className="cd-compose-controls">
            <input
              ref={upload}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) void attach(e.target.files);
              }}
            />
            <button
              type="button"
              className="cd-attach"
              title="添加附件"
              aria-label="添加附件"
              disabled={uploading}
              onClick={() => upload.current?.click()}
            >
              <Paperclip size={16} />
            </button>
            <ModelPicker {...{ thread, models, providers, workspace, onCreateThread, onRefresh }} />
            <span className="cd-policy">
              <ShieldCheck size={13} />
              {automationLabels[workspace.automation_level]}
            </span>
            {running && (
              <button className="cd-stop" type="button" disabled={working} onClick={() => void interrupt()}>
                <Square size={12} />
                中止
              </button>
            )}
            <button
              className="cd-send"
              type="submit"
              aria-label={running ? "中途插话" : "发送消息"}
              disabled={working || uploading || (!draft.trim() && !paths.length)}
            >
              {running && <span>插话</span>}
              <ArrowUp size={17} />
            </button>
          </div>
        </form>
        {error && (
          <div role="alert" className="cd-compose-error">
            {error}
            <button aria-label="关闭错误" onClick={() => setError("")}>
              <X size={12} />
            </button>
          </div>
        )}
        <div className="cd-compose-hint">
          {uploading ? "正在上传附件…" : drag ? "松开以上传文件" : "Enter 发送 · Shift + Enter 换行"}
        </div>
      </div>
    </div>
  );
}
