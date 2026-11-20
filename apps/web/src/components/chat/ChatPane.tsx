import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, FileText, ListChecks, Plus, ShieldCheck, Square, X } from "lucide-react";
import type { Approval, CompactResult, Model, Provider, Thread, ThreadEvent, Workspace } from "@codexdeck/shared";
import { api, json } from "../../lib/api";
import { ApprovalCard } from "../approval/ApprovalCard";
import type { DrawerTab } from "../files/DrawerContent";
import { ModelPicker, automationLabels } from "./ModelPicker";
import { Welcome } from "./Playbooks";
import { Timeline, Minimap, TodoSteps, collectTurns, defaultPreferences, object, type History, type ChatPreferences, type ChatTurn } from "./Timeline";
import { useCompletions } from "./completions";
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
  preferences?: ChatPreferences;
  onInspect?: (turn:ChatTurn|undefined)=>void;
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
  preferences=defaultPreferences,
  onInspect,
}: ChatProps) {
  const [history, setHistory] = useState<History>(empty),
    [draft, setDraft] = useState(""),
    [paths, setPaths] = useState<string[]>([]),
    [images,setImages] = useState<Record<string,string>>({});
  const [earlier,setEarlier]=useState<History|null>(null);
  const [working, setWorking] = useState(false),
    [uploading, setUploading] = useState(false),
    [drag, setDrag] = useState(false),
    [error, setError] = useState("");
  const scroll = useRef<HTMLDivElement>(null),
    follow = useRef(true),
    upload = useRef<HTMLInputElement>(null);
  const input=useRef<HTMLTextAreaElement>(null);
  const contextControl=useRef<HTMLDivElement>(null);
  const [caret,setCaret]=useState(0),[contextMenu,setContextMenu]=useState(false);
  const [notice,setNotice]=useState(""),[revision,setRevision]=useState(0);
  const complete=useCompletions(workspace.id,draft,caret);
  useEffect(()=>{
    if(!contextMenu)return;
    const outside=(e:PointerEvent)=>{if(!contextControl.current?.contains(e.target as Node))setContextMenu(false);};
    const escape=(e:KeyboardEvent)=>{if(e.key==="Escape")setContextMenu(false);};
    document.addEventListener("pointerdown",outside);document.addEventListener("keydown",escape);
    return ()=>{document.removeEventListener("pointerdown",outside);document.removeEventListener("keydown",escape);};
  },[contextMenu]);
  const turns=useMemo(()=>collectTurns(earlier?{
    tasks:[...earlier.tasks,...history.tasks],artifacts:[...earlier.artifacts,...history.artifacts],
  }:history,events),[history,earlier,events]);
  const latest=turns.at(-1);
  useEffect(()=>onInspect?.(latest),[latest,onInspect]);
  const steps=latest?.projection.items.find(item=>item.kind==="todo_progress")?.steps??[];
  const usage=latest?.projection.telemetry;
  const usageFrames=latest?.frames.filter(e=>e.seq_id>(thread?.model_changed_seq??0) && (e.type==="context_usage" || e.type==="context_compacted") && (!object(e.payload).model_alias||object(e.payload).model_alias===thread?.active_model_alias));
  const usageFrame=usageFrames?.at(-1);
  const liveUsage=object(usageFrame?.payload);
  const total=typeof liveUsage.after_tokens==="number"?liveUsage.after_tokens:typeof liveUsage.tokens==="number"?liveUsage.tokens:thread?.last_context_tokens;
  const selectedModel=models.find(m=>m.alias===thread?.active_model_alias);
  const liveWindow=object(usageFrames?.filter(e=>typeof object(e.payload).model_context_window==="number").at(-1)?.payload).model_context_window;
  const limit=typeof liveWindow==="number"&&liveWindow>0?liveWindow:thread?.effective_context_window??selectedModel?.context_window??null;
  const percent=total!=null && limit?Math.round(total*100/limit):null;
  const speed=typeof liveUsage.tokens_per_sec==="number"?liveUsage.tokens_per_sec:usage?.tokens_per_sec;
  const cacheRatio=typeof liveUsage.cached_tokens==="number" && typeof liveUsage.input_tokens==="number" && liveUsage.input_tokens>0?
    liveUsage.cached_tokens/liveUsage.input_tokens:usage?.cache_hit_rate;
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
    api<History>("/api/threads/" + thread.id + "/history"+(preferences.debug?"?debug=true":""))
      .then((r) => {
        if (alive) setHistory(r);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [thread?.id, marker,preferences.debug,revision]);
  // The server owns the full record. Recover streamed prefixes dropped by the bounded WS buffer.
  const oldest=events[0]?.seq_id??0;
  const loadedThrough=useRef(0);
  useEffect(()=>{
    if(events.length===512 && oldest>loadedThrough.current){
      loadedThrough.current=oldest+255;
      setRevision(v=>v+1);
    }
  },[events.length,oldest]);
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
        const r = await api<{ path:string; artifact:{id:string;mime_type:string|null} }>("/api/workspaces/" + workspace.id + "/files/upload", {
          method: "POST",
          body: form,
        });
        setPaths((prev) => [...prev, r.path]);
        if (["image/png","image/jpeg","image/webp","image/gif"].includes(r.artifact.mime_type ?? ""))
          setImages(prev=>({...prev,[r.path]:r.artifact.id}));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "上传失败");
    } finally {
      setUploading(false);
      if (upload.current) upload.current.value = "";
    }
  }
  async function send(message?: string) {
    if((message??draft).trim()==="/compact"){await compactThread();return;}
    const imageIds=paths.filter(p=>images[p]).map(p=>images[p]!);
    const prompt = [message ?? draft, ...paths.filter(p=>!images[p]).map((p) => "@" + p)].filter((x) => x.trim()).join("\n");
    if ((!prompt && !imageIds.length) || working || uploading) return;
    setWorking(true);
    setError("");
    try {
      const current = thread ?? (await onCreateThread());
      await api("/api/threads/" + current.id + (running ? "/inject" : "/messages"), json("POST", { prompt, image_ids:imageIds }));
      setDraft("");
      setPaths([]);
      setImages({});
      follow.current = true;
      onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "发送失败");
    } finally {
      setWorking(false);
    }
  }
  async function compactThread(){
    if(working)return;
    if(!thread||!turns.length){setError("先完成一轮对话再压缩上下文。");return;}
    if(running){setError("本轮结束后可以压缩上下文。");return;}
    if(latest?.projection.items.some(item=>item.kind==="context_compacted")){setError("本轮历史已压缩。");return;}
    setWorking(true);setError("");setContextMenu(false);complete.close();
    try{
      const result=await api<CompactResult>(`/api/threads/${thread.id}/compact`,json("POST",{}));
      setNotice(`上下文已压缩 · ${result.before_estimated?"约 ":""}${result.before_tokens} → ${result.estimated?"约 ":""}${result.after_tokens} Token`);
      if(draft.trim()==="/compact")setDraft("");
      setRevision(v=>v+1);onRefresh();
    }catch(e){setError((e as Error).message);}finally{setWorking(false);}
  }
  function choose(value:string){
    const before=draft.slice(0,complete.start),after=draft.slice(caret);
    complete.close();
    if(complete.kind==="@"){setPaths(prev=>prev.includes(value)?prev:[...prev,value]);setDraft(before+after);setCaret(before.length);}
    else if(value==="/compact"){setDraft(before+after);void compactThread();}
    else {setDraft(before+value+after);setCaret(before.length+value.length);}
    input.current?.focus();
  }
  async function changePolicy(value:Workspace["automation_level"]){
    setWorking(true);setError("");
    try{await api(`/api/workspaces/${workspace.id}`,json("PATCH",{automation_level:value}));onRefresh();}
    catch(e){setError((e as Error).message);}finally{setWorking(false);}
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
  const hasContent = turns.length>0;
  const pagination=earlier??history;
  return (
    <div className="cd-chat-pane">
      <Minimap turns={turns} scroll={scroll}/>
      <div
        ref={scroll}
        className="cd-chat-scroll"
        onScroll={(e) => {
          const t = e.currentTarget;
          follow.current = t.scrollHeight - t.clientHeight - t.scrollTop < 120;
        }}
      >
        {(pagination.next_before || pagination.next_artifact_before) && <button className="ad-button" disabled={working} onClick={async()=>{
          setWorking(true);
          try {
            const older=await api<History>(`/api/threads/${thread?.id}/history?before=${pagination.next_before??0}&artifact_before=${pagination.next_artifact_before??0}${preferences.debug?"&debug=true":""}`);
            follow.current=false;
            setEarlier(current=>({...older,tasks:[...older.tasks,...(current?.tasks??[])],
              artifacts:[...older.artifacts,...(current?.artifacts??[])]}));
          } catch(e){setError((e as Error).message);} finally{setWorking(false);}
        }}>加载更早的记录</button>}
        {hasContent ? (
          <Timeline
            turns={turns}
            preferences={preferences}
            workspaceId={workspace.id}
            onOpen={onOpen}
            onError={setError}
            onEdit={prompt=>{setDraft(prompt);setCaret(prompt.length);input.current?.focus();}}
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
        {steps.length>0 && <details className="cd-plan-capsule"><summary><ListChecks size={15}/>已完成 {steps.filter(s=>s.status==="completed").length} 个任务 (共 {steps.length} 个)</summary><TodoSteps steps={steps}/></details>}
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
          {complete.open && <div className="cd-suggestions" id="composer-options" role="listbox" aria-label={complete.kind==="@"?"工作区文件":"快捷命令"}>
            {complete.options.length?complete.options.map((v,i)=><button id={`completion-${i}`} role="option" type="button" aria-selected={i===complete.index} key={v.label+i} onMouseDown={e=>e.preventDefault()} onClick={()=>choose(v.value)}>{v.label}</button>):<p>{complete.hint}</p>}
          </div>}
          <textarea ref={input}
            aria-label="任务指令"
            placeholder={running ? "补充指令，调整本轮执行方向…" : "输入任务指令，或拖入文件…"}
            value={draft}
            aria-controls={complete.open?"composer-options":undefined}
            aria-activedescendant={complete.open&&complete.options.length?`completion-${complete.index}`:undefined}
            onChange={(e) => {setDraft(e.target.value);setCaret(e.target.selectionStart);}}
            onSelect={e=>setCaret(e.currentTarget.selectionStart)}
            onPaste={(e) => {
              if (e.clipboardData.files.length) {
                e.preventDefault();
                void attach(e.clipboardData.files);
              }
            }}
            onKeyDown={(e) => {
              if(e.nativeEvent.isComposing || e.keyCode===229)return;
              if(complete.open && !e.shiftKey){
                if(e.key==="Escape"){e.preventDefault();complete.close();return;}
                if(e.key==="ArrowDown" || e.key==="ArrowUp"){
                  e.preventDefault();const n=complete.options.length;
                  if(n)complete.setIndex((complete.index+(e.key==="ArrowDown"?1:-1)+n)%n);
                  return;
                }
                if(e.key==="Enter" || e.key==="Tab"){
                  e.preventDefault();const choice=complete.options[complete.index];if(choice)choose(choice.value);return;
                }
              }
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
              <Plus size={17} />
            </button>
            <label className="cd-policy" title="工作区权限">
              <ShieldCheck size={13} />
              <select aria-label="工作区权限" value={workspace.automation_level} disabled={working} onChange={e=>void changePolicy(e.target.value as Workspace["automation_level"])}>
                {Object.entries(automationLabels).map(([v,label])=><option key={v} value={v}>{label}</option>)}</select>
            </label>
            <span className="cd-live-usage" aria-label="生成性能">{speed!=null?speed.toFixed(1):"—"} tok/s · 缓存 {cacheRatio!=null?Math.round(cacheRatio*100)+"%":"—"}</span>
            <div ref={contextControl} className="cd-context" onPointerEnter={e=>{if(e.pointerType==="mouse")setContextMenu(true);}} onPointerLeave={e=>{if(e.pointerType==="mouse")setContextMenu(false);}} onBlur={e=>{if(e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node))setContextMenu(false);}}>
              <button type="button" aria-label="上下文占用" aria-expanded={contextMenu} onFocus={()=>setContextMenu(true)} onClick={()=>setContextMenu(true)} data-high={percent!=null&&percent>80}>
                <svg width="32" height="32" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="17"/><circle className="cd-context-value" cx="20" cy="20" r="17" pathLength="100" strokeDasharray={`${Math.min(100,percent??0)} 100`}/></svg><small>{percent!=null?percent+"%":"—"}</small>
              </button>
              {contextMenu && <aside><p>{total?.toLocaleString()??"—"} / {limit?.toLocaleString()??"—"} Token</p><button type="button" disabled={!thread||running||working||!turns.length||latest?.projection.items.some(item=>item.kind==="context_compacted")} onClick={()=>void compactThread()}>一键压缩上下文</button></aside>}
            </div>
            <ModelPicker {...{ thread, models, providers, workspace, onCreateThread, onRefresh }} />
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
        {notice && <div className="cd-context-notice" role="status">{notice}<button aria-label="关闭压缩提示" onClick={()=>setNotice("")}><X size={13}/></button></div>}
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
