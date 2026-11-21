import {useEffect,useRef,useState} from "react";
import {createPortal} from "react-dom";
import {Share2} from "lucide-react";
import type {PublicShare} from "@codexdeck/shared";
import {api,json} from "../../lib/api";
import "./share-dialog.css";

export function ShareButton({artifactId,name}:{artifactId:string;name:string}) {
  const dialog=useRef<HTMLDialogElement>(null);
  const [access,setAccess]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const [copied,setCopied]=useState(false),[open,setOpen]=useState(false);
  useEffect(()=>{if(open)dialog.current?.showModal();},[open]);
  if(location.pathname==="/guest")return null;
  async function create(form:FormData) {
    setBusy(true);setError("");
    const passcode=String(form.get("code")||"");
    try {
      const share=await api<PublicShare & {url:string}>("/api/shares",json("POST",{
        artifact_id:artifactId,passcode:passcode||undefined,max_views:Number(form.get("views"))||null,
        expires_at:new Date(Date.now()+Number(form.get("days"))*86400000).toISOString(),allow_download:form.has("download")
      }));
      const text=new URL(share.url,location.origin).href+(passcode?"\n提取码 "+passcode:"");
      setAccess(text);
      try {await navigator.clipboard.writeText(text);setCopied(true);}catch{/* The selectable link also works without clipboard permission. */}
    }catch(e){setError(e instanceof Error?e.message:"创建分享失败。");}finally{setBusy(false);}
  }
  return <><button type="button" title="公开分享" aria-label={"公开分享 "+name} onClick={()=>{setAccess("");setError("");setCopied(false);setOpen(true);}}><Share2 size={15}/></button>
    {open&&createPortal(<dialog ref={dialog} aria-label="公开分享" className="ad-card share-dialog" onClose={()=>setOpen(false)}>
      <header><strong>公开分享</strong><button type="button" aria-label="关闭分享设置" onClick={()=>dialog.current?.close()}>×</button></header>
      <p>{name}</p>{access?<><label>分享链接与提取码<textarea readOnly value={access} onFocus={e=>e.target.select()}/></label>
        <button className="ad-primary" onClick={async()=>{try {await navigator.clipboard.writeText(access);setCopied(true);}catch{setError("请选择并复制上方链接。");}}}>{copied?"已复制 · 再次复制":"复制分享信息"}</button></>:
      <form key={artifactId} className="settings-form" onSubmit={e=>{e.preventDefault();void create(new FormData(e.currentTarget));}}>
        <label>有效天数<input name="days" type="number" min="1" max="3650" defaultValue="7" required/></label>
        <label>提取码<input name="code" type="password" autoComplete="new-password" minLength={4} maxLength={64} placeholder="留空即可直接阅读"/></label>
        <label>最多阅读次数<input name="views" type="number" min="1" max="1000000" placeholder="不限"/></label>
        <label><input name="download" type="checkbox"/> 允许原件下载</label>
        <button className="ad-primary" disabled={busy}>生成分享链接</button></form>}{error&&<p role="alert">{error}</p>}
    </dialog>,document.body)}</>;
}
