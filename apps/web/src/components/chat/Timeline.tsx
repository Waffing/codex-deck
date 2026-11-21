import { memo, useEffect, useRef, useState, type RefObject } from "react";
import { CircleAlert, CircleSlash, Check, ChevronDown, Clock3, Copy, GitBranch, Pencil, Terminal, X } from "lucide-react";
import { type ThreadEvent, type TimelineItem, type ToolOperation } from "@codexdeck/shared";
import { api, json } from "../../lib/api";
import {Telemetry,TurnFiles} from "./TurnFiles";
import type {ChatTurn} from "./turns";
export type {ChatTurn} from "./turns";
import type { DrawerTab } from "../files/DrawerContent";
import { AnswerDocument } from "./AnswerDocument";
export type ChatPreferences = {debug:boolean; telemetry:boolean; expandTimeline:boolean; minimap?:boolean; compactBubbles?:boolean; sendShortcut?:"enter"|"ctrl_enter"; contextThreshold?:number};
export const defaultPreferences:ChatPreferences = {debug:false,telemetry:true,expandTimeline:false};
const labels:Record<string,string> = {queued:"排队中",running:"执行中",completed:"运行完成",failed:"运行失败",cancelled:"已中止"};
export function StepDetails({turnId,operation}:{turnId:string;operation:ToolOperation}){
  const [content,setContent]=useState(operation.detail),[error,setError]=useState("");
  useEffect(()=>{
    if(operation.detail){setContent(operation.detail);return;}
    const abort=new AbortController();
    void api<{detail:string}>(`/api/turns/${encodeURIComponent(turnId)}/steps/${encodeURIComponent(operation.id)}`,{signal:abort.signal})
      .then(r=>{if(!abort.signal.aborted)setContent(r.detail);}).catch(e=>{if(!abort.signal.aborted)setError(e.message);});
    return ()=>abort.abort();
  },[turnId,operation.id,operation.detail]);
  return <pre>{error||content||operation.label}</pre>;
}
function ToolGroup({item,turnId}:{item:TimelineItem;turnId:string}){
  const [open,setOpen]=useState(false);
  return <details onToggle={e=>setOpen(e.currentTarget.open)}><summary><Terminal size={13}/>{item.text} · {item.operations?.length??0} 次操作</summary>
    {open && item.operations?.map(op=><StepDetails key={op.id} turnId={turnId} operation={op}/>)}</details>;
}
export function TodoSteps({steps}:{steps:NonNullable<TimelineItem['steps']>}) {
  return <ul className="cd-plan-list">{steps.map((s,i)=><li key={i} data-status={s.status}>
    {s.status==='completed'?<Check size={14}/>:<span aria-hidden="true">{s.status==='inProgress'?'◐':'○'}</span>} {s.step}</li>)}</ul>;
}
function elapsed(ms:number){const seconds=Math.max(0,Math.round(ms/1000));return seconds>=60?`${Math.floor(seconds/60)}m ${seconds%60}s`:`${seconds}s`;}
function Trace({turn,expanded}:{turn:ChatTurn;expanded:boolean}) {
  const [open,setOpen]=useState(expanded);
  useEffect(()=>setOpen(expanded),[expanded]);
  const {task,projection}=turn;
  const count=projection.items.reduce((sum,item)=>sum+(item.operations?.length??0),0);
  const ms=projection.telemetry?.elapsed_ms??Date.parse(task.updated_at)-Date.parse(task.created_at);
  const StatusIcon=task.status==="failed"?CircleAlert:task.status==="cancelled"?CircleSlash:task.status==="completed"?Check:Clock3;
  return <section className="cd-step-block"><button type="button" className="cd-step-toggle" data-state={task.status} aria-expanded={open} onClick={()=>setOpen(!open)}>
    <StatusIcon size={13}/> {labels[task.status]??task.status} · {elapsed(ms)} · {count} 个工具 <ChevronDown size={13}/></button>
    {open && <ol>{projection.items.map(item=><li key={item.kind+item.id} data-kind={item.kind}>
      {item.kind==='tool_group'?<ToolGroup item={item} turnId={task.id}/>:
        item.kind==='todo_progress'?<details><summary>{item.text||'任务清单'}</summary><TodoSteps steps={item.steps??[]}/></details>:
        item.kind==='context_compacted'?<details><summary>上下文已压缩 · {item.before_estimated?'约 ':''}{item.before_tokens} → {item.estimated?'约 ':''}{item.after_tokens} Token</summary><p>{item.text}</p></details>:
        <p className={item.kind==='subagent_status'?'cd-subagent':'cd-reasoning'}>{item.text}</p>}
    </li>)}</ol>}
  </section>;
}
export function Minimap({turns,scroll}:{turns:ChatTurn[];scroll:RefObject<HTMLDivElement|null>}) {
  const [active,setActive]=useState('');
  const ids=turns.map(t=>t.task.id).join(',');
  useEffect(()=>{
    const root=scroll.current;if(!root)return;
    const update=()=>{const top=root.getBoundingClientRect().top;let target='';
      for(const article of root.querySelectorAll<HTMLElement>('[data-turn]')){if(target && article.getBoundingClientRect().top>top+root.clientHeight*.3)break;target=article.dataset.turn??'';}setActive(target);};
    update();root.addEventListener('scroll',update,{passive:true});return ()=>root.removeEventListener('scroll',update);
  },[scroll,ids]);
  if(!turns.length)return null;
  return <nav className="cd-minimap" aria-label="对话进度标尺">{turns.map(({task},i)=><button key={task.id} aria-current={task.id===active?'step':undefined}
    title={task.prompt.slice(0,90)} aria-label={`跳转到第 ${i+1} 轮 ${task.prompt.slice(0,60)}`} onClick={()=>{
      document.getElementById('turn-'+task.id)?.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'start'});
    }}><i/></button>)}</nav>;
}
type TurnProps={workspaceId:string;onOpen:(tab:DrawerTab)=>void;onError:(msg:string)=>void;onEdit:(prompt:string)=>void;preferences:ChatPreferences};
const Turn=memo(function Turn({turn,workspaceId,onOpen,onError,onEdit,preferences}:TurnProps & {turn:ChatTurn}){
  const {task,answer,files,projection,finished}=turn;
  const [confirm,setConfirm]=useState(false),[busy,setBusy]=useState(false);
  async function restore(){
    setBusy(true);
    try{await api(`/api/workspaces/${workspaceId}/checkpoints/${encodeURIComponent(task.id)}/restore`,json("POST",{}));setConfirm(false);}
    catch(e){onError((e as Error).message);}finally{setBusy(false);}
  }
  return <article className="cd-turn" data-turn={task.id} id={"turn-"+task.id}>
    <section className="cd-question"><p className="cd-prompt">{task.prompt||"图片附件"}</p><div className="cd-question-actions">
      <time>{new Date(task.created_at).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit"})}</time>
      <button title="复制提问" aria-label="复制提问" onClick={()=>void navigator.clipboard.writeText(task.prompt).catch(()=>onError("浏览器未允许访问剪贴板。"))}><Copy size={13}/></button>
      <button title="编辑并重发" aria-label="编辑并重发" onClick={()=>onEdit(task.prompt)}><Pencil size={13}/></button>
      {task.checkpoint_ref&&<button title="还原本轮检查点" onClick={()=>setConfirm(true)}><GitBranch size={13}/>Checkpoint</button>}
    </div></section>
    {confirm&&<div className="cd-confirm">还原到本轮开始前的工作区？<button disabled={busy} onClick={()=>void restore()}>确认回滚</button><button onClick={()=>setConfirm(false)}>取消</button></div>}
    <Trace turn={turn} expanded={preferences.expandTimeline}/>
    {turn.summaryOnly && task.status==="completed" && answer.trim() && <small>这轮历史仅留存了回复摘要。</small>}
    {answer?<AnswerDocument source={answer} turnId={task.id} complete={finished} onError={onError}/>:!finished&&<span role="status" className="cd-thinking">思考中…</span>}
    {preferences.telemetry&&projection.telemetry&&<Telemetry value={projection.telemetry}/>}
    <TurnFiles files={files} value={projection.telemetry} onOpen={onOpen} onError={onError} turnId={task.id} diffStepId="$diff"/>
  </article>;
});
export function Timeline({turns,threadId,...props}:TurnProps & {turns:ChatTurn[];threadId?:string}){
  const [debug,setDebug]=useState(false),[frames,setFrames]=useState<ThreadEvent[]>([]);
  const dialog=useRef<HTMLDialogElement>(null);
  useEffect(()=>{if(!props.preferences.debug)setDebug(false);},[props.preferences.debug]);
  useEffect(()=>{
    if(!debug||!threadId){dialog.current?.close();return;}
    dialog.current?.showModal();
    const abort=new AbortController();
    void api<{tasks:{events:ThreadEvent[]}[]}>("/api/threads/"+threadId+"/history?debug=true",{signal:abort.signal})
      .then(r=>{if(!abort.signal.aborted)setFrames(projectDebug(r.tasks.flatMap(t=>t.events)));})
      .catch(e=>{if(!abort.signal.aborted)props.onError((e as Error).message);});
    return ()=>abort.abort();
  },[debug,threadId,props.onError]);
  return <div className="cd-turns" data-compact={props.preferences.compactBubbles}>
    {turns.map(turn=><Turn key={turn.task.id} turn={turn} {...props}/>)}
    {props.preferences.debug&&<><button className="cd-debug-trigger" onClick={()=>setDebug(true)}>原始协议调试</button>
      <dialog className="cd-debug-drawer" ref={dialog} onCancel={()=>setDebug(false)} aria-label="原始协议调试"><header>原始协议调试<button aria-label="关闭原始协议" onClick={()=>setDebug(false)}><X size={16}/></button></header>
        {debug&&frames.map(f=><pre key={f.seq_id}>{JSON.stringify(f.payload,null,2)}</pre>)}</dialog></>}
  </div>;
}
function projectDebug(events:ThreadEvent[]){
  return events.flatMap(e=>{const p=e.payload as {protocol?:unknown}|null;
    if(e.type==="protocol_debug")return [e];
    return p?.protocol?[{...e,payload:p.protocol}]:[];
  });
}
