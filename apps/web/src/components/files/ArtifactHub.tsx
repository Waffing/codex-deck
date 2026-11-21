import {useEffect,useState} from "react";
import {Archive,ArrowDownToLine,ArrowLeft,ArrowRight,Box,Code2,FileSpreadsheet,FileText,Globe,Grid2X2,Image,List,MessageSquare,Search} from "lucide-react";
import type {ArtifactCategory,ArtifactHubPage,Workspace} from "@codexdeck/shared";
import {api,json} from "../../lib/api";
import {formatFileSize} from "./Artifacts";
import type {DrawerTab} from "./DrawerContent";
import {ShareButton} from "./ShareButton";
import "./hub.css";

const categories={document:["文档",FileText],spreadsheet:["表格",FileSpreadsheet],image:["图片",Image],
  web:["网页",Globe],archive:["归档",Archive],code:["代码",Code2]} as const;
type Props={workspaces:Workspace[];open:(tab:DrawerTab)=>void;jump:(id:string)=>void};
export function ArtifactHub({workspaces,open,jump}:Props){
  const [category,setCategory]=useState<ArtifactCategory|"all">("all"),[q,setQ]=useState(""),[workspace,setWorkspace]=useState("");
  const [all,setAll]=useState(false),[sort,setSort]=useState("newest"),[offset,setOffset]=useState(0);
  const [view,setView]=useState(()=>localStorage.getItem("deck.hub.view")==="list"?"list":"grid");
  const [page,setPage]=useState<ArtifactHubPage|null>(null),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  const [selected,setSelected]=useState<string[]>([]);
  const limit=36;
  useEffect(()=>{
    const abort=new AbortController();
    setPage(null);setError("");
    const timer=setTimeout(()=>{
      const params=new URLSearchParams({q,category,sort,mode:all?"all":"smart",offset:String(offset),limit:String(limit)});
      if(workspace)params.set("workspace_id",workspace);
      void api<ArtifactHubPage>("/api/artifacts/hub?"+params,{signal:abort.signal}).then(value=>{
        if(!abort.signal.aborted)setPage(value);
      }).catch(e=>{if(!abort.signal.aborted)setError(e.message);});
    },120);
    return ()=>{clearTimeout(timer);abort.abort();};
  },[q,category,sort,workspace,all,offset]);
  function changeView(value:string){setView(value);localStorage.setItem("deck.hub.view",value);}
  async function download(){
    setBusy(true);setError("");
    try {
      const {download_url}=await api<{download_url:string}>("/api/artifacts/hub/batch-sign",json("POST",{artifact_ids:selected}));
      const a=document.createElement("a");a.href=download_url;a.download="artifacts.zip";a.click();
    }catch(e){setError(e instanceof Error?e.message:"下载失败");}finally{setBusy(false);}
  }
  function select(id:string){
    if(!selected.includes(id) && selected.length>=64){setError("每个 ZIP 最多包含 64 项。");return;}
    setSelected(old=>old.includes(id)?old.filter(i=>i!==id):[...old,id]);
  }
  return <section className="artifact-hub">
    <header><h1>成品资产箱</h1><div className="hub-view"><button aria-label="卡片视图" aria-pressed={view==="grid"} onClick={()=>changeView("grid")}><Grid2X2 size={16}/></button>
      <button aria-label="列表视图" aria-pressed={view==="list"} onClick={()=>changeView("list")}><List size={16}/></button></div></header>
    <div className="hub-filters"><label className="hub-search"><Search size={16}/><input aria-label="搜索文件名" placeholder="搜索文件名" value={q} onChange={e=>{setQ(e.target.value);setOffset(0);}}/></label>
      <select aria-label="资产工作区" value={workspace} onChange={e=>{setWorkspace(e.target.value);setOffset(0);}}><option value="">全部工作区</option>{workspaces.map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</select>
      <select aria-label="时间排序" value={sort} onChange={e=>{setSort(e.target.value);setOffset(0);}}><option value="newest">最新优先</option><option value="oldest">最早优先</option></select>
      <label><input type="checkbox" checked={all} onChange={e=>{setAll(e.target.checked);setOffset(0);}}/> 显示全部文件</label></div>
    <nav aria-label="资产类别"><button aria-pressed={category==="all"} onClick={()=>{setCategory("all");setOffset(0);}}>全部</button>
      {(Object.keys(categories) as ArtifactCategory[]).map(c=><button key={c} aria-pressed={category===c} onClick={()=>{setCategory(c);setOffset(0);}}>{categories[c][0]}</button>)}</nav>
    {selected.length>0&&<div className="hub-selection">已选 {selected.length} 项<button disabled={busy} onClick={()=>void download()}><ArrowDownToLine size={14}/>下载 ZIP</button><button onClick={()=>setSelected([])}>清空</button></div>}
    {error&&<p role="alert">{error}</p>}
    {!page&&!error&&<p role="status">正在读取成品…</p>}
    {page?.total===0&&<div className="deck-empty"><Box size={24}/><p>没有符合条件的文件</p></div>}
    {page&&<><div className={"hub-items "+view}>{page.items.map(item=>{
      const [label,Icon]=categories[item.category];
      return <article key={item.id} className={selected.includes(item.id)?"selected":""}>
        <input type="checkbox" aria-label={"选择 "+item.name} checked={selected.includes(item.id)} onChange={()=>select(item.id)}/>
        <button className="hub-file" title={item.path} onClick={()=>open({kind:item.category==="image"?"image":"file",artifact:item,title:item.name,path:item.path})}>
          <span className="hub-icon"><Icon size={22}/></span><strong>{item.name}</strong><small>{label}{item.size_bytes!=null&&" · "+formatFileSize(item.size_bytes)}</small></button>
        <p>{item.workspace_name}<time dateTime={item.created_at}>{new Date(item.created_at).toLocaleDateString()}</time></p>
        <footer>{item.thread_id&&<button title={item.thread_title??"来源会话"} onClick={()=>jump(item.thread_id!)}><MessageSquare size={14}/>来源会话</button>}<ShareButton artifactId={item.id} name={item.name}/></footer>
      </article>;
    })}</div>
      {page.total>limit&&<div className="hub-pages"><button aria-label="上一页" disabled={offset===0} onClick={()=>setOffset(Math.max(0,offset-limit))}><ArrowLeft size={15}/></button>
        {offset+1}–{Math.min(page.total,offset+limit)} / {page.total}<button aria-label="下一页" disabled={offset+limit>=page.total} onClick={()=>setOffset(offset+limit)}><ArrowRight size={15}/></button></div>}
    </>}
  </section>;
}
