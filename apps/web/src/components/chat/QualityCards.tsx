import {useEffect,useState} from "react";
import {Check,ClipboardCheck,Pencil} from "lucide-react";
import type {PlanApprovalState,ThreadEvent,VerifyGateResult} from "@codexdeck/shared";
import {api,json} from "../../lib/api";
import {AnswerDocument} from "./AnswerDocument";

type Quality={plan:PlanApprovalState|null;verify:(VerifyGateResult & {current_command?:string;requires_review?:boolean;turn_id?:string})|null};
const labels={passed:"质检通过",failed:"质检失败",repairing:"自动修复中",running:"正在质检",cancelled:"质检已中止"};

export function QualityCards({threadId,events,refresh}:{threadId:string;events:ThreadEvent[];refresh:()=>void}){
  const [state,setState]=useState<Quality>({plan:null,verify:null}),[revision,update]=useState(0);
  const [editing,setEditing]=useState(false),[feedback,setFeedback]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const base="/api/threads/"+threadId;
  const marker=events.reduce((n,e)=>["plan_ready","plan_approved","plan_revised","verify_gate_progress","verify_gate_result","task_completed"].includes(e.type)?e.seq_id:n,0);
  useEffect(()=>{
    const abort=new AbortController();
    api<Quality>(base+"/quality",{signal:abort.signal}).then(setState).catch(e=>{if(!abort.signal.aborted)setError(e.message);});return ()=>abort.abort();
  },[base,revision,marker]);
  async function act(action:"approve"|"revise"|"interrupt"){
    if(busy)return;
    setBusy(true);setError("");
    try{
      await api(base+(action==="interrupt"?"/interrupt":"/plan/"+action),json("POST",action==="interrupt"?{}:{turn_id:state.plan?.turn_id,...(action==="revise"?{feedback:feedback.trim()}:{})}));
      setEditing(false);setFeedback("");setState(s=>({...s,plan:null}));update(v=>v+1);refresh();
    }catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  async function runReviewed(){
    if(!state.verify?.turn_id||busy)return;
    setBusy(true);setError("");
    try {await api(base+"/verify",json("POST",{turn_id:state.verify.turn_id,reviewed:true}));update(v=>v+1);refresh();}
    catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  const {plan,verify}=state;
  return <>{plan&&<article className="quality-card plan-ready" aria-label="计划确认">
    <h3><ClipboardCheck size={17}/>计划待确认</h3>
    <details><summary>查看计划</summary><AnswerDocument source={plan.markdown} turnId={plan.turn_id} complete={false} onError={setError}/></details>
    <div className="quality-actions"><button disabled={busy} className="btn-primary" onClick={()=>void act("approve")}><Check size={14}/>批准并开始编码</button>
    <button disabled={busy} aria-expanded={editing} onClick={()=>setEditing(!editing)}><Pencil size={13}/>提修改意见重拟</button></div>
    {editing&&<form onSubmit={e=>{e.preventDefault();void act("revise");}}><textarea autoFocus aria-label="计划修改意见" placeholder="指出需要调整的步骤" value={feedback} onChange={e=>setFeedback(e.target.value)}/>
    <button disabled={busy||!feedback.trim()} className="btn-outline">提交修改意见</button></form>}
  </article>}{verify&&<details className="quality-card gate-result" data-state={verify.status}><summary>{labels[verify.status]}{verify.attempt>0&&" · 修复 "+verify.attempt+"/"+verify.max_retries}</summary>
    {verify.current_command&&<code>{verify.current_command}</code>}
    {verify.commands.map((c,i)=><details key={i}><summary>{c.command}{c.exit_code!==null&&" · "+c.exit_code}</summary><pre>{c.output||"无输出"}</pre></details>)}
    {verify.requires_review&&verify.turn_id&&<button className="btn-outline" disabled={busy} onClick={()=>void runReviewed()}>已复核外部改动，使用项目密钥重跑质检</button>}
    {(verify.status==="running"||verify.status==="repairing")&&<button disabled={busy} onClick={()=>void act("interrupt")}>中止质检</button>}</details>}
    {error&&<p role="alert">{error}</p>}</>;
}
