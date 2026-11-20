import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Archive, Check, ChevronDown, Clock3, Copy, GitBranch, Pencil, Terminal, X } from "lucide-react";
import { projectTurn, type Artifact, type ThreadEvent, type TimelineItem, type TurnTelemetry } from "@codexdeck/shared";
import { api, json } from "../../lib/api";
import { ArtifactChip, download } from "../files/Artifacts";
import type { DrawerTab } from "../files/DrawerContent";
import { AnswerDocument } from "./AnswerDocument";
export type ChatPreferences = {debug:boolean; telemetry:boolean; expandTimeline:boolean};
export const defaultPreferences:ChatPreferences = {debug:false,telemetry:true,expandTimeline:false};
export type TaskHistory = {id:string;prompt:string;summary:string;status:string;created_at:string;updated_at:string;checkpoint_ref:string|null;events?:ThreadEvent[];answer_markdown?:string};
export type History = {tasks:TaskHistory[];artifacts:Artifact[];next_before?:number|null;next_artifact_before?:number|null};
const labels:Record<string,string> = {queued:"排队中",running:"执行中",completed:"运行完成",failed:"运行失败",cancelled:"已中止"};
export function object(value:unknown):Record<string,unknown> { return value && typeof value === "object" ? value as Record<string,unknown> : {}; }
export function collectTurns(history:History, events:ThreadEvent[]) {
  const tasks=new Map(history.tasks.map(task=>[task.id,{...task}]));
  const records=new Map(history.tasks.map(t=>[t.id,new Map(t.events?.map(e=>[e.seq_id,e]))]));
  const artifacts=new Map(history.artifacts.map(a=>[a.id,a]));
  for(const e of events) {
    const p=object(e.payload),id=e.task_id??(typeof p.turn_id==='string'?p.turn_id:null);
    if(!id)continue;
    const task=tasks.get(id)??{id,prompt:'',summary:'',status:'queued',created_at:e.created_at,updated_at:e.created_at,checkpoint_ref:null};
    if(e.created_at>=task.updated_at){
      if(e.type==='task_started')task.status='running';
      if(['task_completed','task_cancelled','task_failed'].includes(e.type)){task.status=e.type.slice(5);if(typeof p.summary==='string')task.summary=p.summary;}
      task.updated_at=e.created_at;
    }
    if(!task.prompt && typeof p.prompt==='string')task.prompt=p.prompt;
    tasks.set(id,task);
    const frames=records.get(id)??new Map<number,ThreadEvent>();frames.set(e.seq_id,e);records.set(id,frames);
    if(e.type==='artifacts_updated' && Array.isArray(p.artifacts)) for(const a of p.artifacts as Artifact[])artifacts.set(a.id,a);
  }
  return [...tasks.values()].sort((a,b)=>a.created_at.localeCompare(b.created_at)).map(task=>{
    const frames=[...(records.get(task.id)?.values()??[])].sort((a,b)=>a.seq_id-b.seq_id);
    const projection=projectTurn(frames);
    const finished=!['queued','running'].includes(task.status);
    const answer=(finished && task.answer_markdown)||projection.answer||task.answer_markdown||task.summary;
    return {task,frames,projection,finished,answer,files:[...artifacts.values()].filter(a=>a.turn_id===task.id)};
  });
}
export type ChatTurn=ReturnType<typeof collectTurns>[number];
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
  return <section className="cd-step-block"><button type="button" className="cd-step-toggle" aria-expanded={open} onClick={()=>setOpen(!open)}>
    {turn.finished?<Check size={13}/>:<Clock3 size={13}/>} {labels[task.status]??task.status} · {elapsed(ms)} · {count} 个工具 <ChevronDown size={13}/></button>
    {open && <ol>{projection.items.map(item=><li key={item.kind+item.id} data-kind={item.kind}>
      {item.kind==='tool_group'?<details><summary><Terminal size={13}/>{item.text} · {item.operations?.length??0} 次操作</summary>
        {item.operations?.map(op=><pre key={op.id}>{op.detail||op.label}</pre>)}</details>:
        item.kind==='todo_progress'?<details><summary>{item.text||'任务清单'}</summary><TodoSteps steps={item.steps??[]}/></details>:
        item.kind==='context_compacted'?<details><summary>上下文已压缩 · {item.before_estimated?'约 ':''}{item.before_tokens} → {item.estimated?'约 ':''}{item.after_tokens} Token</summary><p>{item.text}</p></details>:
        <p className={item.kind==='subagent_status'?'cd-subagent':'cd-reasoning'}>{item.text}</p>}
    </li>)}</ol>}
  </section>;
}
export function Telemetry({value}:{value:TurnTelemetry}) {
  const totals=value.files.reduce((a,f)=>[a[0]+(f.added??0),a[1]+(f.removed??0)],[0,0]);
  const lines=value.files.some(f=>f.added===null||f.removed===null)?'':` · +${totals[0]} −${totals[1]}`;
  return <section className="cd-telemetry" aria-label="本轮遥测"><details><summary>本轮改动 {value.files.length} 个文件{lines}</summary>
    {value.files.map(f=><div key={f.path}>{f.path} {f.added!==null && `+${f.added}`} {f.removed!==null && `−${f.removed}`}</div>)}
    {value.diff && <pre>{value.diff}</pre>}</details>
    {value.model && <span>{value.model}</span>}
    {value.tokens_per_sec!=null && <span>{value.tokens_per_sec.toFixed(1)} tok/s</span>}
    {value.cache_hit_rate!=null && <span>缓存 {(value.cache_hit_rate*100).toFixed(1)}%</span>}
    {value.input_tokens!=null && value.output_tokens!=null && <span>{(value.input_tokens+value.output_tokens).toLocaleString()} Token</span>}
    {value.cost_usd!=null && <span>${value.cost_usd.toLocaleString('en',{maximumFractionDigits:6})}</span>}
    {value.cost_cny!=null && value.cost_cny>0 && <span>¥{value.cost_cny.toLocaleString('zh-CN',{maximumFractionDigits:6})}</span>}
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
export function Timeline({turns,workspaceId,onOpen,onError,onEdit,preferences}:{turns:ChatTurn[];workspaceId:string;onOpen:(tab:DrawerTab)=>void;onError:(msg:string)=>void;onEdit:(prompt:string)=>void;preferences:ChatPreferences}) {
  const [confirm,setConfirm]=useState<string|null>(null),[busy,setBusy]=useState(false),[debug,setDebug]=useState(false);
  const dialog=useRef<HTMLDialogElement>(null);
  const frames=useMemo(()=>preferences.debug?turns.flatMap(t=>t.projection.debug):[],[turns,preferences.debug]);
  useEffect(()=>{if(!preferences.debug)setDebug(false);},[preferences.debug]);
  useEffect(()=>{if(debug)dialog.current?.showModal();else dialog.current?.close();},[debug]);
  async function restore(id:string){setBusy(true);try{await api(`/api/workspaces/${workspaceId}/checkpoints/${encodeURIComponent(id)}/restore`,json('POST',{}));setConfirm(null);}catch(e){onError((e as Error).message);}finally{setBusy(false);}}
  return <div className="cd-turns">{turns.map(({task,answer,files,projection,finished},i)=><article className="cd-turn" data-turn={task.id} id={'turn-'+task.id} key={task.id}>
    <section className="cd-question"><p className="cd-prompt">{task.prompt||'任务已提交'}</p><div className="cd-question-actions">
      <time>{new Date(task.created_at).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}</time>
      <button title="复制提问" aria-label="复制提问" onClick={async()=>{try{await navigator.clipboard.writeText(task.prompt);}catch{onError('浏览器未允许访问剪贴板。');}}}><Copy size={13}/></button>
      <button title="编辑并重发" aria-label="编辑并重发" onClick={()=>onEdit(task.prompt)}><Pencil size={13}/></button>
      {task.checkpoint_ref && <button title="还原本轮检查点" onClick={()=>setConfirm(task.id)}><GitBranch size={13}/>Checkpoint</button>}
    </div></section>
    {confirm===task.id && <div className="cd-confirm">还原到本轮开始前的工作区？<button disabled={busy} onClick={()=>void restore(task.id)}>确认回滚</button><button onClick={()=>setConfirm(null)}>取消</button></div>}
    <Trace turn={turns[i]} expanded={preferences.expandTimeline}/>
    {task.status==="completed" && answer && !projection.answer && !task.answer_markdown && <small>这轮历史仅留存了回复摘要。</small>}
    {answer && <AnswerDocument source={answer} turnId={task.id} complete={finished} onError={onError}/>}
    {preferences.telemetry && projection.telemetry && <Telemetry value={projection.telemetry}/>}
    {files.length>0 && <div className="cd-artifacts">{files.map(a=><ArtifactChip key={a.id} item={a} screenshots={files.filter(f=>f.change_type==='screenshot' && f.mime_type?.startsWith('image/'))} onOpen={onOpen} onError={onError}/>)}
      <button className="cd-zip" onClick={()=>void download({turn_id:task.id}).catch(()=>onError('打包下载失败'))}><Archive size={13}/>下载本轮 ZIP</button></div>}
  </article>)}
  {preferences.debug && <><button className="cd-debug-trigger" onClick={()=>setDebug(true)}>原始协议调试 · {frames.length}</button>
    <dialog className="cd-debug-drawer" ref={dialog} onCancel={()=>setDebug(false)} aria-label="原始协议调试"><header>原始协议调试<button aria-label="关闭原始协议" onClick={()=>setDebug(false)}><X size={16}/></button></header>
    {debug && frames.map(f=><pre key={f.seq_id}>{JSON.stringify(f.payload,null,2)}</pre>)}</dialog></>}
  </div>;
}
