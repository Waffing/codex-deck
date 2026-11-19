import {create} from "zustand";
import {threadEventSchema,type ThreadEvent} from "@codexdeck/shared";

export type Heartbeat = {timestamp:string;cpu_percent:number|null;total_memory_bytes:number;free_memory_bytes:number;running_services:number;gateway_healthy:boolean};
type Realtime = {thread:string;events:ThreadEvent[];state:"connecting"|"online"|"offline";heartbeat:Heartbeat|null; approvals:number|null};
export const useRealtime=create<Realtime>(()=>({thread:"",events:[],state:"offline",heartbeat:null,approvals:null}));
const prefix="codexdeck.events.v1.";
export function mergeEvents(prev:ThreadEvent[],batch:ThreadEvent[],thread:string) {
  const records=new Map(prev.map(e=>[e.seq_id,e]));
  for(const e of batch) if(e.thread_id===thread && !records.has(e.seq_id)) records.set(e.seq_id,e);
  return [...records.values()].sort((a,b)=>a.seq_id-b.seq_id);
}
export function lastContiguous(events:ThreadEvent[]){
  let seq=0;
  for(const e of events) {if(e.seq_id!==seq+1) break;seq=e.seq_id;}
  return seq;
}
function restore(id:string):ThreadEvent[] {
  try {
    const parsed=threadEventSchema.array().safeParse(JSON.parse(sessionStorage.getItem(prefix+id)??"[]"));
    return parsed.success?mergeEvents([],parsed.data,id):[];
  }catch{return [];}
}
export function clearRealtime(){
  for(const key of Object.keys(sessionStorage)) if(key.startsWith(prefix)) sessionStorage.removeItem(key);
  useRealtime.setState({thread:"",events:[],state:"offline",heartbeat:null,approvals:null});
}
export function connectEvents(thread:string,onChange:()=>void,onUnauthorized:()=>void){
  let closed=false, attempt=0, socket:WebSocket|undefined;
  let retry:ReturnType<typeof setTimeout>|undefined, flush:ReturnType<typeof setTimeout>|undefined;
  let refresh:ReturnType<typeof setTimeout>|undefined;
  let pending:ThreadEvent[]=[];
  useRealtime.setState({thread,events:restore(thread),state:"connecting"});
  function apply(){
    clearTimeout(flush);flush=undefined;
    if(!pending.length)return;
    const events=mergeEvents(useRealtime.getState().events,pending,thread);
    pending=[];useRealtime.setState({events});
    try{sessionStorage.setItem(prefix+thread,JSON.stringify(events));}catch{/* On reload the server replays from the last complete saved snapshot. */}
  }
  function changed(){if(!refresh)refresh=setTimeout(()=>{refresh=undefined;onChange();},35);}
  function open(){
    useRealtime.setState({state:"connecting"});
    const url=new URL("/ws/events",location.href);
    url.protocol=location.protocol==="https:"?"wss:":"ws:";
    if(thread){url.searchParams.set("thread_id",thread);url.searchParams.set("last_seq_id",String(lastContiguous(useRealtime.getState().events)));}
    const ws=new WebSocket(url);socket=ws;
    ws.onopen=()=>{attempt=0;useRealtime.setState({state:"online"});changed();};
    ws.onmessage=({data})=>{
      let frame;
      try{frame=JSON.parse(String(data));}catch{return;}
      if(frame.type==="event"){
        const valid=threadEventSchema.safeParse(frame.event);
        if(valid.success && valid.data.thread_id===thread){pending.push(valid.data);flush??=setTimeout(apply,24);}
      }else if(frame.type==="approvals_count"){useRealtime.setState({approvals:frame.count});changed();}
      else if(frame.type==="heartbeat"){useRealtime.setState({heartbeat:frame});}
      else if(frame.type==="thread_changed"){changed();}
    };
    ws.onclose=(event)=>{
      if(closed)return;
      apply(); useRealtime.setState({state:"offline"});
      if(event.code===1008 && /session/i.test(event.reason)){onUnauthorized();return;}
      retry=setTimeout(open,Math.min(15000,350*2**attempt++));
    };
  }
  open();
  window.addEventListener("pagehide",apply);
  return ()=>{closed=true;clearTimeout(retry);clearTimeout(refresh);window.removeEventListener("pagehide",apply);apply();
    if(socket){socket.onclose=null;socket.onmessage=null;socket.onopen=null;socket.close();}};
}
