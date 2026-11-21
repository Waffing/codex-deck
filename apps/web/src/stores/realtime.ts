import {create} from "zustand";
import {threadEventSchema,type ThreadEvent} from "@codexdeck/shared";

export type Heartbeat = {timestamp:string;cpu_percent:number|null;total_memory_bytes:number;free_memory_bytes:number;running_services:number;gateway_healthy:boolean;
  gateway_state:"unconfigured"|"unverified"|"stale"|"verified"|"failed";gateway_checked_at:string|null;gateway_error:string|null};
type Realtime = {thread:string;events:ThreadEvent[];state:"connecting"|"online"|"offline";heartbeat:Heartbeat|null; approvals:number|null};
export const useRealtime=create<Realtime>(()=>({thread:"",events:[],state:"offline",heartbeat:null,approvals:null}));
const prefix="codexdeck.events.v1.";
export function mergeEvents(prev:ThreadEvent[],batch:ThreadEvent[],thread:string) {
  const records=new Map(prev.map(e=>[e.seq_id,e]));
  for(const e of batch) if(e.thread_id===thread && !records.has(e.seq_id)) records.set(e.seq_id,e);
  return [...records.values()].sort((a,b)=>a.seq_id-b.seq_id);
}
export function discardThrough(thread:string,seq:number){
  const current=useRealtime.getState();
  if(current.thread===thread && current.events.some(e=>e.seq_id<=seq)){
    useRealtime.setState({events:current.events.filter(e=>e.seq_id>seq)});
  }
}
export function clearRealtime(){
  for(const key of Object.keys(sessionStorage)) if(key.startsWith(prefix)) sessionStorage.removeItem(key);
  useRealtime.setState({thread:"",events:[],state:"offline",heartbeat:null,approvals:null});
}
export function connectEvents(thread:string,onChange:()=>void,onUnauthorized:()=>void,initialCursor:number,debug=false){
  let closed=false, attempt=0, socket:WebSocket|undefined;
  let retry:ReturnType<typeof setTimeout>|undefined, flush:ReturnType<typeof setTimeout>|undefined;
  let refresh:ReturnType<typeof setTimeout>|undefined;
  let pending:ThreadEvent[]=[];
  let cursor=initialCursor;
  useRealtime.setState({thread,events:[],state:"connecting"});
  function apply(){
    clearTimeout(flush);flush=undefined;
    if(!pending.length)return;
    const combined=mergeEvents(useRealtime.getState().events,pending,thread);
    cursor=Math.max(cursor,combined.at(-1)?.seq_id??0);
    pending=[];useRealtime.setState({events:combined});
  }
  function changed(){if(!refresh)refresh=setTimeout(()=>{refresh=undefined;onChange();},35);}
  function open(){
    useRealtime.setState({state:"connecting"});
    const url=new URL("/ws/events",location.href);
    url.protocol=location.protocol==="https:"?"wss:":"ws:";
    if(thread){url.searchParams.set("thread_id",thread);url.searchParams.set("last_seq_id",String(cursor));}
    if(debug)url.searchParams.set("debug","true");
    const ws=new WebSocket(url);socket=ws;
    ws.onopen=()=>{if(attempt>0)changed();attempt=0;useRealtime.setState({state:"online"});};
    ws.onmessage=({data})=>{
      let frame;
      try{frame=JSON.parse(String(data));}catch{return;}
      if(frame.type==="event"){
        const valid=threadEventSchema.safeParse(frame.event);
        if(valid.success && valid.data.thread_id===thread){pending.push(valid.data);flush??=setTimeout(apply,24);}
      }else if(frame.type==="cursor" && frame.thread_id===thread && Number.isSafeInteger(frame.seq_id)){
        apply();cursor=Math.max(cursor,frame.seq_id);
      }else if(frame.type==="approvals_count"){useRealtime.setState({approvals:frame.count});changed();}
      else if(frame.type==="heartbeat"){useRealtime.setState({heartbeat:frame});}
      else if(frame.type==="thread_changed"||frame.type==="thread_updated"){changed();}
      else if(frame.type==="activity"){window.dispatchEvent(new CustomEvent("codexdeck:activity",{detail:frame}));}
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
    if(socket){socket.onclose=null;socket.onmessage=null;if(socket.readyState===WebSocket.CONNECTING)socket.onopen=()=>socket?.close();else{socket.onopen=null;socket.close();}}};
}
