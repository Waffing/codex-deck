import {useEffect, useState, type FormEvent} from "react";
import {LockKeyhole, ShieldCheck} from "lucide-react";
import type {Model, VerifyGateConfig, WorkspaceSecret} from "@codexdeck/shared";
import {api, json} from "../../lib/api";
import {ToggleSwitch} from "./Controls";

export function WorkspaceQuality({workspaceId, models}:{workspaceId:string;models:Model[]}) {
  const [tab,setTab]=useState<"quality"|"vault">("quality");
  return <section className="quality-panel">
    <nav aria-label="工作区设置" className="quality-tabs">
      <button aria-pressed={tab==="quality"} onClick={()=>setTab("quality")}><ShieldCheck size={15}/>质检门禁</button>
      <button aria-pressed={tab==="vault"} onClick={()=>setTab("vault")}><LockKeyhole size={15}/>环境变量保险箱</button>
    </nav>
    {tab==="quality"?<GateForm base={"/api/workspaces/"+workspaceId} models={models}/>:<Vault base={"/api/workspaces/"+workspaceId+"/secrets"}/>}
  </section>;
}

function GateForm({base,models}:{base:string;models:Model[]}) {
  const [config,setConfig]=useState<VerifyGateConfig>(),[commands,setCommands]=useState("");
  const [busy,setBusy]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState("");
  useEffect(()=>{
    const abort=new AbortController();
    api<VerifyGateConfig>(base+"/quality",{signal:abort.signal}).then(c=>{setConfig(c);setCommands(c.verify_commands.join("\n"));})
      .catch(e=>{if(!abort.signal.aborted)setError(e.message);});return ()=>abort.abort();
  },[base]);
  async function detect(){
    setBusy(true);setNotice("");setError("");
    try{const res=await api<{commands:string[]}>(base+"/verify-commands/detect",json("POST",{}));setCommands(res.commands.join("\n"));setNotice(res.commands.length?"已识别命令，请检查后保存。":"未识别到质检命令，可手动填写。");}
    catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  async function save(e:FormEvent){
    e.preventDefault();setBusy(true);setError("");setNotice("");
    try{await api(base+"/quality",json("PATCH",{...config,verify_commands:commands.split("\n").map(s=>s.trim()).filter(Boolean)}));setNotice("质检设置已保存");}
    catch(err){setError((err as Error).message);}finally{setBusy(false);}
  }
  return <>{config&&<form onSubmit={save} className="quality-form">
    <label className="quality-toggle">改动后自动质检<ToggleSwitch aria-label="自动质检" checked={config.auto_verify_enabled} onCheckedChange={v=>setConfig({...config,auto_verify_enabled:v})}/></label>
    <label className="quality-toggle">允许质检联网<ToggleSwitch aria-label="允许质检联网" checked={config.verify_network_enabled} onCheckedChange={v=>setConfig({...config,verify_network_enabled:v})}/></label>
    <label>质检命令，每行一条<textarea rows={4} value={commands} onChange={e=>setCommands(e.target.value)} spellCheck={false}/></label>
    <button type="button" className="btn-outline" disabled={busy} onClick={()=>void detect()}>自动识别命令</button>
    <label>最多自动修复 {config.max_self_heal_retries} 次<input aria-label="自愈次数" type="range" min="0" max="5" value={config.max_self_heal_retries} onChange={e=>setConfig({...config,max_self_heal_retries:Number(e.target.value)})}/></label>
    <label>默认复审模型<select value={config.review_model_alias??""} onChange={e=>setConfig({...config,review_model_alias:e.target.value||null})}>
      <option value="">每次选择</option>{models.filter(m=>m.enabled).map(m=><option key={m.id} value={m.alias}>{m.alias}</option>)}
    </select></label>
    <button className="btn-primary" disabled={busy}>保存质检设置</button>
  </form>}{error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}</>;
}

function Vault({base}:{base:string}){
  const [secrets,setSecrets]=useState<WorkspaceSecret[]>([]),[mode,setMode]=useState<"add"|"import"|WorkspaceSecret|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState("");
  useEffect(()=>{
    const abort=new AbortController();
    api<WorkspaceSecret[]>(base,{signal:abort.signal}).then(setSecrets).catch(e=>{if(!abort.signal.aborted)setError(e.message);});return ()=>abort.abort();
  },[base]);
  const selected=mode&&typeof mode==="object"?mode:null;
  async function submit(e:FormEvent<HTMLFormElement>){
    e.preventDefault();
    const form=e.currentTarget,fields=new FormData(form);
    const flags={inject_on_verify:fields.has("verify"),inject_on_deploy:fields.has("deploy")};
    setBusy(true);setError("");setNotice("");
    try{
      if(mode==="import"){
        const result=await api<{imported:number}>(base+"/import",json("POST",{text:fields.get("env"),...flags}));
        setNotice("已导入 "+result.imported+" 项密钥");
      }else{
        const value=fields.get("value");
        await api(base+(selected?"/"+selected.id:""),json(selected?"PATCH":"POST",{
          key_name:fields.get("key"),description:fields.get("description"),...(value?{value}:{}),...flags
        }));setNotice("密钥设置已保存");
      }
      form.reset();setMode(null);setSecrets(await api<WorkspaceSecret[]>(base));
    }catch(err){setError((err as Error).message);}finally{setBusy(false);}
  }
  async function remove(secret:WorkspaceSecret){
    if(!window.confirm("删除密钥 "+secret.key_name+"？"))return;
    setBusy(true);setError("");
    try{await api(base+"/"+secret.id,{method:"DELETE"});setSecrets(rows=>rows.filter(s=>s.id!==secret.id));if(selected?.id===secret.id)setMode(null);setNotice("密钥已删除");}
    catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  return <div className="quality-vault"><div className="quality-actions">
    <button className="btn-outline" disabled={busy} onClick={()=>setMode("add")}>添加密钥</button>
    <button className="btn-outline" disabled={busy} onClick={()=>setMode("import")}>导入 .env</button>
  </div>
  {mode&&<form key={selected?.id??String(mode)} autoComplete="off" className="quality-form" onSubmit={submit}>
    {mode==="import"?<label>.env 内容<textarea name="env" required rows={4} spellCheck={false} className="vault-entry" autoComplete="off"/></label>:<>
      <label>键名<input name="key" defaultValue={selected?.key_name} required pattern="[A-Za-z_][A-Za-z0-9_]*" spellCheck={false}/></label>
      <label>{selected?"替换密钥值（留空保留）":"密钥值"}<input name="value" type="password" autoComplete="new-password" required={!selected}/></label>
      <label>说明<input name="description" defaultValue={selected?.description??""}/></label>
    </>}
    <label className="quality-toggle">质检注入<ToggleSwitch name="verify" aria-label="质检注入" defaultChecked={selected?.inject_on_verify??false}/></label>
    <label className="quality-toggle">部署注入<ToggleSwitch name="deploy" aria-label="部署注入" defaultChecked={selected?.inject_on_deploy??false}/></label>
    <div className="quality-actions"><button disabled={busy} className="btn-primary">{mode==="import"?"导入密钥":"保存密钥"}</button>
    <button type="button" disabled={busy} onClick={()=>setMode(null)}>取消</button></div>
  </form>}
  {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  <ul>{secrets.map(s=><li key={s.id}><strong>{s.key_name}</strong><code>{s.masked_value}</code><small>{[s.inject_on_verify&&"质检",s.inject_on_deploy&&"部署"].filter(Boolean).join(" · ")||"仅保存"}</small>
    {s.description&&<p>{s.description}</p>}<div className="quality-actions"><button disabled={busy} aria-label={"编辑 "+s.key_name} onClick={()=>setMode(s)}>编辑</button><button disabled={busy} aria-label={"删除 "+s.key_name} onClick={()=>void remove(s)}>删除</button></div></li>)}</ul>
  {!secrets.length&&!mode&&<p>项目尚未配置环境变量。</p>}</div>;
}
