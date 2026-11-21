import {useState,useEffect} from "react";
import {BookOpen,Check,Download,FileText,FolderTree,Plug,Plus,Search,Trash2,Upload} from "lucide-react";
import type {McpEntry,PluginId,PromptTemplate,Thread,Workspace} from "@codexdeck/shared";
import {api,json} from "../../lib/api";
import {Feedback,SectionHead,useAction} from "./common";
import {ToggleSwitch} from "./Controls";
import "./modules.css";

function useCollection<T>(url:string){
  const [items,setItems]=useState<T[]>([]),[error,setError]=useState(""),[epoch,setEpoch]=useState(0);
  useEffect(()=>{
    const controller=new AbortController();setError("");
    void api<T[]>(url,{signal:controller.signal}).then(rows=>{if(!controller.signal.aborted)setItems(rows);})
      .catch(e=>{if(!controller.signal.aborted)setError(e.message);});
    return ()=>controller.abort();
  },[url,epoch]);
  return {items,error,refresh:()=>setEpoch(n=>n+1)};
}

export function McpManager(){
  const {items,error,refresh}=useCollection<McpEntry>("/api/mcp"),action=useAction();
  const [editing,setEditing]=useState<string|null>(null),[name,setName]=useState(""),[url,setUrl]=useState("");
  function edit(m?:McpEntry){setName(m?.name??"");setUrl(m?.url??"");setEditing(m?.id??"");}
  return <><SectionHead title="MCP 服务" description="管理 Codex 可调用的工具服务，探测结果来自 MCP 初始化握手。" actions={<button className="ad-primary" onClick={()=>edit()}><Plus size={15}/>添加服务</button>}/>
    {editing!==null&&<form className="module-editor ad-card" onSubmit={e=>{e.preventDefault();void action.run(async()=>{
      await api("/api/mcp"+(editing?"/"+editing:""),json(editing?"PATCH":"POST",{name,url}));setEditing(null);refresh();
    });}}><label>服务名称<input required value={name} onChange={e=>setName(e.target.value)}/></label>
      <label>HTTPS MCP 地址<input type="url" required placeholder="https://tools.example.com/mcp" value={url} onChange={e=>setUrl(e.target.value)}/></label>
      <div><button type="button" onClick={()=>setEditing(null)}>取消</button><button className="ad-primary" disabled={action.busy}>保存</button></div></form>}
    <div className="module-grid">{items.map(m=><article className="ad-card module-card" key={m.id}><header><Plug size={18}/><h2>{m.name}</h2>
      <ToggleSwitch aria-label={"启用 "+m.name} checked={m.enabled} disabled={action.busy} onCheckedChange={enabled=>void action.run(async()=>{await api("/api/mcp/"+m.id,json("PATCH",{enabled}));refresh();})}/></header>
      <code>{m.builtin?"内置 · stdio":m.url}</code><small>{m.status==="online"?"在线":m.status==="offline"?"探测失败":"尚未探测"} {m.checked_at&&new Date(m.checked_at).toLocaleTimeString()}</small>
      <footer><button className="ad-button" disabled={!m.enabled||action.busy} onClick={()=>void action.run(async()=>{await api("/api/mcp/"+m.id+"/probe",json("POST",{}));refresh();})}>探测连接</button>
        {!m.builtin&&<><button onClick={()=>edit(m)}>编辑</button><button aria-label={"删除 "+m.name} onClick={()=>{if(confirm("删除此 MCP 服务？"))void action.run(async()=>{await api("/api/mcp/"+m.id,{method:"DELETE"});refresh();});}}><Trash2 size={15}/></button></>}</footer></article>)}</div>
    <Feedback {...action} error={action.error||error}/></>;
}
const pluginNames:Record<PluginId,[string,string]>={auto_verify:["自动质检门禁","编码后按项目设置运行检查与有限次自愈。"],playwright:["Playwright 验收","使用浏览器检查部署预览与截图。"],smart_artifacts:["智能交付物过滤","在资产箱的智能视图优先显示可交付文件。"],document_viewer:["全能文档直览","在工作区和资产箱中直接查看文件。"],global_search:["全局全文检索","通过命令面板检索对话、产物和部署。"]};
export function PluginManager(){
  const {items,error,refresh}=useCollection<{id:PluginId;enabled:boolean}>("/api/plugins"),action=useAction();
  return <><SectionHead title="插件"/><div className="module-grid">{items.map(m=><article className="ad-card module-card" key={m.id}><header><h2>{pluginNames[m.id][0]}</h2><ToggleSwitch aria-label={pluginNames[m.id][0]} checked={m.enabled} disabled={action.busy} onCheckedChange={enabled=>void action.run(async()=>{await api("/api/plugins/"+m.id,json("PATCH",{enabled}));refresh();})}/></header><p>{pluginNames[m.id][1]}</p></article>)}</div><Feedback {...action} error={action.error||error}/></>;
}
export function PromptLibrary(){
  const {items,error,refresh}=useCollection<PromptTemplate>("/api/prompts"),action=useAction();
  const [editing,setEditing]=useState<PromptTemplate|null>(null);
  return <><SectionHead title="提示词库" description="保存的模板可从工作台的 / 提示词菜单插入。" actions={<button className="ad-primary" onClick={()=>setEditing({id:"",name:"",content:""})}><Plus size={15}/>新建模板</button>}/>
    {editing&&<form className="module-editor ad-card" onSubmit={e=>{e.preventDefault();void action.run(async()=>{const {id,name,content}=editing;await api("/api/prompts"+(id?"/"+id:""),json(id?"PATCH":"POST",{name,content}));setEditing(null);refresh();});}}>
      <label>模板名称<input required maxLength={80} value={editing.name} onChange={e=>setEditing({...editing,name:e.target.value})}/></label>
      <label>提示词正文<textarea required rows={5} maxLength={32768} value={editing.content} onChange={e=>setEditing({...editing,content:e.target.value})}/></label>
      <div><button type="button" onClick={()=>setEditing(null)}>取消</button><button className="ad-primary" disabled={action.busy}>保存模板</button></div></form>}
    {!items.length&&!editing&&<p className="module-empty"><BookOpen size={24}/>还没有提示词模板</p>}
    <div className="module-grid">{items.map(p=><article className="ad-card module-card" key={p.id}><header><FileText size={18}/><h2>{p.name}</h2></header><p className="prompt-preview">{p.content}</p><footer><button className="ad-button" onClick={()=>setEditing(p)}>编辑模板</button><button aria-label={"删除 "+p.name} onClick={()=>{if(confirm("删除此模板？"))void action.run(async()=>{await api("/api/prompts/"+p.id,{method:"DELETE"});refresh();});}}><Trash2 size={15}/></button></footer></article>)}</div>
    <Feedback {...action} error={action.error||error}/></>;
}
type SkillText={content:string;revision:string;read_only:boolean};
export function Skills({workspace}:{workspace:Workspace}){
  const [scope,setScope]=useState("project"),[name,setName]=useState("AGENTS.md"),[source,setSource]=useState(""),[loaded,setLoaded]=useState<SkillText|null>(null),[error,setError]=useState("");
  const [newName,setNewName]=useState(""),[creating,setCreating]=useState(false),action=useAction();
  const base="/api/workspaces/"+workspace.id, list=useCollection<string>(base+"/skills?scope="+scope);
  const endpoint=name==="AGENTS.md"?base+"/agents-md?scope="+scope:base+"/skills/"+encodeURIComponent(name)+"?scope="+scope;
  useEffect(()=>{
    const controller=new AbortController();setLoaded(null);setError("");setSource("");
    if(!creating)void api<SkillText>(endpoint,{signal:controller.signal}).then(v=>{if(!controller.signal.aborted){setLoaded(v);setSource(v.content);}}).catch(e=>{if(!controller.signal.aborted)setError(e.message);});
    return ()=>controller.abort();
  },[endpoint,creating]);
  function select(n:string){setCreating(false);setName(n);}
  function exportText(){const handle=URL.createObjectURL(new Blob([source],{type:"text/markdown"}));const a=document.createElement("a");a.href=handle;a.download=name==="AGENTS.md"?name:name+"-SKILL.md";a.click();setTimeout(()=>URL.revokeObjectURL(handle),1000);}
  return <><SectionHead title="Skills 与项目规范" description={workspace.name}/><div className="ad-card module-editor">
    <label>生效范围<select value={scope} onChange={e=>{setScope(e.target.value);select("AGENTS.md");}}><option value="project">当前项目</option><option value="global">全局</option></select></label>
    <label>规范文件<select value={creating?"":name} onChange={e=>select(e.target.value)}><option>AGENTS.md</option>{list.items.map(n=><option key={n} value={n}>{n}/SKILL.md</option>)}{creating&&<option value="">新技能</option>}</select></label>
    <button className="ad-button" onClick={()=>{setCreating(true);setNewName("");setSource("");}}><Plus size={14}/>新建技能</button>
    {creating&&<label>技能名<input value={newName} placeholder="release-check" onChange={e=>setNewName(e.target.value)}/></label>}
    <textarea aria-label="规范正文" rows={14} value={source} disabled={!creating&&!loaded} readOnly={loaded?.read_only} onChange={e=>setSource(e.target.value)}/>
    <div><label className="ad-button"><Upload size={14}/>导入 Markdown<input type="file" accept=".md,text/markdown,text/plain" disabled={loaded?.read_only} className="sr-only" onChange={e=>{const f=e.target.files?.[0];if(f)void action.run(async()=>{if(f.size>65536)throw new Error("文件超过 64 KiB。");setSource(await f.text());});}}/></label>
    <button className="ad-button" disabled={!source} onClick={exportText}><Download size={14}/>导出</button>
    {!creating&&name!=="AGENTS.md"&&loaded&&<button className="ad-button" onClick={()=>{if(confirm("删除此技能规范？"))void action.run(async()=>{await api(endpoint,{method:"DELETE",headers:{"if-match":loaded.revision}});select("AGENTS.md");list.refresh();});}}>删除</button>}
    <button className="ad-primary" disabled={action.busy||(!creating&&(!loaded||loaded.read_only))} onClick={()=>void action.run(async()=>{
      if(creating && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(newName))throw new Error("技能名可用小写字母、数字、连字符和下划线。");
      const path=creating?base+"/skills/"+newName+"?scope="+scope:endpoint;
      const result=await api<{revision:string}>(path,{...json("PUT",{content:source}),headers:{"Content-Type":"application/json","if-match":creating?"missing":loaded!.revision}});
      setLoaded({content:source,revision:result.revision,read_only:false});if(creating){select(newName);list.refresh();}
    },"已保存规范")}><Check size={15}/>保存规范</button></div></div><Feedback {...action} error={action.error||error||list.error}/></>;
}
type SessionRow=Pick<Thread,"id"|"workspace_id"|"title"|"updated_at">&{pinned?:boolean};
export function Sessions({threads,workspaces,jump,refresh}:{threads:Thread[];workspaces:Workspace[];jump:(id:string)=>void;refresh:()=>void}){
  const archive=useCollection<SessionRow>("/api/threads/archived"),[archived,setArchived]=useState(false),[q,setQuery]=useState(""),[selected,setSelected]=useState<string[]>([]),action=useAction();
  const rows:SessionRow[]=(archived?archive.items:threads).filter(t=>(t.title+" "+(workspaces.find(w=>w.id===t.workspace_id)?.name??"")).toLowerCase().includes(q.toLowerCase()));
  return <><SectionHead title="会话"/><div className="module-filters"><span><Search size={15}/><input aria-label="搜索所有会话" placeholder="按标题或项目搜索" value={q} onChange={e=>setQuery(e.target.value)}/></span><select aria-label="归档状态" value={String(+archived)} onChange={e=>{setArchived(e.target.value==="1");setSelected([]);}}><option value="0">当前会话</option><option value="1">已归档</option></select>
    <button className="ad-button" disabled={!selected.length||action.busy} onClick={()=>void action.run(async()=>{await api("/api/threads/archive",json("POST",{ids:selected,archived:!archived}));setSelected([]);archive.refresh();refresh();})}>{archived?"恢复":"归档"}选中项 · {selected.length}</button></div>
    <div className="ad-card module-list">{rows.map(t=><div key={t.id}><input type="checkbox" aria-label={"选择 "+t.title} checked={selected.includes(t.id)} onChange={e=>setSelected(e.target.checked?[...selected,t.id]:selected.filter(id=>id!==t.id))}/><FolderTree size={15}/><small>{workspaces.find(w=>w.id===t.workspace_id)?.name}</small><button disabled={archived} onClick={()=>jump(t.id)}>{t.title}</button>
      {!archived&&<button className="ad-button" onClick={()=>void action.run(async()=>{await api("/api/threads/"+t.id,json("PATCH",{pinned:!t.pinned}));refresh();})}>{t.pinned?"取消置顶":"置顶"}</button>}</div>)}{!rows.length&&<p>未找到会话</p>}</div><Feedback {...action} error={action.error||archive.error}/></>;
}
