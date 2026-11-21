import {useContext,useState} from "react";
import {ArrowDownToLine} from "lucide-react";
import type {Artifact,TurnTelemetry,WorkbenchPreferences} from "@codexdeck/shared";
import {api} from "../../lib/api";
import {AppearanceContext} from "../layout/AppearanceContext";
import {SegmentedControl} from "../settings/Controls";
import {ArtifactChip,download} from "../files/Artifacts";
import type {DrawerTab} from "../files/DrawerContent";

export function ArtifactModeControl() {
  const {prefs,update}=useContext(AppearanceContext);
  return <SegmentedControl aria-label="底部文件栏" value={prefs.artifactMode} onValueChange={v=>update({artifactMode:v as WorkbenchPreferences["artifactMode"]})}>
    <option value="smart">智能交付物</option><option value="all">全部文件</option><option value="off">关闭文件栏</option>
  </SegmentedControl>;
}
export function matchesExtension(name:string,extensions:readonly string[]) {
  return extensions.some(ext=>name.toLowerCase().endsWith(ext));
}
export function Telemetry({value}:{value:TurnTelemetry}) {
  const tokens=value.input_tokens!==null&&value.output_tokens!==null?value.input_tokens+value.output_tokens:null;
  const tokenLabel=tokens===null?"":Intl.NumberFormat("en",{notation:"compact",maximumFractionDigits:1}).format(tokens).toLowerCase();
  return <section className="cd-telemetry" aria-label="本轮遥测">
    {value.model&&<span>{value.model}</span>}
    {value.tokens_per_sec!=null&&<span>{value.tokens_per_sec.toFixed(1)} tok/s</span>}
    {value.cache_hit_rate!=null&&<span>缓存 {(value.cache_hit_rate*100).toFixed(1)}%</span>}
    {tokens!==null&&<span tabIndex={0} title={tokens.toLocaleString("en-US")+" Token"}>{tokenLabel} Token</span>}
    {!!value.cost_usd&&<span>${value.cost_usd.toLocaleString("en",{maximumFractionDigits:6})}</span>}
    {!!value.cost_cny&&<span>¥{value.cost_cny.toLocaleString("zh-CN",{maximumFractionDigits:6})}</span>}
  </section>;
}
interface Props {
  files:Artifact[];value:TurnTelemetry|null;onOpen:(tab:DrawerTab)=>void;onError:(message:string)=>void;turnId?:string;diffStepId?:string|null;
}
export function TurnFiles({files,value,onOpen,onError,turnId,diffStepId}:Props) {
  const {prefs}=useContext(AppearanceContext);
  const [diff,setDiff]=useState<string|null>(null),[busy,setBusy]=useState(false);
  const output=files.filter(f=>f.change_type!=="upload");
  const changes=new Map((value?.files??[]).map(f=>[f.path,f]));
  for(const file of output) if(!changes.has(file.path))changes.set(file.path,{path:file.path,added:null,removed:null});
  const visible=output.filter(f=>prefs.artifactMode==="all" || prefs.artifactMode==="smart" && matchesExtension(f.name,prefs.artifactExtensions));
  const counted=[...changes.values()].filter(f=>f.added!==null && f.removed!==null);
  const totals=counted.reduce((n,f)=>[n[0]+(f.added??0),n[1]+(f.removed??0)],[0,0]);
  async function reveal() {
    if(!turnId || !diffStepId || busy || diff!==null || value?.diff)return;
    setBusy(true);
    try {const result=await api<{detail:string}>("/api/turns/"+encodeURIComponent(turnId)+"/steps/"+encodeURIComponent(diffStepId));setDiff(result.detail);}
    catch(e){onError(e instanceof Error?e.message:"读取差异失败");}
    finally{setBusy(false);}
  }
  return <>{changes.size>0&&<details className="cd-turn-changes" onToggle={e=>{if(e.currentTarget.open)void reveal();}}>
    <summary>本轮改动 {changes.size} 个文件{counted.length>0&&` · +${totals[0]} −${totals[1]}`}</summary>
    {[...changes.values()].map(f=>{const a=output.find(v=>v.path===f.path);return <div className="cd-change-row" key={f.path}><code>{f.path}</code>
      {f.added!==null&&<small>+{f.added} −{f.removed}</small>}{a&&<button aria-label={"下载变更 "+a.name} onClick={()=>void download({artifact_id:a.id}).catch(()=>onError("下载链接生成失败"))}><ArrowDownToLine size={14}/></button>}</div>;})}
    {busy&&<small>正在读取差异…</small>}{(diff||value?.diff)&&<pre>{diff||value?.diff}</pre>}
  </details>}{visible.length>0&&<div className="cd-artifacts">{visible.map(item=><ArtifactChip key={item.id} item={item} screenshots={output.filter(f=>f.change_type==="screenshot")} onOpen={onOpen} onError={onError}/>)}</div>}</>;
}
