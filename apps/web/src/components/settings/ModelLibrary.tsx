import {ToggleSwitch,SegmentedControl} from "./Controls";
import { useEffect, useRef, useState } from "react";
import type { Model, Provider, DiscoveredModel } from "@codexdeck/shared";
import { api, json } from "../../lib/api";
import { Feedback, useAction } from "./common";

export function ModelLibrary({provider,close,changed}:{provider:Provider;close:()=>void;changed:()=>Promise<void>}) {
  const dialog=useRef<HTMLDialogElement>(null);
  const [models,setModels]=useState<DiscoveredModel[]>([]),[selected,setSelected]=useState<string[]>([]);
  const [query,setQuery]=useState(""),[prefix,setPrefix]=useState("");
  const [loading,setLoading]=useState(true);
  const [outcome,setOutcome]=useState("");
  const a=useAction();
  useEffect(()=>{
    let active=true;
    const modal=dialog.current;modal?.showModal();
    void api<{models:DiscoveredModel[]}>(`/api/providers/${provider.id}/fetch-models`,json("POST",{}))
      .then(r=>{if(active)setModels(r.models)}).catch(e=>{if(active)a.setError(String(e))}).finally(()=>{if(active)setLoading(false)});
    return ()=>{active=false;modal?.close()};
  },[provider.id]);
  const visible=models.filter(m=>m.model_id.startsWith(prefix)&&m.model_id.toLowerCase().includes(query.trim().toLowerCase()));
  const prefixes=Array.from(new Set(models.map(m=>m.model_id.match(/^[^/-]+[/-]/)?.[0]).filter((p):p is string=>!!p))).sort();
  const all=visible.length>0&&visible.every(m=>selected.includes(m.model_id));
  async function save() {
    const entries=models.filter(m=>selected.includes(m.model_id)).map(({model_id,context_window,capabilities})=>({model_id,context_window,capabilities}));
    let imported=0,skipped=0;
    for(let offset=0;offset<entries.length;offset+=500) {
      const result=await api<{imported:Model[];skipped:string[]}>("/api/models/batch",json("POST",{provider_id:provider.id,models:entries.slice(offset,offset+500)}));
      imported+=result.imported.length;
      skipped+=result.skipped.length;
      setOutcome(`已导入 ${imported} 个，已存在 ${skipped} 个`);
    }
    setSelected([]);await changed();
  }
  return <dialog ref={dialog} className="ad-onekey model-library ad-form" onCancel={close} aria-label="从上游获取模型">
    <div className="ad-labelrow"><h2>{provider.name} · 上游模型</h2><button className="ad-button" onClick={close}>关闭</button></div>
    <div className="ad-form-grid"><label>搜索模型<input autoFocus type="search" value={query} onChange={e=>setQuery(e.target.value)}/></label>
    <label>模型前缀<select value={prefix} onChange={e=>setPrefix(e.target.value)}><option value="">全部前缀</option>{prefixes.map(p=><option key={p}>{p}</option>)}</select></label></div>
    <label className="ad-check"><ToggleSwitch checked={all} disabled={!visible.length} onCheckedChange={()=>setSelected(all?selected.filter(id=>!visible.some(m=>m.model_id===id)):[...new Set([...selected,...visible.map(m=>m.model_id)])])}/>选择筛选结果</label>
    <div className="library-list">{visible.map(m=><label key={m.model_id} className="ad-check"><ToggleSwitch checked={selected.includes(m.model_id)} onCheckedChange={next=>setSelected(next?[...selected,m.model_id]:selected.filter(id=>id!==m.model_id))}/>
      <span>{m.model_id}<small>{m.context_window.toLocaleString()} tokens · {m.context_source==="upstream"?"上游报告":"建议值"} {m.capabilities.join(" · ")}</small></span></label>)}
      {!visible.length&&!loading&&!a.error&&<small>没有匹配的上游模型</small>}</div>
    <Feedback busy={a.busy||loading} error={a.error} notice={outcome}/>
    <button className="ad-primary" disabled={!selected.length||a.busy} onClick={()=>void a.run(save)}>导入选中模型 ({selected.length})</button>
  </dialog>;
}

export function BenchmarkBoard({models,current,changed}:{models:Model[];current:string|null;changed:()=>Promise<void>}) {
  const [selected,setSelected]=useState<string[]>([]),[speed,setSpeed]=useState(false);
  const [order,setOrder]=useState<"ttft_ms"|"tokens_per_sec"|"status">("ttft_ms");
  const a=useAction();
  const sorted=[...models].sort((x,y)=>{
    const one=x.last_benchmark,two=y.last_benchmark;
    if(order==="status")return (one?.status==="ok"?0:one?1:2)-(two?.status==="ok"?0:two?1:2);
    const left=one?.[order],right=two?.[order];
    if(left==null||right==null)return left==null?Number(right!=null):-1;
    return order==="tokens_per_sec"?right-left:left-right;
  });
  const ids=models.filter(m=>!selected.length||selected.includes(m.id)).map(m=>m.id);
  async function benchmark() {
    try {
      for(let offset=0;offset<ids.length;offset+=200) {
        await api("/api/models/benchmark",json("POST",{model_ids:ids.slice(offset,offset+200),sample_tokens:speed?32:1,concurrency:3}));
      }
    } finally {await changed();}
  }
  if(!models.length)return null;
  return <section className="benchmark-board"><div className="ad-subhead"><h2>模型测速榜</h2>
    <button className="ad-primary" disabled={a.busy||!ids.length} onClick={()=>void a.run(benchmark,"测速完成")}>{selected.length?"测速选中模型":"测速全部启用模型"}</button></div>
    <div className="ad-actions"><label className="ad-check"><ToggleSwitch checked={speed} onCheckedChange={next=>setSpeed(next)}/>测生成速度（最多 32 tokens）</label>
      <SegmentedControl aria-label="测速排序" value={order} onValueChange={next=>setOrder(next as typeof order)}><option value="ttft_ms">按首字延迟</option><option value="tokens_per_sec">按生成速率</option><option value="status">按可用性</option></SegmentedControl></div>
    <Feedback busy={a.busy} notice={a.notice} error={a.error}/>
    <div className="ad-table-wrap"><table className="ad-table"><thead><tr>{["模型","状态","首字延迟","生成速率","采样时间",""].map((v,i)=><th key={i}>{v}</th>)}</tr></thead>
      <tbody>{sorted.map(m=>{
        const b=m.last_benchmark;
        return <tr key={m.id}><td><label className="ad-check"><ToggleSwitch aria-label={"选择测速 "+m.alias} checked={selected.includes(m.id)} onCheckedChange={next=>setSelected(next?[...selected,m.id]:selected.filter(id=>id!==m.id))}/>{m.alias}</label></td>
          <td title={b?.error??undefined}>{b?b.status==="ok"?"可用":"失败":"未测"}{b?.error&&<small>{b.error}</small>}</td>
          <td>{b?.ttft_ms==null?"—":`${b.ttft_ms} ms`}</td><td>{b?.tokens_per_sec==null?b?"样本不足":"—":`${b.tokens_per_sec.toFixed(1)} tok/s`}</td>
          <td>{b?new Date(b.tested_at).toLocaleString():"—"}</td><td>{current===m.alias?"默认模型":<button className="ad-button" disabled={a.busy} onClick={()=>void a.run(async()=>{await api("/api/models/default",json("PUT",{alias:m.alias}));await changed()})}>设为默认</button>}</td></tr>;
      })}</tbody></table></div></section>;
}
