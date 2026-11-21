import {useEffect,useState} from "react";
import type {TempAccessLink,Workspace} from "@codexdeck/shared";
import {api,json} from "../../lib/api";
import {Feedback,useAction,timeLabel} from "./common";

export const permissions={readonly:"只读",collab_restricted:"受限协作",full_with_approval:"开发与审批"};
const statuses={active:"有效",expired:"已过期",revoked:"已吊销",exhausted:"额度用尽"};
type Live={id:string;ip:string;workspace_id:string|null;link:TempAccessLink};
type Audit={id:number;action:string;ip:string;created_at:string};
export function remaining(link:TempAccessLink) {
  const seconds=Math.max(0,Math.ceil((Date.parse(link.expires_at)-Date.now())/1000));
  return Math.floor(seconds/3600)+" 小时 "+Math.floor(seconds%3600/60)+" 分 "+seconds%60+" 秒";
}
export function Quotas({link}:{link:TempAccessLink}){
  return <div className="guest-quotas">{([["轮次",link.used_turns,link.max_turns],["Token",link.used_tokens,link.max_tokens],[link.currency,link.used_cost,link.max_cost]] as const).map(([label,used,cap])=><span key={label}>{label} {Number(used.toFixed(5))} / {cap??"不限"} {cap!=null&&<progress value={used} max={cap}/>}</span>)}{link.usage_unconfirmed&&<small>上游缺少本次用量，已暂停访问。核对账单后可追加额度恢复。</small>}</div>;
}
export function TemporaryAccess({workspaces}:{workspaces:Workspace[]}) {
  const [links,setLinks]=useState<TempAccessLink[]>([]),[live,setLive]=useState<Live[]>([]),[audit,setAudit]=useState<Audit[]>([]);
  const [invite,setInvite]=useState(""),[editing,setEditing]=useState<TempAccessLink>(),[create,setCreate]=useState(false);
  const a=useAction();
  async function load(){const [list,online,events]=await Promise.all([api<TempAccessLink[]>("/api/temp-access"),api<Live[]>("/api/temp-access/live"),api<Audit[]>("/api/security/audit")]);setLinks(list);setLive(online);setAudit(events.filter(ev=>/guest|temp/i.test(ev.action)));}
  useEffect(()=>{void a.run(load);const timer=setInterval(()=>void load().catch(e=>a.setError(e.message)),10000);return()=>clearInterval(timer);},[]);
  return <><Feedback {...a}/><header className="settings-row"><h2>临时访问链接</h2><button className="ad-primary" onClick={()=>{setCreate(!create);setInvite("");}}>创建临时链接</button></header>
    {create&&<form className="ad-card settings-form" onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);void a.run(async()=>{
      if(!f.getAll("workspace").length)throw Error("请选择至少一个工作区。");
      const result=await api<{url:string;code:string|null}>("/api/temp-access",json("POST",{name:f.get("name"),note:f.get("note"),workspace_ids:f.getAll("workspace"),
        expires_at:new Date(Date.now()+3600000*Number(f.get("hours"))).toISOString(),permission:f.get("permission"),bind_first_ip:f.has("bind"),require_code:f.has("code"),currency:f.get("currency"),
        ...Object.fromEntries(["max_tokens","max_cost","max_turns"].filter(k=>f.get(k)).map(k=>[k,Number(f.get(k))]))}));
      setInvite(new URL(result.url,location.origin).href+(result.code?"\n提取码 "+result.code:""));setCreate(false);await load();
    });}}>
      <label>邀请名称<input name="name" required maxLength={120}/></label><label>备注<input name="note" maxLength={1000}/></label>
      <label>有效小时数<input name="hours" type="number" min="0.0167" step="any" defaultValue="1" required/></label>
      <fieldset><legend>可访问工作区</legend>{workspaces.map(w=><label key={w.id}>{w.name}<input type="checkbox" name="workspace" value={w.id}/></label>)}</fieldset>
      <label>访问权限<select name="permission">{Object.entries(permissions).map(([v,label])=><option key={v} value={v}>{label}</option>)}</select></label>
      <label>轮次上限<input name="max_turns" type="number" min="1" placeholder="不限"/></label><label>Token 上限<input name="max_tokens" type="number" min="1" placeholder="不限"/></label>
      <label>费用上限<input name="max_cost" type="number" min="0.000001" step="any" placeholder="不限"/></label><label>费用币种<select name="currency"><option>USD</option><option>CNY</option></select></label>
      <label>要求提取码<input type="checkbox" name="code" defaultChecked/></label><label>绑定首次访问 IP<input type="checkbox" name="bind"/></label>
      <button className="ad-primary" disabled={a.busy}>生成邀请</button></form>}
    {invite&&<section className="ad-card settings-form"><strong>邀请信息仅显示一次</strong><textarea aria-label="邀请文案" readOnly value={invite}/><button className="ad-button" onClick={()=>void a.run(()=>navigator.clipboard.writeText(invite),"已复制邀请")}>复制邀请文案</button><button className="ad-button" onClick={()=>setInvite("")}>收起邀请</button></section>}
    {links.map(link=><article key={link.id} className="ad-card settings-form"><header className="settings-row"><strong>{link.name}</strong><span>{statuses[link.status]}</span></header><small>{permissions[link.permission]} · {timeLabel(link.expires_at)} 到期</small><Quotas link={link}/>{link.status!=="revoked"&&<div className="ad-actions"><button className="ad-button" onClick={()=>setEditing(link)}>续期 / 加额</button><button className="ad-button ad-danger" onClick={()=>{if(window.confirm("立即断开并吊销 "+link.name+" 的所有访客？"))void a.run(async()=>{await api("/api/temp-access/"+link.id+"/revoke",json("POST",{}));await load();});}}>立即吊销</button></div>}</article>)}
    {editing&&<dialog open className="ad-card settings-dialog" aria-label="续期与加额"><h2>{editing.name} · 续期 / 加额</h2><form className="settings-form" onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);void a.run(async()=>{const patch=Object.fromEntries([...f].filter(([,v])=>Number(v)>0).map(([k,v])=>[k,Number(v)]));if(!Object.keys(patch).length)throw Error("请至少选择一项增量。");await api("/api/temp-access/"+editing.id+"/extend",json("PATCH",patch));setEditing(undefined);await load();});}}>
      <label>延长有效期<select name="hours"><option value="0">保持当前有效期</option>{[1,6,24].map(n=><option key={n} value={n}>+{n} 小时</option>)}</select></label>
      {([["turns","追加轮次"],["tokens","追加 Token"],["cost","追加费用"]] as const).map(([key,label])=><label key={key}>{label}<input name={key} type="number" min="0" step={key==="cost"?"any":"1"}/></label>)}
      <Feedback error={a.error}/><button className="ad-primary" disabled={a.busy}>保存增量</button><button type="button" className="ad-button" onClick={()=>setEditing(undefined)}>取消</button></form></dialog>}
    <section className="ad-card settings-form"><h2>活跃访客</h2>{!live.length&&<small>当前没有在线访客。</small>}{live.map((v,i)=><div key={v.id??i}><strong>{v.link.name} · {v.ip}</strong><small>{workspaces.find(w=>w.id===v.workspace_id)?.name??"正在选择工作区"} · 剩余 {remaining(v.link)}</small><Quotas link={v.link}/></div>)}</section>
    <details className="ad-card"><summary>访客操作记录</summary>{!audit.length&&<small>还没有访客记录。</small>}{audit.map(v=><p key={v.id}>{timeLabel(v.created_at)} · {v.action} · {v.ip}</p>)}</details></>;
}
