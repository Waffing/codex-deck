import {useState} from "react";
import {Check,Folder,FolderPlus,GitFork,Settings2} from "lucide-react";
import type {Workspace} from "@codexdeck/shared";
import {api,json} from "../../lib/api";
export function WorkspaceMenu({workspaces,selected,choose,onSettings}:{onSettings:()=>void;workspaces:Workspace[];selected:string;choose:(w:Workspace)=>void}){
  const [mode,setMode]=useState<""|"new"|"clone">(""),[name,setName]=useState(""),[url,setUrl]=useState(""),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  return <section className="deck-menu workspace-menu" aria-label="工作区切换"><div className="menu-caption">工作区</div>
  {workspaces.map(w=><button className="menu-line" key={w.id} onClick={()=>choose(w)}><Folder size={15}/><span>{w.name}</span>{selected===w.id&&<Check size={14}/>}</button>)}
  {selected&&<button className="menu-line" onClick={onSettings}><Settings2 size={15}/>工作区配置</button>}
  <hr/><button className="menu-line" onClick={()=>setMode("new")}><FolderPlus size={15}/>新建工作区</button><button className="menu-line" onClick={()=>setMode("clone")}><GitFork size={15}/>Clone 仓库</button>
  {mode&&<form onSubmit={async e=>{e.preventDefault();setBusy(true);setError("");try{const w=await api<Workspace>("/api/workspaces"+(mode==="clone"?"/clone":""),json("POST",{name,...(mode==="clone"?{url}:{})}));choose(w);}catch(err){setError(String(err))}finally{setBusy(false)}}}><input autoFocus required placeholder="工作区名称" value={name} onChange={e=>setName(e.target.value)}/>{mode==="clone"&&<input required type="url" placeholder="HTTPS 仓库地址" value={url} onChange={e=>setUrl(e.target.value)}/>}<button disabled={busy} className="deck-submit">{mode==="new"?"创建":"克隆"}</button>{error&&<p role="alert">{error}</p>}</form>}</section>
}
