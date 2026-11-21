import {useCallback,useEffect,useMemo,useState} from "react";
import {threadEventSchema,type Workspace,type TempAccessLink,type Thread,type ThreadEvent,type Deployment} from "@codexdeck/shared";
import {api,json} from "../lib/api";
import {AnswerDocument} from "./chat/AnswerDocument";
import {collectSnapshots,useTurnPages} from "./chat/turns";
import {clearOutbox,deliver,discard,queueMessage,useOutbox} from "../stores/outbox";
import {download} from "./files/Artifacts";
import {permissions,Quotas,remaining} from "./settings/TemporaryAccess";
import {useAction,Feedback} from "./settings/common";


export function GuestWorkbench(){
  const [link,setLink]=useState<TempAccessLink>(),[ended,end]=useState(""),[spaces,setSpaces]=useState<Workspace[]>([]),[threads,setThreads]=useState<Thread[]>([]);
  const [workspaceId,chooseWorkspace]=useState(""),[threadId,chooseThread]=useState("");
  const [rev,refresh]=useState(0),[tick,setTick]=useState(0);
  const [files,setFiles]=useState<string[]>([]),[query,search]=useState(""),[preview,setPreview]=useState<{path:string;content:string}>();
  const [services,setServices]=useState<Pick<Deployment,"id"|"workspace_id"|"preview_url"|"status">[]>([]);
  const action=useAction();
  const fail=useCallback((e:unknown)=>{const err=e as {status?:number;message?:string};if(err.status===401 || err.status===403)end("临时访问已结束，请联系管理员检查邀请的有效期、额度或 IP 限制。");else action.setError(err.message??"连接暂时不可用。");},[action.setError]);
  const wid=spaces.some(w=>w.id===workspaceId)?workspaceId:(spaces[0]?.id??"");
  const allowedThreads=threads.filter(t=>t.workspace_id===wid);
  const tid=allowedThreads.some(t=>t.id===threadId)?threadId:allowedThreads[0]?.id??"";
  useEffect(()=>{
    if(ended)return;
    let active=true;
    const load=()=>Promise.all([api<TempAccessLink>("/api/guest/session"),api<Workspace[]>("/api/workspaces"),api<Thread[]>("/api/threads"),api<typeof services>("/api/guest/previews")]).then(([l,w,t,s])=>{if(active){setLink(l);setSpaces(w);setThreads(t);setServices(s);}}).catch(e=>{if(active)fail(e);});
    void load();const timer=setInterval(load,5000);
    return()=>{active=false;clearInterval(timer);};
  },[ended,fail,rev]);
  useEffect(()=>{if(!link||ended)return;const t=setInterval(()=>{if(Date.now()>=Date.parse(link.expires_at))end("邀请已到期。管理员续期后可以重新进入。");else setTick(v=>v+1);},1000);return()=>clearInterval(t);},[link,ended]);
  useEffect(()=>{setPreview(undefined);setFiles([]);},[wid,tid]);
  useEffect(()=>{if(ended)clearOutbox();},[ended]);
  useEffect(()=>{if(!wid||ended||!query.trim()){setFiles([]);return;}let active=true;const timer=setTimeout(()=>{
    void api<{files:string[]}>("/api/workspaces/"+wid+"/files/search?q="+encodeURIComponent(query)).then(r=>{if(active)setFiles(r.files);}).catch(e=>{if(active)fail(e);});
  },240);return()=>{active=false;clearTimeout(timer);};},[wid,query,ended,fail]);
  if(ended)return <main className="deck-empty"><h1>临时访问已结束</h1><p role="status">{ended}</p></main>;
  if(!link)return <main className="deck-empty"><h1>临时工作区</h1><p>{action.error||"正在核验邀请…"}</p></main>;
  const canWrite=link.permission!=="readonly";
  return <main className="guest-page"><header className="guest-banner"><strong>临时访问模式</strong><span>{permissions[link.permission]}</span><span data-clock={tick}>剩余 {remaining(link)}</span><Quotas link={link}/><button className="ad-button" onClick={()=>void action.run(async()=>{await api("/api/guest/logout",{method:"POST"});end("已退出临时工作区。");})}>退出</button></header>
    <div className="guest-layout"><aside className="ad-card"><h2>授权工作区</h2><select aria-label="授权工作区" value={wid} onChange={e=>{chooseWorkspace(e.target.value);chooseThread("");search("");}}>{spaces.map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</select>
    <label>会话<select aria-label="访客会话" value={tid} onChange={e=>chooseThread(e.target.value)}>{allowedThreads.map(t=><option key={t.id} value={t.id}>{t.title}</option>)}</select></label>
    {canWrite&&<button className="ad-button" onClick={()=>void action.run(async()=>{const t=await api<Thread>("/api/threads",json("POST",{workspace_id:wid,title:"访客会话"}));setThreads(v=>[t,...v]);chooseThread(t.id);})}>新建访客会话</button>}
    {services.filter(s=>s.workspace_id===wid && s.preview_url).map(s=><a key={s.id} href={s.preview_url} rel="noopener noreferrer" target="_blank">预览服务 · {s.preview_url?.split("/")[2]}</a>)}
    <label>查找文件<input aria-label="查找文件" value={query} onChange={e=>search(e.target.value)}/></label>{files.map(p=><button key={p} onClick={()=>void action.run(async()=>setPreview(await api("/api/workspaces/"+wid+"/files/content?path="+encodeURIComponent(p))))}>{p}</button>)}
    </aside><section><Feedback {...action}/>{preview&&<div className="ad-card"><strong>{preview.path}</strong><button onClick={()=>setPreview(undefined)}>关闭预览</button><pre>{preview.content}</pre></div>}
    <GuestChat key={link.id+":"+wid+":"+tid} tid={tid} wid={wid} canWrite={canWrite} fail={fail} end={end} setLink={setLink}
      create={async()=>{const t=await api<Thread>("/api/threads",json("POST",{workspace_id:wid,title:"访客会话"}));setThreads(v=>[t,...v]);chooseThread(t.id);return t;}}/>
    </section></div></main>;
}
function GuestChat({tid,wid,canWrite,fail,end,setLink,create}:{tid:string;wid:string;canWrite:boolean;fail:(e:unknown)=>void;end:(m:string)=>void;setLink:(link:TempAccessLink)=>void;create:()=>Promise<Thread>}){
  const [events,setEvents]=useState<ThreadEvent[]>([]),[initial,setInitial]=useState<number|null>(null);
  const [prompt,setPrompt]=useState(""),[offline,setOffline]=useState(false);
  const ready=useCallback((_id:string,seq:number)=>setInitial(v=>v??seq),[]);
  const marker=events.reduce((seq,e)=>/^task_(completed|cancelled|failed)$/.test(e.type)?e.seq_id:seq,0);
  const page=useTurnPages(tid,marker,ready,false),action=useAction();
  const all=useOutbox(s=>s.messages),turns=useMemo(()=>collectSnapshots([...page.older,...page.tail.turns],events),[page.older,page.tail,events]);
  const confirmed=useMemo(()=>new Set(turns.flatMap(t=>[t.task.id,t.task.clientMsgId])),[turns]);
  const pending=all.filter(m=>m.workspace===wid&&m.thread===(tid||null)&&!confirmed.has(m.id)&&!confirmed.has(m.taskId??""));
  useEffect(()=>{discard(new Set(all.filter(m=>confirmed.has(m.id)||confirmed.has(m.taskId??"")).map(m=>m.id)));},[all,confirmed]);
  useEffect(()=>{
    if(tid&&initial===null)return;
    let done=false,cursor=initial??0,socket:WebSocket|undefined,retry:ReturnType<typeof setTimeout>;
    function connect(){
      const url=new URL("/ws/events",location.href);url.protocol=location.protocol==="https:"?"wss:":"ws:";
      if(tid){url.searchParams.set("thread_id",tid);url.searchParams.set("last_seq_id",String(cursor));}
      socket=new WebSocket(url);socket.onopen=()=>{if(!done)setOffline(false);};
      socket.onmessage=e=>{
        if(done)return;
        const frame=JSON.parse(e.data);
        if(frame.type==="event"){
          const parsed=threadEventSchema.safeParse(frame.event);
          if(parsed.success && parsed.data.thread_id===tid && parsed.data.seq_id>cursor){
            cursor=parsed.data.seq_id;setEvents(v=>[...v,parsed.data]);
          }
        }else if(frame.type==="cursor"&&frame.thread_id===tid&&Number.isSafeInteger(frame.seq_id))cursor=Math.max(cursor,frame.seq_id);
        else if(frame.type==="guest_status"&&frame.link)setLink(frame.link);
      };
      socket.onclose=e=>{if(done)return;if(e.code===1008){end("临时访问已结束，请联系管理员续期或重新邀请。");return;}setOffline(true);retry=setTimeout(connect,1500);};
    }
    connect();return()=>{done=true;clearTimeout(retry);if(socket?.readyState===WebSocket.CONNECTING)socket.onopen=()=>socket?.close();else socket?.close();};
  },[initial,tid,end,setLink]);
  return <><Feedback {...action}/>{offline&&<p>实时流正在重连…</p>}{page.error&&<p role="alert">{page.error}</p>}
    {page.more&&<button onClick={()=>void page.loadEarlier()}>加载更早的记录</button>}
    {!turns.length&&!pending.length&&<p className="ad-card">当前会话还没有消息。</p>}
    {turns.map(({task,answer,projection,files,finished})=><article className="ad-card" key={task.id}><p className="cd-prompt">{task.prompt}</p>
      {projection.items.length>0&&<details><summary>执行过程</summary>{projection.items.map(i=><p key={i.id}>{i.text||i.operations?.map(o=>o.label).join("、")}</p>)}</details>}
      {answer&&<AnswerDocument source={answer} complete={finished} turnId={task.id} onError={action.setError}/>}
      {files.map(f=><button className="ad-button" key={f.id} onClick={()=>void action.run(()=>download({artifact_id:f.id}))}>下载 {f.name}</button>)}</article>)}
    {pending.map(m=><article key={m.id} className="ad-card"><p className="cd-prompt">{m.prompt}</p>{m.state==="failed"?<button onClick={()=>void deliver(m,create,page.refresh)}>发送失败 · 点击重试</button>:<span role="status">思考中…</span>}</article>)}
    {canWrite&&<form className="ad-card settings-form" onSubmit={e=>{
      e.preventDefault();if(!prompt.trim())return;const m=queueMessage(wid,tid||null,prompt,[]);setPrompt("");void deliver(m,create,page.refresh);
    }}><textarea aria-label="访客消息" value={prompt} required onChange={e=>setPrompt(e.target.value)}/>
      <label>上传附件<input type="file" onChange={e=>{const file=e.target.files?.[0];if(!file)return;void action.run(async()=>{const body=new FormData();body.set("file",file);const result=await api<{path:string}>("/api/workspaces/"+wid+"/files/upload",{method:"POST",body});setPrompt(p=>p+" @"+result.path);}).catch(fail);}}/></label><button className="ad-primary" disabled={!wid||action.busy}>发送</button></form>}</>;
}
