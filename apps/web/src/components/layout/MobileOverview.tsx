import {useEffect,useState} from "react";
import {Activity,ShieldAlert} from "lucide-react";
import type {Approval,Thread,Workspace,Artifact} from "@codexdeck/shared";
import {ApprovalCard} from "../approval/ApprovalCard";
import {api,json} from "../../lib/api";
import type {DrawerTab} from "../files/DrawerContent";
export function MobileOverview({approvals,threads,workspaces,refresh,jump,open,thread}:{approvals:Approval[];threads:Thread[];workspaces:Workspace[];refresh:()=>void;jump:(t:Thread)=>void;open:(t:DrawerTab)=>void;thread:Thread|null}){
  const a=approvals[0],running=threads.filter(t=>t.status==="running"||t.status==="queued");
  const pendingThread=threads.find(t=>t.id===a?.thread_id);
  const [expanded,setExpanded]=useState(true);
  const [picture,setPicture]=useState<{item:Artifact;url:string}|null>(null);
  useEffect(()=>{let active=true;setPicture(null);if(thread && matchMedia("(max-width: 767px)").matches)void (async()=>{
    const history=await api<{artifacts:Artifact[]}>("/api/threads/"+thread.id+"/history");const item=[...history.artifacts].reverse().find(x=>x.change_type==="screenshot");
    if(item){const r=await api<{download_url:string}>("/api/artifacts/sign",json("POST",{artifact_id:item.id}));if(active)setPicture({item,url:r.download_url});}
  })().catch(()=>{});return ()=>{active=false};},[thread?.id,thread?.updated_at]);
  return <section className="mobile-overview">{a&&<><button className="mobile-pending-bar" onClick={()=>setExpanded(!expanded)}><ShieldAlert size={15}/>全局待审批 <b>{approvals.length}</b></button>{expanded&&<ApprovalCard key={a.id} approval={a} workspaceName={workspaces.find(w=>w.id===pendingThread?.workspace_id)?.name??""} onResolved={refresh}/>}</>}
  {!!running.length&&<button className="mobile-task" onClick={()=>jump(running[0])}><Activity size={14}/>进行中 {running.length} · {running[0].title}</button>}
  {picture&&<button className="mobile-shot" onClick={()=>open({kind:"image",title:picture.item.name,path:picture.item.path,artifact:picture.item})}><img src={picture.url} alt="最新验收截图"/>最新验收截图</button>}</section>
}
