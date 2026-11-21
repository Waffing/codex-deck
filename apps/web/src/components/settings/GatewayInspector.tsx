import {useEffect,useRef,useState} from "react";
import {Copy,RefreshCw,Repeat2,X} from "lucide-react";
import type {ApiKey,Model,Provider,RoutingProfile} from "@codexdeck/shared";
import {api,json} from "../../lib/api";
import {Feedback,timeLabel,useAction} from "./common";
import {ToggleSwitch} from "./Controls";

type Log={id:string;request_id:string;created_at:string;inbound_protocol:string;outbound_protocol:string|null;virtual_model:string;actual_model:string|null;source_type:string;provider_id:string|null;
  status_code:number;error_summary:string|null;ttft_ms:number|null;tokens_per_sec:number|null;total_ms:number|null;input_tokens:number;cached_tokens:number|null;
  cost_estimate:number;currency:string|null;failover_chain:unknown[];has_debug:boolean;debug_payload?:unknown};
const wireNames:Record<string,string>={openai_responses:"Responses",openai_chat:"Chat",anthropic_messages:"Anthropic",gemini_openai:"Gemini",messages:"Anthropic",responses:"Responses",chat:"Chat"};
export function GatewayInspector({providers}:{providers:Provider[]}){
  const [logs,setLogs]=useState<Log[]>([]),[total,setTotal]=useState(0),[offset,setOffset]=useState(0),[provider,setProvider]=useState(""),[protocol,setProtocol]=useState(""),[status,setStatus]=useState("");
  const [detail,setDetail]=useState<Log|null>(null),[target,setTarget]=useState(""),[version,setVersion]=useState(0),[debug,setDebug]=useState({enabled:false,expires_at:null as string|null});
  const a=useAction();
  useEffect(()=>{
    let alive=true,loading=false;
    const read=async()=>{
      if(loading || !alive)return;loading=true;
      const query=new URLSearchParams({limit:"40",offset:String(offset)});if(provider)query.set("provider_id",provider);
      if(protocol)query.set("inbound_protocol",protocol);if(status)query.set("status_code",status);
      try{
        const [rows,options]=await Promise.all([api<{items:Log[];total:number}>("/api/gateway/logs?"+query),api<typeof debug>("/api/gateway/debug")]);
        if(alive){setLogs(rows.items);setTotal(rows.total);setDebug(options);}
      }catch(e){if(alive)a.setError(e instanceof Error?e.message:"读取日志失败");}
      finally{loading=false;}
    };
    void read();const timer=window.setInterval(()=>{if(document.visibilityState==="visible")void read()},5000);
    return ()=>{alive=false;clearInterval(timer)};
  },[offset,provider,protocol,status,version]);
  const dialog=useRef<HTMLDialogElement>(null);
  useEffect(()=>{if(detail&&!dialog.current?.open)dialog.current?.showModal()},[detail]);
  return <section><div className="ad-subhead"><h2>请求记录</h2><button className="ad-button" onClick={()=>setVersion(v=>v+1)}><RefreshCw size={14}/>刷新</button></div>
    <div className="gw-filters"><label className="ad-check"><ToggleSwitch checked={debug.enabled} onCheckedChange={enabled=>void a.run(async()=>{setDebug(await api("/api/gateway/debug",json("PATCH",{enabled,ttl_minutes:15})))})}/>脱敏抓包</label>
      <small>{debug.expires_at?timeLabel(debug.expires_at)+" 自动关闭":"开启后仅记录接下来 15 分钟"}</small>
      <select aria-label="按厂商筛选" value={provider} onChange={e=>{setProvider(e.target.value);setOffset(0)}}><option value="">全部厂商</option>{providers.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select>
      <select aria-label="按入站协议筛选" value={protocol} onChange={e=>{setProtocol(e.target.value);setOffset(0)}}><option value="">全部入站协议</option>{["responses","chat","messages"].map(v=><option key={v} value={v}>{wireNames[v]}</option>)}</select>
      <select aria-label="按状态筛选" value={status} onChange={e=>{setStatus(e.target.value);setOffset(0)}}><option value="">全部状态</option>{[200,400,401,403,404,429,499,500,502,503,504].map(v=><option key={v}>{v}</option>)}</select>
    </div><Feedback error={a.error} notice={a.notice}/>
    {logs.length?<div className="ad-table-wrap"><table className="ad-table"><thead><tr>{["时间与请求","模型与协议","切流","延迟 / 速率","缓存占比","费用","状态"].map(t=><th key={t}>{t}</th>)}</tr></thead><tbody>
      {logs.map(l=><tr key={l.id}><td><button className="ad-button" onClick={()=>void a.run(async()=>{setTarget("");setDetail(await api("/api/gateway/logs/"+l.id))})}>{timeLabel(l.created_at)}</button></td>
        <td><b>{l.virtual_model}</b> <small>{wireNames[l.inbound_protocol]??l.inbound_protocol} → {wireNames[l.outbound_protocol??""]??"—"}</small></td>
        <td>{Math.max(0,l.failover_chain.length-1)}</td><td>{l.ttft_ms==null?"—":Math.round(l.ttft_ms)+" ms"} / {l.tokens_per_sec==null?"—":l.tokens_per_sec.toFixed(1)+" tok/s"}</td>
        <td>{l.cached_tokens!=null && l.input_tokens>0?Math.round(100*l.cached_tokens/l.input_tokens)+"%":"—"}</td>
        <td>{l.currency?l.currency+" "+l.cost_estimate.toFixed(5):"—"}</td><td>{l.status_code}</td></tr>)}</tbody></table></div>:<p>暂无匹配的网关请求。</p>}
    {total>40&&<div className="ad-actions"><button disabled={!offset} onClick={()=>setOffset(n=>Math.max(0,n-40))}>上一页</button><span>{offset+1}–{Math.min(offset+40,total)} / {total}</span><button disabled={offset+40>=total} onClick={()=>setOffset(n=>n+40)}>下一页</button></div>}
    {detail&&<dialog className="gw-drawer" ref={dialog} onCancel={()=>setDetail(null)} aria-label="请求详情"><div className="ad-labelrow"><h2>请求详情</h2><button className="ad-button" aria-label="关闭详情" onClick={()=>setDetail(null)}><X size={16}/></button></div>
      <code>{detail.request_id}</code><dl><dt>实际模型</dt><dd>{detail.actual_model??"—"}</dd><dt>总耗时</dt><dd>{detail.total_ms??"—"} ms</dd><dt>切流轨迹</dt><dd><pre>{JSON.stringify(detail.failover_chain,null,2)}</pre></dd></dl>
      {detail.error_summary&&<p role="alert">{detail.error_summary}</p>}
      {detail.has_debug?<pre className="ad-code">{JSON.stringify(detail.debug_payload,null,2)}</pre>:<p>此请求未开启脱敏抓包。</p>}
      <label>探针目标<select value={target} onChange={e=>setTarget(e.target.value)}><option value="">当前路由</option>{providers.filter(p=>p.enabled).map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <button className="ad-primary" onClick={()=>void a.run(async()=>{const r=await api<{status_code:number}>("/api/gateway/logs/"+detail.id+"/replay",json("POST",{provider_id:target||undefined}));setVersion(n=>n+1);if(r.status_code>=400)throw new Error("探针返回 HTTP "+r.status_code)},"探针已通过")}><Repeat2 size={14}/>重放测试</button>
      <Feedback error={a.error} notice={a.notice}/></dialog>}</section>;
}
type Quota={id:string;name:string;rpm:number;rpm_limit:number;tpm:number;tpm_limit?:number;daily_budget:number;monthly_budget:number;usage:{currency:string;daily_used:number;monthly_used:number}[]};
export function GatewayClients({models,routes}:{models:Model[];routes:RoutingProfile[]}) {
  const [keys,setKeys]=useState<ApiKey[]>([]),[key,setKey]=useState(""),[model,setModel]=useState(""),[client,setClient]=useState("codex"),[snippets,setSnippets]=useState<Record<string,string>|null>(null);
  const [metrics,setMetrics]=useState<{keys:Quota[];providers:Quota[]}>({keys:[],providers:[]}),a=useAction();
  useEffect(()=>{
    let active=true,pending=false;
    const load=async()=>{
      if(pending)return;pending=true;
      try{
        const [k,q]=await Promise.all([api<ApiKey[]>("/api/api-keys"),api<typeof metrics>("/api/gateway/quotas")]);
        if(active){setKeys(k.filter(v=>!v.revoked_at && v.scopes.some(s=>s.startsWith("proxy:"))));setMetrics(q);}
      }catch(e){if(active)a.setError(e instanceof Error?e.message:"读取配额失败");}finally{pending=false;}
    };
    void load();const timer=window.setInterval(()=>{if(document.visibilityState==="visible")void load()},5000);
    return ()=>{active=false;clearInterval(timer)};
  },[]);
  const selected=keys.find(k=>k.id===key),allow=selected?.allowed_models??["*"];
  const options=[...models.filter(m=>m.enabled).map(m=>m.alias),...routes.filter(r=>r.enabled).map(r=>r.slug)].filter(m=>allow.includes("*")||allow.includes(m));
  const alias=options.includes(model)?model:options[0];
  return <section><div className="ad-form-panel ad-form"><h2>客户端接入</h2><div className="ad-form-grid">
    <label>访问密钥<select aria-label="访问密钥" value={key} onChange={e=>{setKey(e.target.value);setSnippets(null)}}><option value="">使用环境变量</option>{keys.map(k=><option key={k.id} value={k.id}>{k.name}</option>)}</select></label>
    <label>接入模型<select aria-label="接入模型" value={alias??""} onChange={e=>{setModel(e.target.value);setSnippets(null)}}>{options.map(m=><option key={m}>{m}</option>)}</select></label>
    <label>客户端<select aria-label="客户端" value={client} onChange={e=>setClient(e.target.value)}>{Object.entries({codex:"Codex CLI",claude:"Claude Code",openai:"OpenAI SDK",cursor:"Cursor"}).map(([v,t])=><option key={v} value={v}>{t}</option>)}</select></label></div>
    <button className="ad-primary" disabled={!alias} onClick={()=>void a.run(async()=>{const q=new URLSearchParams({model:alias});if(key)q.set("api_key_id",key);setSnippets(await api("/api/gateway/client-snippets?"+q))})}>生成接入配置</button>
    {snippets&&<><pre className="ad-code">{snippets[client]}</pre><button className="ad-button" onClick={()=>void a.run(()=>navigator.clipboard.writeText(snippets[client]),"已复制接入配置")}><Copy size={14}/>复制配置</button></>}<Feedback error={a.error} notice={a.notice}/></div>
    <h2>实时配额</h2><div className="ad-grid">{[...metrics.providers,...metrics.keys].map(v=><article key={v.id} className="ad-card"><b>{v.name}</b>
      {([["RPM",v.rpm,v.rpm_limit],["TPM",v.tpm,v.tpm_limit??0]] as const).map(([label,used,max])=><label className="gw-meter" key={label}><small>{label} · {used} / {max||"不限"}</small>{max>0&&<progress max={max} value={Math.min(used,max)}/>}</label>)}
      {v.usage.length?v.usage.map(u=><div key={u.currency}>{([["日",u.daily_used,v.daily_budget],["月",u.monthly_used,v.monthly_budget]] as const).map(([period,used,max])=><label className="gw-meter" key={period}><small>{period} · {u.currency} {used.toFixed(4)} / {max||"不限"}</small>{max>0&&<progress max={max} value={Math.min(used,max)}/>}</label>)}</div>):<small>日 / 月预算 · {v.daily_budget||"不限"} / {v.monthly_budget||"不限"}</small>}</article>)}</div></section>;
}
