import {useState} from "react";
import {ChevronUp,ChevronDown,GitBranch,Plus,Radio,RotateCcw,X} from "lucide-react";
import type {Model,RoutingProfile} from "@codexdeck/shared";
import {api,json} from "../../lib/api";
import {Feedback,useAction} from "./common";
import {ToggleSwitch} from "./Controls";

type Props={routes:RoutingProfile[];models:Model[];changed:()=>Promise<void>};
const strategyNames={pinned:"手动锁定",priority_failover:"主备切换",weighted_rr:"权重轮询",lowest_latency:"最低延迟"};
const brands:Record<string,string>={anthropic:"#ac735c",openai_official:"#4b8a77",deepseek:"#477bdd",siliconflow:"#695aca",gemini:"#896dcc",ollama:"#62696b",openrouter:"#55768b",kimi:"#688ab7",dashscope:"#c17c40",volcengine:"#6779a7",groq:"#b06b5c"};
export function ProviderSymbol({preset,name}:{preset:string;name:string}) {
  return <span className="gw-symbol" style={{background:brands[preset]??"#547a81"}} aria-hidden>{name.slice(0,1).toUpperCase()}</span>;
}
export function HealthDots({health,reset}:{health?:{states:number[];availability:number|null;circuit:{state:string}};reset:()=>void}) {
  const samples=health?.states??[];
  return <div className="gw-health"><div className="gw-health-dots" aria-label="最近 20 次请求">{Array.from({length:20},(_,i)=>{
    const status=samples[i-20+samples.length];return <span key={i} title={status?"HTTP "+status:"暂无样本"} data-state={status?status>=200&&status<300?"ok":"bad":"empty"}/>;
  })}</div><small>{health?.availability!=null?Math.round(100*health.availability)+"% 可用":"暂无样本"} · {health?.circuit.state==="open"?"熔断":health?.circuit.state==="half_open"?"探活中":"正常"}</small>
    <button className="ad-button" aria-label="复位熔断器" onClick={reset}><RotateCcw size={13}/></button></div>;
}
export function GlobalSwitch({routes,models,changed,configure}:Props&{configure:()=>void}){
  const route=routes.find(r=>r.enabled && r.is_global_default),a=useAction();
  return <section className="gw-switch"><div className="ad-labelrow"><h2><Radio size={17}/>全局主力渠道</h2>{route&&<code>{route.slug}</code>}</div>
    <div className="ad-actions">{route?route.targets.map((t,i)=>{
      const model=models.find(m=>m.id===t.model_id);
      return <button key={t.model_id} aria-pressed={route.strategy==="pinned" && route.active_target_index===i} disabled={!model?.enabled||a.busy}
        onClick={()=>void a.run(async()=>{await api("/api/routing-profiles/"+route.id+"/switch",json("POST",{strategy:"pinned",active_target_index:i}));await changed()},"已切换主力渠道")}>{model?.alias??"模型已移除"}</button>;
    }):<button className="ad-button" onClick={configure}><GitBranch size={14}/>配置全局路由</button>}</div><Feedback error={a.error} notice={a.notice}/></section>;
}
type Draft=Pick<RoutingProfile,"name"|"description"|"slug"|"strategy"|"targets"|"active_target_index"|"is_global_default"|"enabled">;
const blank:Draft={name:"",description:"",slug:"",strategy:"pinned",targets:[],active_target_index:0,is_global_default:false,enabled:true};
export function GatewayRouting({routes,models,changed}:Props) {
  const [draft,setDraft]=useState<Draft|null>(null),[id,setId]=useState(""),[removing,setRemoving]=useState(""),a=useAction();
  const modelName=(mid:string)=>models.find(m=>m.id===mid)?.alias??mid;
  function targets(next:Draft["targets"]){
    if(!draft)return;
    const selected=draft.targets[draft.active_target_index]?.model_id;
    setDraft({...draft,targets:next,active_target_index:Math.max(0,next.findIndex(t=>t.model_id===selected))});
  }
  function move(i:number,delta:number){
    if(!draft)return;const next=[...draft.targets];const to=i+delta;
    if(to<0||to>=next.length)return;
    [next[i],next[to]]=[next[to],next[i]];targets(next);
  }
  return <section className="gw-routes"><div className="ad-subhead"><h2>虚拟路由组</h2><button className="ad-button" onClick={()=>{setId("");setDraft({...blank,is_global_default:!routes.length})}}><Plus size={14}/>新建路由组</button></div>
    <Feedback error={a.error} notice={a.notice}/>
    {draft&&<form className="ad-form-panel ad-form" onSubmit={e=>{e.preventDefault();void a.run(async()=>{
      await api("/api/routing-profiles"+(id?"/"+id:""),json(id?"PATCH":"POST",draft));setDraft(null);await changed();
    },"路由组已保存")}}>
      <div className="ad-labelrow"><strong>{id?"编辑路由组":"新建路由组"}</strong><button type="button" className="ad-button" aria-label="关闭路由编辑" onClick={()=>setDraft(null)}><X size={14}/></button></div>
      <div className="ad-form-grid"><label>路由名称<input required value={draft.name} onChange={e=>setDraft({...draft,name:e.target.value})}/></label>
      <label>虚拟模型别名<input required placeholder="codex-main" minLength={1} maxLength={120} value={draft.slug} onChange={e=>setDraft({...draft,slug:e.target.value})}/></label>
      <label>策略<select value={draft.strategy} onChange={e=>setDraft({...draft,strategy:e.target.value as Draft["strategy"]})}>{Object.entries(strategyNames).map(([v,t])=><option key={v} value={v}>{t}</option>)}</select></label>
      <label>添加目标模型<select value="" onChange={e=>{if(e.target.value)targets([...draft.targets,{model_id:e.target.value}])}}><option value="">选择模型…</option>
        {models.filter(m=>m.enabled&&!draft.targets.some(t=>t.model_id===m.id)).map(m=><option key={m.id} value={m.id}>{m.alias}</option>)}</select></label></div>
      <ol className="gw-chain">{draft.targets.map((t,i)=><li key={t.model_id}><b>{modelName(t.model_id)}</b>
        {draft.strategy==="weighted_rr"&&<label>权重<input type="number" min="1" max="1000" placeholder="厂商权重" value={t.weight??""} onChange={e=>targets(draft.targets.map((item,j)=>i===j?{...item,weight:e.target.value?Number(e.target.value):undefined}:item))}/></label>}
        {draft.strategy==="pinned"&&<label><input type="radio" checked={draft.active_target_index===i} onChange={()=>setDraft({...draft,active_target_index:i})}/>锁定</label>}
        <button type="button" className="ad-button" disabled={!i} aria-label="上移目标" onClick={()=>move(i,-1)}><ChevronUp size={14}/></button>
        <button type="button" className="ad-button" disabled={i===draft.targets.length-1} aria-label="下移目标" onClick={()=>move(i,1)}><ChevronDown size={14}/></button>
        <button type="button" className="ad-button" aria-label="移除目标" onClick={()=>targets(draft.targets.filter((_,j)=>j!==i))}><X size={14}/></button></li>)}</ol>
      <label className="ad-check"><ToggleSwitch checked={draft.is_global_default} onCheckedChange={v=>setDraft({...draft,is_global_default:v})}/>全局默认</label>
      <button className="ad-primary" disabled={!draft.targets.length||a.busy}>保存路由组</button></form>}
    {routes.map(r=><article className="ad-card" key={r.id}><div className="ad-labelrow"><div><b>{r.name}</b> <code>{r.slug}</code></div><span className="ad-pill">{strategyNames[r.strategy]}</span></div>
      <p>{r.targets.map(t=>modelName(t.model_id)).join(" → ")}</p><div className="ad-actions">
        <button className="ad-button" onClick={()=>{setId(r.id);setDraft(r)}}>编辑路由组</button>
        {!r.is_global_default&&<button className="ad-button" onClick={()=>void a.run(async()=>{await api("/api/routing-profiles/"+r.id+"/switch",json("POST",{is_global_default:true}));await changed()})}>设为全局主力</button>}
        <button className="ad-button ad-danger" onClick={()=>setRemoving(r.id)}>删除路由组</button>
        {removing===r.id&&<><button className="ad-button ad-danger" onClick={()=>void a.run(async()=>{await api("/api/routing-profiles/"+r.id,json("DELETE"));setRemoving("");await changed()})}>确认删除路由组</button>
        <button className="ad-button" onClick={()=>setRemoving("")}>取消</button></>}
      </div></article>)}</section>;
}
