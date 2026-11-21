import {useEffect,useState} from "react";
import {workbenchPreferencesSchema,type Workspace} from "@codexdeck/shared";
import {api,json} from "../../lib/api";
import {PreferenceControls,type PreferenceProps} from "../layout/Preferences";
import {SecurityPanel} from "./SecurityPanel";
import {TemporaryAccess} from "./TemporaryAccess";
import {useAction,Feedback} from "./common";
import {System} from "./System";
import "./settings-center.css";

const tabs=["外观与工作台","安全中心","临时访问管理","自动化与审批","系统与备份"] as const;
function Backup(){
  const action=useAction();
  const [version,setVersion]=useState(""),[error,setError]=useState("");
  useEffect(()=>{void api<{version:string}>("/api/health").then(v=>setVersion(v.version)).catch(e=>setError(e.message));},[]);
  return <><section className="ad-card settings-form"><h2>在线数据库备份</h2>
    <span>{version?"服务运行正常 · "+version:error||"正在检查服务"}</span>
    <small>下载包含会话和设置的 SQLite 一致性快照。主密钥和工作区文件需在宿主机单独备份。</small>
    <a className="ad-button" href="/api/settings/backup" download="codexdeck.sqlite">下载 SQLite 备份</a></section><System section="system"/>
    <section className="ad-card settings-form"><h2>恢复面板默认设置</h2><small>重置工作台、默认审批和安全策略，清除双重验证与封禁并注销管理员设备。公网准入将关闭，请先确认可以通过 SSH 进入服务器。</small>
      <button className="ad-button" disabled={action.busy} onClick={()=>{if(window.confirm("恢复默认设置并注销当前设备？"))void action.run(async()=>{await api("/api/settings/reset",json("POST",{}));location.replace("/");});}}>恢复面板默认设置</button><Feedback {...action}/></section></>;
}
export function SettingsCenter({workspaces,...p}:PreferenceProps&{workspaces:Workspace[]}) {
  const [tab,set]=useState<(typeof tabs)[number]>("外观与工作台");
  return <section className="admin-pages"><div className="admin-inner">
    <h1>设置与安全中心</h1><nav aria-label="设置分类" className="settings-tabs">{tabs.map(t=><button key={t} type="button" aria-current={t===tab?"page":undefined} onClick={()=>set(t)}>{t}</button>)}</nav>
    {tab===tabs[0]&&<><PreferenceControls {...p}/><button className="ad-button" onClick={()=>{const {automationLevel,approvalTimeoutSeconds,...defaults}=workbenchPreferencesSchema.parse({});p.update(defaults);}}>恢复工作台默认值</button></>}
    {tab===tabs[1]&&<SecurityPanel/>}
    {tab===tabs[2]&&<TemporaryAccess workspaces={workspaces}/>}
    {tab===tabs[3]&&<><section className="ad-card settings-form"><h2>审批策略</h2><label>新工作区默认权限<select value={p.prefs.automationLevel} onChange={e=>p.update({automationLevel:e.target.value as Workspace["automation_level"]})}><option value="conservative">保守</option><option value="semi">半自动</option><option value="full">全自动</option></select></label>
      <label><span>审批等待时间（秒）<small>新发起的审批到期后自动结束。</small></span><input type="number" min={10} max={86400} key={p.prefs.approvalTimeoutSeconds} defaultValue={p.prefs.approvalTimeoutSeconds} onBlur={e=>{if(e.target.validity.valid&&e.target.value)p.update({approvalTimeoutSeconds:e.target.valueAsNumber});}}/></label>
      <button className="ad-button" onClick={()=>p.update({automationLevel:"conservative",approvalTimeoutSeconds:600})}>恢复审批默认值</button></section><System section="notifications"/></>}
    {tab===tabs[4]&&<Backup/>}</div></section>;
}
