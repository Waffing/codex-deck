import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {ApprovalCard} from "../approval/ApprovalCard";
import type { DrawerTab } from "../files/DrawerContent";
import {Welcome} from "./Playbooks";
import {Timeline,Minimap,defaultPreferences,type ChatPreferences} from "./Timeline";
import {useTurnPages,collectSnapshots,type ChatTurn} from "./turns";
import {Composer,type ComposerHandle} from "./Composer";
import {queueMessage,deliver,discard,useOutbox} from "../../stores/outbox";
import {ArtifactModeControl} from "./TurnFiles";
import type {Approval,Model,Provider,Thread,ThreadEvent,Workspace} from "@codexdeck/shared";
import "./chat.css";
export type ChatProps = {
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
  onSnapshot?:(thread:string,cursor:number)=>void;
  onInspect?: (turn:ChatTurn|undefined)=>void;
};
export function ChatPane(props:ChatProps){
  return <ChatBody key={props.workspace.id+":"+(props.thread?.id??"new")} {...props}/>;
}
function ChatBody({workspace,thread,events,approvals,models,providers,onCreateThread,onRefresh,onOpen,mobileApprovalId,onSnapshot,preferences=defaultPreferences,onInspect}:ChatProps){
  const marker=events.reduce((n,e)=>["task_completed","task_failed","task_cancelled","context_compacted","artifacts_updated"].includes(e.type)?e.seq_id:n,0);
  const page=useTurnPages(thread?.id,marker,onSnapshot);
  const turns=useMemo(()=>{
    const snapshots=new Map([...page.older,...page.tail.turns].map(t=>[t.id,t]));
    if(page.tail.active_turn)snapshots.set(page.tail.active_turn.id,page.tail.active_turn);
    return collectSnapshots([...snapshots.values()].sort((a,b)=>a.turn_index-b.turn_index),events);
  },[page.older,page.tail,events]);
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
  const pending=approvals.filter(a=>a.status==="pending"&&a.thread_id===thread?.id&&!(narrow&&a.id===mobileApprovalId));
  const submit=async (prompt:string,imageIds:string[])=>{
    follow.current=true;
    const message=queueMessage(workspace.id,thread?.id??null,prompt,imageIds);
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
    }} onWheel={e=>{if(e.deltaY<0&&e.currentTarget.scrollTop<10&&page.more)void earlier();}}>
      {page.more&&<button className="ad-button" onClick={()=>void earlier()}>加载更早的记录</button>}
      {turns.length>0&&<><ArtifactModeControl/><Timeline turns={turns} threadId={thread?.id} workspaceId={workspace.id} preferences={preferences} onOpen={onOpen} onError={setError} onEdit={edit}/></>}
      {!turns.length&&!outgoing.length&&(!thread||page.tail.latest_seq_id===0)&&<Welcome workspaceId={workspace.id} workspaceName={workspace.name} onSelect={p=>void submit(p,[])}/>}
      {outgoing.map(message=><article key={message.id} className="cd-turn" data-client-message={message.id}>
        <section className="cd-question"><p className="cd-prompt">{message.prompt||"图片附件"}</p></section>
        {message.state==="failed"?<button className="cd-compose-error" title={message.error} onClick={()=>void deliver(message,onCreateThread,()=>{page.refresh();onRefresh();})}>发送失败 · 点击重试</button>
        :<span role="status" className="cd-thinking">思考中…</span>}
      </article>)}
    </div>
    {pending.length>0&&<aside className="cd-pending-stack">{pending.map((a,i)=><ApprovalCard key={a.id} approval={a} workspaceName={workspace.name} onResolved={onRefresh} shortcut={i===0}/>)}</aside>}
    {(page.error||error)&&<p role="alert">{page.error||error}</p>}
    <Composer {...{workspace,thread,models,providers,onCreateThread,onRefresh,latest,running,preferences}} hasTurns={!!turns.length} onSend={submit} refresh={page.refresh} handle={composer}/>
  </div>;
}
