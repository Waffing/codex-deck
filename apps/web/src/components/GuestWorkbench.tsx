import {useCallback,useEffect,useState} from "react";
import {threadEventSchema,type Workspace,type TempAccessLink,type Thread,type ThreadEvent,type Deployment} from "@codexdeck/shared";
import {api,json} from "../lib/api";
import {AnswerDocument} from "./chat/AnswerDocument";
import {collectTurns,type History} from "./chat/Timeline";
import {download} from "./files/Artifacts";
import {permissions,Quotas,remaining} from "./settings/TemporaryAccess";
import {useAction,Feedback} from "./settings/common";

const empty:History={tasks:[],artifacts:[]};
export function GuestWorkbench(){
  const [link,setLink]=useState<TempAccessLink>(),[ended,end]=useState(""),[spaces,setSpaces]=useState<Workspace[]>([]),[threads,setThreads]=useState<Thread[]>([]);
  const [workspaceId,chooseWorkspace]=useState(""),[threadId,chooseThread]=useState(""),[history,setHistory]=useState<History>(empty),[events,setEvents]=useState<ThreadEvent[]>([]);
  const [prompt,setPrompt]=useState(""),[rev,refresh]=useState(0),[tick,setTick]=useState(0),[offline,setOffline]=useState(false);
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
  useEffect(()=>{
    if(!tid||ended){setHistory(empty);return;}
    let active=true;
    void api<History>("/api/threads/"+tid+"/history").then(h=>{if(active)setHistory(h);}).catch(e=>{if(active)fail(e);});
    return()=>{active=false;};
  },[tid,ended,fail,rev]);
  useEffect(()=>{
    if(!link?.id||ended)return;
    setEvents([]);let done=false,socket:WebSocket|undefined,retry:ReturnType<typeof setTimeout>;
    const connect=()=>{const url=new URL("/ws/events",location.href);url.protocol=location.protocol==="https:"?"wss:":"ws:";if(tid)url.searchParams.set("thread_id",tid);
      socket=new WebSocket(url);socket.onopen=()=>{if(!done){setOffline(false);refresh(v=>v+1);}};
      socket.onmessage=e=>{if(done)return;const frame=JSON.parse(e.data);if(frame.type==="event"){
        const parsed=threadEventSchema.safeParse(frame.event);
        if(parsed.success && parsed.data.thread_id===tid){setEvents(prev=>[...prev.slice(-511),parsed.data]);if(/^task_(completed|failed|cancelled)$/.test(parsed.data.type))refresh(v=>v+1);}
      }if(frame.type==="thread_changed")refresh(v=>v+1);if(frame.type==="guest_status"&&frame.link)setLink(frame.link);};
      socket.onclose=e=>{if(done)return;if(e.code===1008){end("临时访问已结束，请联系管理员续期或重新邀请。");return;}setOffline(true);retry=setTimeout(connect,1800);};};
    connect();return()=>{done=true;clearTimeout(retry);if(socket?.readyState===WebSocket.OPEN)socket.close();else if(socket)socket.onopen=()=>socket?.close();};
  },[tid,link?.id,ended]);
  useEffect(()=>{setHistory(empty);setPreview(undefined);setFiles([]);},[wid,tid]);
  useEffect(()=>{if(!wid||ended||!query.trim()){setFiles([]);return;}let active=true;const timer=setTimeout(()=>{
    void api<{files:string[]}>("/api/workspaces/"+wid+"/files/search?q="+encodeURIComponent(query)).then(r=>{if(active)setFiles(r.files);}).catch(e=>{if(active)fail(e);});
  },240);return()=>{active=false;clearTimeout(timer);};},[wid,query,ended,fail]);
  if(ended)return <main className="deck-empty"><h1>临时访问已结束</h1><p role="status">{ended}</p></main>;
  if(!link)return <main className="deck-empty"><h1>临时工作区</h1><p>{action.error||"正在核验邀请…"}</p></main>;
  const canWrite=link.permission!=="readonly",turns=collectTurns(history,events);
  return <main className="guest-page"><header className="guest-banner"><strong>临时访问模式</strong><span>{permissions[link.permission]}</span><span data-clock={tick}>剩余 {remaining(link)}</span><Quotas link={link}/><button className="ad-button" onClick={()=>void action.run(async()=>{await api("/api/guest/logout",{method:"POST"});end("已退出临时工作区。");})}>退出</button></header>
    <div className="guest-layout"><aside className="ad-card"><h2>授权工作区</h2><select aria-label="授权工作区" value={wid} onChange={e=>{chooseWorkspace(e.target.value);chooseThread("");search("");setPrompt("");}}>{spaces.map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</select>
    <label>会话<select aria-label="访客会话" value={tid} onChange={e=>chooseThread(e.target.value)}>{allowedThreads.map(t=><option key={t.id} value={t.id}>{t.title}</option>)}</select></label>
    {canWrite&&<button className="ad-button" onClick={()=>void action.run(async()=>{const t=await api<Thread>("/api/threads",json("POST",{workspace_id:wid,title:"访客会话"}));setThreads(v=>[t,...v]);chooseThread(t.id);})}>新建访客会话</button>}
    {services.filter(s=>s.workspace_id===wid && s.preview_url).map(s=><a key={s.id} href={s.preview_url} rel="noopener noreferrer" target="_blank">预览服务 · {s.preview_url?.split("/")[2]}</a>)}
    <label>查找文件<input aria-label="查找文件" value={query} onChange={e=>search(e.target.value)}/></label>{files.map(p=><button key={p} onClick={()=>void action.run(async()=>setPreview(await api("/api/workspaces/"+wid+"/files/content?path="+encodeURIComponent(p))))}>{p}</button>)}
    </aside><section><Feedback {...action}/>{offline&&<p>实时流正在重连…</p>}{preview&&<div className="ad-card"><strong>{preview.path}</strong><button onClick={()=>setPreview(undefined)}>关闭预览</button><pre>{preview.content}</pre></div>}
    {!turns.length&&<p className="ad-card">当前会话还没有消息。</p>}
    {turns.map(({task,answer,projection,files:artifacts})=><article className="ad-card" key={task.id}><p className="cd-prompt">{task.prompt}</p>
      {projection.items.length>0&&<details><summary>执行过程</summary>{projection.items.map(i=><p key={i.id}>{i.text||i.operations?.map(o=>o.label).join("、")}</p>)}</details>}
      {answer&&<AnswerDocument source={answer} complete={task.status==="completed"} turnId={task.id} onError={action.setError}/>}
      {artifacts.map(f=><button className="ad-button" key={f.id} onClick={()=>void action.run(()=>download({artifact_id:f.id}))}>下载 {f.name}</button>)}</article>)}
    {canWrite&&<form className="ad-card settings-form" onSubmit={e=>{e.preventDefault();void action.run(async()=>{
      let id=tid;if(!id){const t=await api<Thread>("/api/threads",json("POST",{workspace_id:wid,title:"访客会话"}));id=t.id;setThreads(v=>[t,...v]);chooseThread(id);}
      await api("/api/threads/"+id+"/messages",json("POST",{prompt}));setPrompt("");refresh(v=>v+1);
    });}}><textarea aria-label="访客消息" value={prompt} required onChange={e=>setPrompt(e.target.value)}/><label>上传附件<input type="file" onChange={e=>{const file=e.target.files?.[0];if(!file)return;void action.run(async()=>{const body=new FormData();body.set("file",file);const result=await api<{path:string}>("/api/workspaces/"+wid+"/files/upload",{method:"POST",body});setPrompt(p=>p+" @"+result.path);});}}/></label><button className="ad-primary" disabled={!wid||action.busy}>发送</button></form>}</section></div></main>;
}
