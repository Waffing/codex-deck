import {SegmentedControl,NumberControl} from "./Controls";
import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import type { AnalyticsQuery, AnalyticsReport, BudgetAlert, UsageBudget } from "@codexdeck/shared";
import { api,json } from "../../lib/api";
import { Feedback, useAction } from "./common";

const limitNames = {daily_usd:"每日 USD",monthly_usd:"每月 USD",daily_cny:"每日 CNY",monthly_cny:"每月 CNY"};
const format = (n:number|null, digits=2) => n===null?"—":n.toLocaleString("zh-CN",{maximumFractionDigits:digits});
const ratio = (n:number|null) => n===null?"—":format(n*100,1)+"%";
const cost = (r:AnalyticsReport["totals"]) => "$"+format(r.cost_usd,8)+" / ¥"+format(r.cost_cny,8);

function Trend({data}:{data:AnalyticsReport["trend"]}) {
  const [metric,setMetric] = useState<"tokens"|"cost_usd"|"cost_cny">("tokens");
  const points=data.slice(-30).map(r=>({date:r.label,value:metric==="tokens"?r.input_tokens+r.output_tokens:r[metric]}));
  if(!points.length)return <p className="ad-detail">网关完成请求后，这里显示用量趋势。</p>;
  const max=Math.max(...points.map(p=>p.value),0);
  return <figure className="usage-trend"><div className="ad-labelrow"><figcaption>用量趋势 <small>UTC · 最近 {points.length} 个有记录的周期</small></figcaption>
    <SegmentedControl aria-label="趋势指标" value={metric} onValueChange={next=>setMetric(next as typeof metric)}>
      <option value="tokens">Token</option><option value="cost_usd">USD</option><option value="cost_cny">CNY</option></SegmentedControl></div>
    <div className="usage-bars" aria-label="历史趋势图">{points.map(p=><div key={p.date} tabIndex={0} title={`${p.date} · ${format(p.value,8)} ${metric}`}
      aria-label={`${p.date} ${p.value}`} style={{height:`${max?p.value/max*100:0}%`}}/>)}</div>
    <div className="ad-labelrow"><small>{points[0].date}</small><small>{points.at(-1)?.date}</small></div></figure>;
}

export function UsageLedger() {
  const [period,setPeriod]=useState<AnalyticsQuery["period"]>("day");
  const [group,setGroup]=useState<AnalyticsQuery["group_by"]>("period");
  const [data,setData]=useState<AnalyticsReport|null>(null);
  const [budget,setBudget]=useState<UsageBudget|null>(null);
  const [alerts,setAlerts]=useState<BudgetAlert[]>([]);
  const a=useAction();
  const query=new URLSearchParams({period,group_by:group}).toString();
  useEffect(()=>{let alive=true;
    void api<AnalyticsReport>("/api/usage/analytics?"+query).then(r=>{if(alive)setData(r)}).catch(e=>{if(alive)a.setError(String(e))});
    return ()=>{alive=false};
  },[query]);
  async function loadBudget() {
    const r=await api<{budget:UsageBudget;alerts:BudgetAlert[]}>("/api/usage/budget");setBudget(r.budget);setAlerts(r.alerts);
  }
  useEffect(()=>{void loadBudget().catch(e=>a.setError(String(e)))},[]);
  return <section aria-label="用量账本">
    <div className="ad-subhead"><h2>用量账本</h2><a className="ad-button" download href={"/api/usage/export.csv?"+query}><Download size={14}/>导出 CSV</a></div>
    <div className="ad-actions"><div className="ad-segments" aria-label="统计周期">{([["day","日"],["week","周"],["month","月"]] as const).map(([v,t])=>
      <button key={v} data-on={v===period} aria-pressed={v===period} onClick={()=>setPeriod(v)}>按{t}</button>)}</div>
      <select aria-label="账本分组" value={group} onChange={e=>setGroup(e.target.value as typeof group)}>
        {Object.entries({period:"时间",provider:"厂商",model:"模型",workspace:"项目",task:"任务"}).map(([v,t])=><option key={v} value={v}>{t}</option>)}</select></div>
    {data&&<>
      <div className="ad-metrics">{[["输入 Token",format(data.totals.input_tokens)],["输出 Token",format(data.totals.output_tokens)],
        ["缓存命中率",ratio(data.totals.cache_hit_rate)],["生成速率",`${format(data.totals.tokens_per_sec)} tok/s`],["估算费用",cost(data.totals)]]
        .map(([label,value])=><div key={label}><small>{label}</small><strong>{value}</strong></div>)}</div>
      <Trend data={data.trend}/>{data.rows.length>0&&<div className="ad-table-wrap"><table className="ad-table"><thead>
        <tr>{["分组","请求","用量未知","输入","输出","缓存读取","命中率","TTFT (ms)","tok/s","费用"].map(v=><th key={v}>{v}</th>)}</tr></thead>
        <tbody>{data.rows.map(r=><tr key={r.id}><td>{r.label}</td>{[r.requests,r.unknown_usage,r.input_tokens,r.output_tokens,r.cached_input_tokens].map((v,i)=><td key={i} className="num">{format(v)}</td>)}
          <td>{ratio(r.cache_hit_rate)}</td><td>{format(r.ttft_ms)}</td><td>{format(r.tokens_per_sec)}</td><td>{cost(r)}</td></tr>)}</tbody></table></div>}
    </>}
    <details className="ad-form-panel ad-form"><summary>预算告警</summary>
      {budget&&<form onSubmit={e=>{e.preventDefault();void a.run(async()=>{await api("/api/usage/budget",json("PUT",budget));await loadBudget()},"预算已保存")}}>
        <div className="ad-form-grid">{(Object.keys(limitNames) as (keyof UsageBudget)[]).map(k=><label key={k}>{limitNames[k]}
          <NumberControl step="any" min="0" placeholder="未设置" value={budget[k]??""} onChange={e=>setBudget({...budget,[k]:e.target.value===""?null:Number(e.target.value)})}/></label>)}</div>
        <p className="ad-detail">按 UTC 结算。达到上限时写入一次告警并通知已启用的渠道。</p><button className="ad-button" disabled={a.busy}>保存预算</button></form>}
    </details>
    {alerts.map(v=><p key={v.kind} className="ad-message caution">{v.period} · {limitNames[v.kind]} 达到预算 {format(v.limit,8)}，已用 {format(v.spent,8)}</p>)}
    <Feedback error={a.error} notice={a.notice}/>
  </section>;
}
