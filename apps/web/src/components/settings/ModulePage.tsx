import {useState} from "react";
import type {Thread,Workspace} from "@codexdeck/shared";
import {McpManager,PluginManager,PromptLibrary,Sessions,Skills} from "./ModuleLibrary";
import {UsageLedger} from "./UsageLedger";
import {OpenApi} from "./OpenApi";
import {GuestInvitations} from "./TemporaryAccess";
import {PublicShares} from "./PublicShares";
import {ArtifactHub} from "../files/ArtifactHub";
import {Services} from "../ops/Services";
import type {PanelTab} from "../layout/Panel";
import "./admin.css";
export type ModuleView="apps"|"mcp"|"skills"|"plugins"|"prompts"|"sessions"|"access"|"usage";
export default function ModulePage({view,workspace,workspaces,threads,jump,refresh,open}:{view:ModuleView;workspace:Workspace|null;workspaces:Workspace[];threads:Thread[];jump:(id:string)=>void;refresh:()=>void;open:(tab:PanelTab)=>void}){
  const [tab,setTab]=useState(0);
  const choices=view==="apps"?["已部署服务","成品资产箱"]:view==="access"?["Open API Key","临时访问","公开分享"]:[];
  return <section className="admin-pages"><div className="admin-inner">
    {choices.length>0&&<nav className="settings-tabs module-tabs" aria-label={view==="apps"?"应用分类":"授权类型"}>{choices.map((t,i)=><button key={t} aria-current={tab===i?"page":undefined} onClick={()=>setTab(i)}>{t}</button>)}</nav>}
    {view==="mcp"&&<McpManager/>}{view==="plugins"&&<PluginManager/>}{view==="prompts"&&<PromptLibrary/>}
    {view==="skills"&&(workspace?<Skills workspace={workspace}/>:<p>先创建工作区，再编辑项目规范。</p>)}
    {view==="sessions"&&<Sessions {...{threads,workspaces,jump,refresh}}/>}
    {view==="usage"&&<><h1>用量统计</h1><UsageLedger/></>}
    {view==="access"&&(tab===0?<OpenApi showLedger={false}/>:tab===1?<GuestInvitations workspaces={workspaces}/>:<PublicShares/>)}
    {view==="apps"&&(tab===0?<Services onDrawer={t=>open({kind:t.type,title:t.title,port:t.port,deploymentId:t.deploymentId})}/>:<ArtifactHub {...{workspaces,open,jump}}/>)}
  </div></section>;
}
