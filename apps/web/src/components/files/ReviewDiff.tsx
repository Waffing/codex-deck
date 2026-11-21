import {Fragment, useEffect, useMemo, useRef, useState} from "react";
import {GitPullRequestArrow, Plus} from "lucide-react";
import {parseDiffLines, type CrossModelReview, type DiffAnnotation, type Model, type Thread} from "@codexdeck/shared";
import {api, json} from "../../lib/api";

type Patch={patch:string;diff_hash:string;truncated:boolean};
const severity={critical:"严重",warning:"警告",suggestion:"建议"};
export function ReviewDiff({thread,turnId,models,onRefresh}:{thread:Thread;turnId?:string;models:Model[];onRefresh:()=>void}){
  const base="/api/threads/"+encodeURIComponent(thread.id),scope=turnId?"?turn_id="+encodeURIComponent(turnId):"";
  const choices=models.filter(m=>m.enabled&&m.alias!==thread.active_model_alias);
  const [alias,setAlias]=useState("");
  const [patch,setPatch]=useState<Patch>(),[review,setReview]=useState<CrossModelReview>();
  const [selected,setSelected]=useState<string[]>([]),[annotations,setAnnotations]=useState<DiffAnnotation[]>([]);
  const [editing,setEditing]=useState<number|null>(null),[comment,setComment]=useState("");
  const [busy,setBusy]=useState(false),[notice,setNotice]=useState(""),[error,setError]=useState("");
  const pending=useRef({key:"",id:""}),nodes=useRef(new Map<number,HTMLElement>());
  const lines=useMemo(()=>parseDiffLines(patch?.patch??""),[patch]);
  useEffect(()=>{
    const abort=new AbortController(),opts={signal:abort.signal};
    Promise.all([api<Patch>(base+"/review-diff"+scope,opts),api<CrossModelReview[]>(base+"/reviews",opts)])
      .then(([snapshot,reviews])=>{setPatch(snapshot);setReview(reviews.find(r=>r.diff_hash===snapshot.diff_hash&&(r.turn_id??null)===(turnId??null)));})
      .catch(e=>{if(!abort.signal.aborted)setError(e.message);});return ()=>abort.abort();
  },[base,scope,turnId]);
  const effectiveAlias=choices.find(m=>m.alias===alias)?.alias??choices[0]?.alias??"";
  useEffect(()=>{
    const abort=new AbortController();
    api<{review_model_alias:string|null}>("/api/workspaces/"+thread.workspace_id+"/quality",{signal:abort.signal}).then(c=>setAlias(current=>current||c.review_model_alias||"")).catch(e=>{if(!abort.signal.aborted)setError(e.message);});
    return ()=>abort.abort();
  },[thread.workspace_id]);
  async function runReview(){
    setBusy(true);setError("");setNotice("");
    try{
      const next=await api<CrossModelReview>(base+"/reviews",json("POST",{turn_id:turnId,reviewer_model_alias:effectiveAlias}));
      if(next.diff_hash!==patch?.diff_hash)throw new Error("差异已更新，请重新打开抽屉后复核。");
      setReview(next);setSelected([]);
    }catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  async function feedback(kind:"annotations"|"findings"){
    if(!patch)return;
    const body={diff_hash:patch.diff_hash,turn_id:turnId,...(kind==="annotations"?{annotations}:{review_id:review?.id,finding_ids:selected})};
    const key=JSON.stringify(body);
    if(pending.current.key!==key)pending.current={key,id:crypto.randomUUID()};
    setBusy(true);setError("");setNotice("");
    try{
      await api(base+"/review-feedback",json("POST",{...body,client_msg_id:pending.current.id}));
      if(kind==="annotations")setAnnotations([]);else setSelected([]);
      setNotice("已发送给 Codex");onRefresh();pending.current={key:"",id:""};
    }catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  function locate(file:string,line:number){
    const index=lines.findIndex(row=>row.file===file&&row.line===line&&row.side==="new");
    const target=index<0?lines.findIndex(row=>row.file===file&&row.line===line):index;
    if(target<0){setNotice("该行在当前差异范围之外");return;}
    nodes.current.get(target)?.scrollIntoView({block:"center"});nodes.current.get(target)?.focus({preventScroll:true});
  }
  return <section className="quality-panel review-diff">
    <div className="quality-actions">
      <select aria-label="复审模型" value={effectiveAlias} onChange={e=>setAlias(e.target.value)}>{!choices.length&&<option value="">请先配置另一个模型</option>}{choices.map(m=><option key={m.id}>{m.alias}</option>)}</select>
      <button disabled={busy||!effectiveAlias||!patch?.patch} className="btn-outline" onClick={()=>void runReview()}><GitPullRequestArrow size={14}/>AI 跨模型复审</button>
      {patch?.patch&&<button onClick={()=>{const url=URL.createObjectURL(new Blob([patch.patch],{type:"text/x-diff"}));const a=document.createElement("a");a.href=url;a.download="changes.patch";a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}}>下载 Patch</button>}
    </div>
    {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
    {review&&<section className="review-summary"><strong>{review.reviewer_model_alias}</strong><p>{review.summary}</p>
      {review.findings.map(f=><article key={f.id} data-severity={f.severity}>
        <label><input type="checkbox" checked={selected.includes(f.id)} onChange={e=>setSelected(ids=>e.target.checked?[...ids,f.id]:ids.filter(id=>id!==f.id))}/><small>{severity[f.severity]}</small>{f.title}</label>
        <button className="review-link" onClick={()=>locate(f.file,f.line)}>{f.file}:{f.line}</button><p>{f.detail}</p>{f.fix_hint&&<p>{f.fix_hint}</p>}
      </article>)}
      {review.findings.length>0&&<button disabled={busy||!selected.length} className="btn-primary" onClick={()=>void feedback("findings")}>将选中问题发回 Codex 修复</button>}
    </section>}
    {!patch&&!error&&<p>正在读取差异…</p>}{patch&&!patch.patch&&<p>工作区没有 Git 差异</p>}
    {patch?.truncated&&<p>差异过大，当前仅展示部分内容。</p>}
    <div className="quality-diff-lines">{lines.map((row,i)=>{
      const saved=annotations.find(a=>a.file===row.file&&a.line===row.line&&a.side===row.side);
      return <Fragment key={i}><div data-side={row.side??""} tabIndex={-1} ref={el=>{if(el)nodes.current.set(i,el);else nodes.current.delete(i);}}>
        {row.file&&row.side&&row.line!==null&&<button title={"批注 "+row.file+":"+row.line+" "+row.side} aria-label={"批注 "+row.file+":"+row.line+" "+row.side} onClick={()=>{setEditing(i);setComment(saved?.comment??"");}}><Plus size={11}/>{row.line}</button>}
        <code>{row.text}</code></div>
        {editing===i?<form onSubmit={e=>{
          e.preventDefault();if(!row.file||!row.side||row.line==null||!comment.trim())return;
          const note:DiffAnnotation={file:row.file,line:row.line,side:row.side,comment:comment.trim()};
          setAnnotations(list=>[...list.filter(a=>!(a.file===note.file&&a.line===note.line&&a.side===note.side)),note]);setEditing(null);
        }}><textarea autoFocus aria-label="行级批注" value={comment} onChange={e=>setComment(e.target.value)} rows={2} required/>
          <button type="submit" disabled={!comment.trim()}>保存批注</button><button type="button" onClick={()=>setEditing(null)}>取消</button></form>:
        saved&&<p className="review-comment">{saved.comment}</p>}
      </Fragment>;
    })}</div>
    {annotations.length>0&&<footer className="quality-actions"><strong>已标注 {annotations.length} 处批注</strong><button disabled={busy} onClick={()=>setAnnotations([])}>清空</button>
      <button className="btn-primary" disabled={busy} onClick={()=>void feedback("annotations")}>汇总发给 Codex 修改</button></footer>}
  </section>;
}
