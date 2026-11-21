import {useCallback,useEffect,useRef,useState} from "react";
import {projectTurn,type ThreadEvent,type TurnPage,type TurnSnapshot} from "@codexdeck/shared";
import {api} from "../../lib/api";
import {cached,cachePut,cacheTicket,forgetCached} from "../../lib/cache";

export const object=(v:unknown):Record<string,unknown>=>v && typeof v==="object"?v as Record<string,unknown>:{};
const empty:TurnPage={turns:[],has_more:false,latest_seq_id:0,active_turn:null};
export function useTurnPages(thread:string|undefined, marker:number, onReady:((id:string,cursor:number)=>void)|undefined, persist=true) {
  const key="thread:"+thread;
  const [tail,setTail]=useState<TurnPage>(()=>(persist && cached<TurnPage>(key))||empty);
  const [older,setOlder]=useState<TurnSnapshot[]>([]);
  const [hasEarlier,setEarlier]=useState<boolean>();
  const [error,setError]=useState("");
  const [revision,setRevision]=useState(0);
  const [initialLoaded,setInitialLoaded]=useState(Boolean(persist && cached(key)));

  const loading=useRef(false);
  const controller=useRef<AbortController|null>(null);
  useEffect(()=>{
    if(!thread)return;
    const ticket=cacheTicket(),abort=new AbortController();
    void api<TurnPage>("/api/threads/"+thread+"/turns",{signal:abort.signal}).then(page=>{
      if(abort.signal.aborted)return;
      if(!Array.isArray(page.turns))throw new Error("回合记录格式无效");
      setInitialLoaded(true);setError("");
      setTail(old=>old!==empty && old.latest_seq_id===page.latest_seq_id?old:page);
      if(persist)cachePut(key,page,ticket);
      onReady?.(thread,page.latest_seq_id);
    }).catch(e=>{
      if(abort.signal.aborted)return;
      if([401,403,404].includes(e.status)){if(persist)void forgetCached(key);setTail(empty);setOlder([]);}
      setError((e as Error).message);
    });
    return ()=>abort.abort();
  },[thread,marker,key,revision,onReady,persist]);
  useEffect(()=>()=>controller.current?.abort(),[]);
  const more=hasEarlier??tail.has_more;
  const loadEarlier=async()=>{
    if(!thread || !more || loading.current)return;
    const before=(older[0]??tail.turns[0])?.turn_index;
    if(before===undefined)return;
    loading.current=true;
    const abort=new AbortController();controller.current=abort;
    try{
      const page=await api<TurnPage>("/api/threads/"+thread+"/turns?before_turn_index="+before,{signal:abort.signal});
      if(!abort.signal.aborted){setOlder(prev=>[...page.turns,...prev]);setEarlier(page.has_more);}
    }catch(e){if(!abort.signal.aborted)setError((e as Error).message);}
    finally{loading.current=false;}
  };
  const refresh=useCallback(()=>setRevision(x=>x+1),[]);
  return {tail,older,more,loadEarlier,error,refresh,initialLoaded};
}

function fromSnapshot(s:TurnSnapshot){
  return {task:{id:s.id,prompt:s.user_content,status:s.status as string,created_at:s.created_at,updated_at:s.updated_at,checkpoint_ref:s.checkpoint_ref,clientMsgId:s.client_msg_id},
    frames:[] as ThreadEvent[],projection:{items:s.timeline,telemetry:s.telemetry,debug:[] as ThreadEvent[]},answer:s.assistant_markdown,
    finished:s.status!=="running"&&s.status!=="queued",summaryOnly:s.summary_only,files:s.artifacts};
}
export type ChatTurn=ReturnType<typeof fromSnapshot>;
const converted=new WeakMap<TurnSnapshot,ChatTurn>();
export function collectSnapshots(snapshots:TurnSnapshot[],events:ThreadEvent[]):ChatTurn[]{
  const byId=new Map(snapshots.map(s=>[s.id,s]));
  const groups=new Map<string,ThreadEvent[]>();
  for(const e of events){
    if(!e.task_id || e.seq_id<=(byId.get(e.task_id)?.latest_seq_id??0))continue;
    const bucket=groups.get(e.task_id);
    if(bucket)bucket.push(e);else groups.set(e.task_id,[e]);
  }
  const result=new Map<string,ChatTurn>();
  for(const s of snapshots){let turn=converted.get(s);if(!turn){turn=fromSnapshot(s);converted.set(s,turn);}result.set(s.id,turn);}
  for(const [id,frames] of groups){
    const base=byId.get(id),first=frames[0],last=frames[frames.length-1];
    const prefix:ThreadEvent[]=[];
    const seed=(type:string,payload:unknown)=>prefix.push({...first,type,payload,seq_id:0});
    for(const a of base?.active_answer_items??[])seed("answer_item",a);
    for(const item of base?.timeline??[]){
      if(item.kind==="tool_group"){for(const op of item.operations??[])seed("tool_group",op);}
      else seed(item.kind,item);
    }
    const merged=projectTurn([...prefix,...frames]);
    const existing=result.get(id);
    const queued=frames.find(e=>e.type==="task_queued");
    const payload=object(queued?.payload);
    let status:string=base?.status??"queued";
    for(const e of frames){
      if(e.type==="task_started")status="running";
      if(["task_completed","task_failed","task_cancelled"].includes(e.type))status=e.type.slice(5);
    }
    result.set(id,{task:{id,prompt:base?.user_content??String(payload.prompt??""),status,created_at:base?.created_at??first.created_at,
      updated_at:last.created_at,clientMsgId:base?.client_msg_id??(typeof payload.client_msg_id==="string"?payload.client_msg_id:null),
      checkpoint_ref:base?.checkpoint_ref??null},answer:merged.answer||existing?.answer||"",projection:{...merged,telemetry:merged.telemetry??base?.telemetry??null},
      frames,finished:!["queued","running"].includes(status),summaryOnly:!!base?.summary_only,files:base?.artifacts??[]});
  }
  return [...result.values()];
}
