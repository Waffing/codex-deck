import { useState } from "react";
import { ChevronDown, ChevronRight, Folder, Pin, Ellipsis, Plus, Search } from "lucide-react";
import type { Thread, Workspace } from "@codexdeck/shared";
import { api, json } from "../../lib/api";

interface Props {
  workspaces: Workspace[]; threads: Thread[]; activeId: string; pending: Set<string>;
  open: (thread: Thread) => void; create: () => void; refresh: () => Promise<void>;
  onError: (error: unknown) => void;
}
export function ConversationList({workspaces,threads,activeId,pending,open,create,refresh,onError}: Props) {
  const [search,setSearch] = useState("");
  const [closed,setClosed] = useState<string[]>([]);
  const [menu,setMenu] = useState<string|null>(null);
  const [edit,setEdit] = useState<"rename"|"delete"|null>(null);
  const [title,setTitle] = useState("");
  const [saving,setSaving] = useState(false);
  const needle = search.trim().toLocaleLowerCase();
  const visible = threads.filter(t=>t.title.toLocaleLowerCase().includes(needle));
  async function save(t:Thread, change?:{title?:string;pinned?:boolean}) {
    setSaving(true);
    try {
      await api("/api/threads/"+encodeURIComponent(t.id),change?json("PATCH",change):{method:"DELETE"});
      setMenu(null); setEdit(null); await refresh();
    } catch(e) { onError(e); } finally { setSaving(false); }
  }
  function row(t:Thread) {
    return <div key={t.id} className="thread-line">
      <button title={t.title} className={t.id===activeId?"active":""} onClick={()=>open(t)}>
        <i className={"status-dot "+(pending.has(t.id)?"pending":t.status)}/><span>{t.title}</span>
      </button>
      <button className="thread-menu-toggle" aria-label={"管理 "+t.title} aria-expanded={menu===t.id}
        onClick={()=>{setMenu(menu===t.id?null:t.id);setEdit(null);setTitle(t.title)}}><Ellipsis size={14}/></button>
      {menu===t.id&&<div className="thread-actions">
        {edit==="rename"?<form onSubmit={e=>{e.preventDefault();void save(t,{title:title.trim()})}}>
          <input autoFocus aria-label="会话标题" required maxLength={240} value={title} onChange={e=>setTitle(e.target.value)}/>
          <button disabled={saving||!title.trim()}>保存</button></form>:
        edit==="delete"?<><small>删除此会话及其聊天记录？</small><button disabled={saving} onClick={()=>void save(t)}>确认删除</button></>:
        <><button onClick={()=>void save(t,{pinned:!t.pinned})} disabled={saving}>{t.pinned?"取消置顶":"置顶"}</button>
        <button onClick={()=>setEdit("rename")}>重命名</button><button onClick={()=>setEdit("delete")}>删除</button></>}
        <button onClick={()=>setMenu(null)}>关闭</button>
      </div>}
    </div>;
  }
  return <div className="thread-directory">
    <button className="thread-new" onClick={create} title="新建会话"><Plus size={16}/><span>新建会话</span></button>
    <label className="thread-search"><Search size={14}/><input aria-label="搜索会话" placeholder="搜索会话" type="search" value={search} onChange={e=>setSearch(e.target.value)}/></label>
    <div className="session-list">
      {visible.some(t=>t.pinned)&&<section><h3><Pin size={13}/>置顶会话</h3>{visible.filter(t=>t.pinned).map(row)}</section>}
      {workspaces.map(w=>{
        const items=visible.filter(t=>!t.pinned&&t.workspace_id===w.id);
        if(needle&&!items.length)return null;
        const expanded=!!needle||!closed.includes(w.id);
        return <section key={w.id}><button aria-expanded={expanded} className="project-folder" title={w.name}
          onClick={()=>setClosed(expanded?[...closed,w.id]:closed.filter(id=>id!==w.id))}>
          {expanded?<ChevronDown size={11}/>:<ChevronRight size={11}/>}<Folder size={14}/><span>{w.name}</span></button>
          {expanded&&items.map(row)}</section>;
      })}
      {needle&&!visible.length&&<small>没有匹配的会话</small>}
    </div>
  </div>;
}
