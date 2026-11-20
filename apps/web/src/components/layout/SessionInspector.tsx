import type { ChatTurn } from "../chat/Timeline";
import type { PanelTab } from "./Panel";
import { Files,PanelRightClose } from "lucide-react";

export function SessionInspector({turn,close,open}:{turn?:ChatTurn;close:()=>void;open:(tab:PanelTab)=>void}) {
  const stats=turn?.projection.telemetry;
  const agents=turn?.projection.items.filter(item=>item.kind==="subagent_status")??[];
  const reads=turn?.projection.items.filter(item=>item.kind==="tool_group"&&item.text==="读取文件").flatMap(item=>item.operations??[])??[];
  return <aside className="workspace-summary" aria-label="会话信息"><div className="ad-labelrow"><h2>会话信息</h2><button className="deck-icon" onClick={close} aria-label="收起会话信息"><PanelRightClose size={15}/></button></div>
    <h3>本轮变更</h3>
    {stats?.files.length?<details><summary>{stats.files.length} 个文件 · +{stats.files.reduce((n,f)=>n+(f.added??0),0)} −{stats.files.reduce((n,f)=>n+(f.removed??0),0)}</summary>
      {stats.files.map(f=><p className="summary-file" key={f.path}>{f.path} <small>{f.added===null?"二进制":`+${f.added} −${f.removed}`}</small></p>)}
      <pre>{stats.diff}</pre></details>:<small>{turn?.finished?"本轮暂无已记录的变更":"等待本轮完成"}</small>}
    <h3>子任务</h3>{agents.length?agents.map(item=><div className="summary-file" key={item.id}>{item.text}</div>):<small>本轮暂无子任务</small>}
    <h3>来源与产物</h3>{reads.map(op=><details key={op.id}><summary>{op.detail.split("\n")[0]||op.label}</summary><pre>{op.detail}</pre></details>)}
    {turn?.files.map(f=><button className="summary-file" key={f.id} onClick={()=>open({kind:f.mime_type?.startsWith("image/")?"image":"file",title:f.name,path:f.path,artifact:f})}><Files size={12}/> {f.path}</button>)}
    {!reads.length&&!turn?.files.length&&<small>暂无文件</small>}
  </aside>;
}
