import { randomUUID } from "node:crypto";
import { object, type Obj } from "./requests.js";
import { readSse, type SseFrame } from "../sse.js";

function usage(value: Obj): Obj | null {
  if (typeof value.input_tokens !== "number" || typeof value.output_tokens !== "number") return null;
  const cached = Number(value.cache_read_input_tokens ?? 0);
  const input = value.input_tokens + cached + Number(value.cache_creation_input_tokens ?? 0);
  return {input_tokens:input,output_tokens:value.output_tokens,total_tokens:input+value.output_tokens,input_tokens_details:{cached_tokens:cached}};
}
type ToolNames = Map<string,{name:string; namespace?:string}>;
function output(block: Obj,names?:ToolNames): Obj {
  switch (block.type) {
    case "text": return {type:"message",role:"assistant",id:"msg_"+randomUUID(),content:[{type:"output_text",text:block.text,annotations:[]}]};
    case "tool_use": return {type:"function_call",id:"fc_"+randomUUID(),call_id:block.id,...(names?.get(String(block.name))??{name:block.name}),arguments:JSON.stringify(block.input)};
    case "thinking": return {type:"reasoning",id:"rs_"+randomUUID(),summary:[{type:"summary_text",text:block.thinking}],encrypted_content:block.signature};
    case "redacted_thinking": return {type:"reasoning",id:"rs_"+randomUUID(),summary:[],encrypted_content:block.data};
    default: throw new Error("Unsupported upstream message content.");
  }
}
export function fromMessages(message: Obj, alias: string,names?:ToolNames) {
  if (message.type !== "message" || !Array.isArray(message.content)) throw new Error("Invalid upstream message.");
  const status=message.stop_reason==="max_tokens"?"incomplete":message.stop_reason==null?"in_progress":"completed";
  return {object:"response",id:message.id,model:alias,created_at:Math.floor(Date.now()/1000),status,error:null,
    incomplete_details:status==="incomplete"?{reason:"max_output_tokens"}:null,
    output:message.content.map(b=>({...output(object(b),names),status} as Obj)),usage:usage(object(message.usage))};
}
export function frame(type: string, content: Obj): SseFrame {
  const data=JSON.stringify({type,...content});
  return {event:type,data,raw:"event: "+type+"\ndata: "+data+"\n\n"};
}
export async function* messagesStream(body: ReadableStream<Uint8Array>, alias: string,names?:ToolNames) {
  let response: ReturnType<typeof fromMessages> | undefined, counted:Obj={}, sequence=0, stopped=false;
  const open=new Map<number,{item:Obj; text:string; signature:string}>();
  const event=(type:string,content:Obj)=>frame(type,{sequence_number:sequence++,...content});
  for await (const f of readSse(body)) {
    if(!f.data) continue;
    const e=object(JSON.parse(f.data));
    if(e.type==="ping") continue;
    if(e.type==="error") throw new Error("Upstream message stream failed.");
    if(e.type==="message_start") {
      if(response) throw new Error("Duplicate message start.");
      const message=object(e.message);
      response=fromMessages(message,alias);
      counted={...object(message.usage)};
      yield event("response.created",{response});yield event("response.in_progress",{response});continue;
    }
    if(!response) throw new Error("Missing message start.");
    const i=Number(e.index);
    if(e.type==="content_block_start") {
      if(i!==response.output.length) throw new Error("Invalid content block index.");
      const raw=object(e.content_block),item={...output(raw,names),status:"in_progress"} as Obj;
      if(item.type==="function_call") item.arguments="";
      open.set(i,{item,text:String(raw.text??raw.thinking??""),signature:String(raw.signature??raw.data??"")});
      response.output.push(item);
      yield event("response.output_item.added",{output_index:i,item});
      const location={output_index:i,item_id:item.id};
      if(item.type==="message") yield event("response.content_part.added",{...location,content_index:0,part:(item.content as Obj[])[0]});
      if(item.type==="reasoning" && raw.type==="thinking") yield event("response.reasoning_summary_part.added",{...location,summary_index:0,part:(item.summary as Obj[])[0]});
    } else if(e.type==="content_block_delta" || e.type==="content_block_stop") {
      const state=open.get(i);
      if(!state) throw new Error("Unknown content block index.");
      const {item}=state, tool=item.type==="function_call", reasoning=item.type==="reasoning";
      const location={output_index:i,item_id:item.id,...(tool?{}:reasoning?{summary_index:0}:{content_index:0})};
      const prefix=tool?"response.function_call_arguments":reasoning?"response.reasoning_summary_text":"response.output_text";
      if(e.type==="content_block_delta") {
        const d=object(e.delta);
        if(d.type==="signature_delta"){state.signature+=String(d.signature??"");continue;}
        const value=d.text??d.partial_json??d.thinking;
        if(typeof value!=="string") throw new Error("Invalid content delta.");
        state.text+=value;
        yield event(prefix+".delta",{...location,delta:value});
      } else {
        if(tool) item.arguments=state.text || "{}";
        else if(reasoning) {
          if((item.summary as Obj[]).length) item.summary=[{type:"summary_text",text:state.text}];
          item.encrypted_content=state.signature;
        } else item.content=[{type:"output_text",text:state.text,annotations:[]}];
        item.status="completed";open.delete(i);
        if(!reasoning || (item.summary as Obj[]).length) yield event(prefix+".done",{...location,...(tool?{arguments:item.arguments,name:item.name}:{text:state.text})});
        if(item.type==="message") yield event("response.content_part.done",{...location,part:(item.content as Obj[])[0]});
        if(reasoning && (item.summary as Obj[]).length) yield event("response.reasoning_summary_part.done",{...location,part:(item.summary as Obj[])[0]});
        yield event("response.output_item.done",{output_index:i,item});
      }
    } else if(e.type==="message_delta") {
      const reason=object(e.delta).stop_reason;
      if(reason!=null) {
        response.status=reason==="max_tokens"?"incomplete":"completed";
        response.incomplete_details=response.status==="incomplete"?{reason:"max_output_tokens"}:null;
      }
      Object.assign(counted,object(e.usage));
    } else if(e.type==="message_stop") {
      if(open.size || response.status==="in_progress") throw new Error("Incomplete upstream message.");
      response.usage=usage(counted);
      yield event("response."+response.status,{response});stopped=true;break;
    }
  }
  if(!stopped) throw new Error("Messages stream ended early.");
}
