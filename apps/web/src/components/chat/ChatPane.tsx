import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {ApprovalCard} from "../approval/ApprovalCard";
import type { DrawerTab } from "../files/DrawerContent";
import {Welcome} from "./Playbooks";
import {Timeline,Minimap,defaultPreferences,type ChatPreferences} from "./Timeline";
import {useTurnPages,collectSnapshots,type ChatTurn} from "./turns";
import {QualityCards} from "./QualityCards";
import {AnswerDocument} from "./AnswerDocument";
import {Composer,type ComposerHandle} from "./Composer";
import {queueMessage,deliver,discard,useOutbox} from "../../stores/outbox";
import {ArtifactModeControl} from "./TurnFiles";
import {api} from "../../lib/api";
import type {GlobalSearchHit,TurnPage,TurnSnapshot,Approval,Model,Provider,Thread,ThreadEvent,Workspace} from "@codexdeck/shared";
import "./chat.css";
export type ChatProps = {
  workspace: Workspace;
  searchTurn?: GlobalSearchHit|null;
  thread: Thread | null;
  events: ThreadEvent[];
  approvals: Approval[];
  models: Model[];
  providers: Provider[];
  onCreateThread: () => Promise<Thread>;
  onRefresh: () => void;
  onOpen: (tab: DrawerTab) => void;
  onHandoff?:()=>void;
  onCommandPage?:(page:"mcp"|"apps"|"prompts")=>void;
  onSelectThread?:(thread:Thread)=>void;
  onJumpThread?:(id:string)=>void;
  mobileApprovalId?: string;
  preferences?: ChatPreferences;
  onSnapshot?:(thread:string,cursor:number)=>void;
  onInspect?: (turn:ChatTurn|undefined)=>void;
};
export function ChatPane(props:ChatProps){
  return <ChatBody key={props.workspace.id+":"+(props.thread?.id??"new")} {...props}/>;
}
function ChatBody({workspace,thread,searchTurn,events,approvals,models,providers,onCreateThread,onRefresh,onOpen,mobileApprovalId,onJumpThread,onHandoff,onCommandPage,onSelectThread,onSnapshot,preferences=defaultPreferences,onInspect}:ChatProps){
  const lifecycle=useRef(0);
  const terminal=events.reduce((n,e)=>["task_completed","task_failed","task_cancelled","context_compacted","artifacts_updated"].includes(e.type)?e.seq_id:n,lifecycle.current);
  // A fresh snapshot periodically folds long streams into a compact active turn.
  if(terminal>lifecycle.current || events.length>=512 && (events.at(-1)?.seq_id??0)-lifecycle.current>=256)lifecycle.current=Math.max(terminal,events.at(-1)?.seq_id??0);
  const marker=lifecycle.current;
  const page=useTurnPages(thread?.id,marker,onSnapshot);
  const [located,setLocated]=useState<TurnSnapshot|null>(null);
  const turns=useMemo(()=>{
    const snapshots=new Map([...page.older,...page.tail.turns].map(t=>[t.id,t]));
    if(located&&!snapshots.has(located.id))snapshots.set(located.id,located);
    if(page.tail.active_turn)snapshots.set(page.tail.active_turn.id,page.tail.active_turn);
    return collectSnapshots([...snapshots.values()].sort((a,b)=>a.turn_index-b.turn_index),events);
  },[page.older,page.tail,events,located]);
  const latest=turns.at(-1);
  const running=turns.some(t=>t.task.status==="running") || (!turns.length&&thread?.status==="running");
  const [narrow,setNarrow]=useState(()=>matchMedia("(max-width: 767px)").matches);
  const [error,setError]=useState("");
  const scroll=useRef<HTMLDivElement>(null),follow=useRef(true),composer=useRef<ComposerHandle|null>(null);
  const anchor=useRef<{id:string;offset:number}|null>(null);
  const allPending=useOutbox(s=>s.messages);
  const confirmed=useMemo(()=>new Set(turns.flatMap(t=>[t.task.clientMsgId,t.task.id]).filter((id):id is string=>!!id)),[turns]);
  const outgoing=allPending.filter(m=>m.workspace===workspace.id && m.thread===(thread?.id??null) && !confirmed.has(m.id) && !confirmed.has(m.taskId??""));
  useEffect(()=>{
    const ids=new Set(allPending.filter(m=>confirmed.has(m.id)||confirmed.has(m.taskId??"")).map(m=>m.id));
    discard(ids);
  },[confirmed,allPending]);
  useEffect(()=>{onInspect?.(latest);},[latest,onInspect]);
  useEffect(()=>{
    const media=matchMedia("(max-width: 767px)"),change=()=>setNarrow(media.matches);
    media.addEventListener("change",change);return ()=>media.removeEventListener("change",change);
  },[]);
  useLayoutEffect(()=>{
    const box=scroll.current;if(!box)return;
    if(anchor.current){const element=document.getElementById("turn-"+anchor.current.id);
      if(element)box.scrollTop+=element.getBoundingClientRect().top-anchor.current.offset;
      anchor.current=null;
    }else if(follow.current){box.scrollTop=box.scrollHeight;}
  },[turns,outgoing.length]);
  const target=searchTurn?.thread_id===thread?.id ? searchTurn : null;
  const known=!!target && turns.some(t=>t.task.id===target.entity_id);
  useEffect(()=>{
    if(!target){setLocated(null);return;}
    follow.current=false;
    if(known || target.turn_index===null)return;
    const abort=new AbortController();
    void api<TurnPage>("/api/threads/"+target.thread_id+"/turns?before_turn_index="+(target.turn_index+1)+"&limit=1",{signal:abort.signal})
      .then(response=>{
        if(abort.signal.aborted)return;
        const found=response.turns.find(t=>t.id===target.entity_id) ?? (response.active_turn?.id===target.entity_id?response.active_turn:null);
        if(found)setLocated(found);else setError("目标轮次已不可用");
      }).catch(cause=>{if(!abort.signal.aborted)setError((cause as Error).message);});
    return ()=>abort.abort();
  },[target,known]);
  useLayoutEffect(()=>{
    if(!target||!known)return;
    const el=document.getElementById("turn-"+target.entity_id);
    if(!el)return;
    follow.current=false;
    el.scrollIntoView({block:"center",behavior:"instant"});
    el.classList.add("search-target");
    const timer=setTimeout(()=>el.classList.remove("search-target"),2200);
    return ()=>{clearTimeout(timer);el.classList.remove("search-target");};
  },[target,known]);
  const pending=approvals.filter(a=>a.status==="pending"&&a.thread_id===thread?.id&&!(narrow&&a.id===mobileApprovalId));
  const submit=async (prompt:string,imageIds:string[],mode?:"plan"|"execute")=>{
    follow.current=true;
    const message=queueMessage(workspace.id,thread?.id??null,prompt,imageIds,mode);
    await deliver(message,onCreateThread,()=>{page.refresh();onRefresh();});
  };
  const earlier=async()=>{
    follow.current=false;
    const first=scroll.current?.querySelector<HTMLElement>("[data-turn]");
    if(first?.dataset.turn)anchor.current={id:first.dataset.turn,offset:first.getBoundingClientRect().top};
    await page.loadEarlier();
  };
  const edit=useCallback((prompt:string)=>composer.current?.edit(prompt),[]);
  return <div className="cd-chat-pane">
    {preferences.minimap!==false&&<Minimap turns={turns} scroll={scroll}/>}
    <div ref={scroll} className="cd-chat-scroll" onScroll={e=>{
      const box=e.currentTarget;follow.current=box.scrollHeight-box.clientHeight-box.scrollTop<120;
      if(box.scrollTop<1 && !follow.current && page.more)void earlier();
    }} onWheel={e=>{if(e.deltaY<0&&e.currentTarget.scrollTop<10&&page.more)void earlier();}}>
      {thread?.handoff_doc&&<details className="quality-card handoff-card"><summary>架构交接单</summary><AnswerDocument source={thread.handoff_doc} turnId={thread.id} complete={false} onError={setError}/>{thread.parent_thread_id&&<button className="btn-outline" onClick={()=>onJumpThread?.(thread.parent_thread_id!)}>打开来源会话</button>}</details>}
      {page.more&&<button className="ad-button" onClick={()=>void earlier()}>加载更早的记录</button>}
      {turns.length>0&&<><ArtifactModeControl/><Timeline turns={turns} threadId={thread?.id} workspaceId={workspace.id} preferences={preferences} onOpen={onOpen} onError={setError} onEdit={edit}/></>}
      {!turns.length&&!outgoing.length&&(!thread||page.initialLoaded)&&<Welcome workspaceId={workspace.id} workspaceName={workspace.name} onSelect={p=>void submit(p,[])}/>}
      {thread&&<QualityCards threadId={thread.id} events={events} refresh={()=>{page.refresh();onRefresh();}}/>}
      {outgoing.map(message=><article key={message.id} className="cd-turn" data-client-message={message.id}>
        <section className="cd-question"><p className="cd-prompt">{message.prompt||"图片附件"}</p></section>
        {message.state==="failed"?<button className="cd-compose-error" title={message.error} onClick={()=>void deliver(message,onCreateThread,()=>{page.refresh();onRefresh();})}>发送失败 · 点击重试</button>
        :<span role="status" className="cd-thinking">思考中…</span>}
      </article>)}
    </div>
    {pending.length>0&&<aside className="cd-pending-stack">{pending.map((a,i)=><ApprovalCard key={a.id} approval={a} workspaceName={workspace.name} onResolved={onRefresh} shortcut={i===0}/>)}</aside>}
    {(page.error||error)&&<p role="alert">{page.error||error}</p>}
    <Composer {...{workspace,thread,models,providers,onCreateThread,onRefresh,latest,running,preferences,onHandoff,onCommandPage,onSelectThread,onOpen}} hasTurns={!!turns.length} onSend={submit} refresh={page.refresh} handle={composer}/>
  </div>;
}
