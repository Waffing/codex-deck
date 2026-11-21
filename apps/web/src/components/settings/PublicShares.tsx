import {useEffect,useState} from "react";
import type {PublicShare} from "@codexdeck/shared";
import {api,json} from "../../lib/api";
import {useAction,Feedback,timeLabel} from "./common";

const statuses={active:"可阅读",revoked:"已吊销",expired:"已到期",exhausted:"次数已用完"};

export function PublicShares() {
  const a=useAction(), [rows,setRows]=useState<PublicShare[]>([]),[editing,setEditing]=useState<string>();
  const load=async()=>setRows(await api<PublicShare[]>("/api/shares"));
  useEffect(()=>{void a.run(load);},[]);
  return <><header className="settings-row"><h2>公开分享</h2><button className="ad-button" onClick={()=>void a.run(load)}>刷新</button></header>
    <Feedback {...a}/>{!rows.length&&!a.busy&&<p>还没有公开分享。打开成品后可以创建分享链接。</p>}
    {rows.map(r=><article className="ad-card settings-form" key={r.id}><header className="settings-row"><strong>{r.title}</strong><small>{statuses[r.status]}</small></header>
      <small>{r.rel_path} · {r.requires_passcode?"需要提取码":"直接阅读"} · 阅读 {r.view_count}{r.max_views!==null?" / "+r.max_views:" 次"}</small>
      <small>{timeLabel(r.expires_at)} 到期 · {r.allow_download?"允许原件下载":"仅预览"}</small>
      {r.status!=="revoked"&&<div className="ad-actions"><a className="ad-button" href={"/s/"+r.slug} target="_blank" rel="noreferrer">打开分享</a>
        <button className="ad-button" onClick={()=>setEditing(editing===r.id?undefined:r.id)}>调整分享</button>
        <button className="ad-button ad-danger" disabled={a.busy} onClick={()=>{if(window.confirm("立即吊销「"+r.title+"」的分享链接？"))void a.run(async()=>{await api("/api/shares/"+r.id,{method:"DELETE"});await load();});}}>吊销分享</button></div>}
      {editing===r.id&&r.status!=="revoked"&&<form className="settings-form" onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);void a.run(async()=>{
        const days=Number(f.get("days"));
        await api("/api/shares/"+r.id,json("PATCH",{expires_at:days?new Date(Math.max(Date.now(),Date.parse(r.expires_at))+days*86400000).toISOString():undefined,max_views:Number(f.get("views"))||null,allow_download:f.has("download")}));
        setEditing(undefined);await load();});}}>
        <label>延长天数<input type="number" name="days" min="0" max="3650" defaultValue="0"/></label>
        <label>阅读次数上限<input type="number" name="views" min="1" max="1000000" defaultValue={r.max_views??""} placeholder="不限"/></label>
        <label><input type="checkbox" name="download" defaultChecked={r.allow_download}/> 允许原件下载</label>
        <button className="ad-primary" disabled={a.busy}>保存分享设置</button></form>}
    </article>)}</>;
}
