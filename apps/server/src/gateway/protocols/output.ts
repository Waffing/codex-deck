import { randomUUID } from "node:crypto";
import { frame } from "./messages.js";
import { object, type Obj, type Wire } from "./requests.js";

function blocks(item: Obj): Obj[] {
  if(item.type==="function_call") return [{type:"tool_use",id:item.call_id,name:item.name,input:JSON.parse(String(item.arguments||"{}"))}];
  if(item.type==="message") return (Array.isArray(item.content)?item.content:[]).map(p=>({type:"text",text:object(p).text??object(p).refusal??""}));
  if(item.type==="reasoning") {
    const thought=(Array.isArray(item.summary)?item.summary:[]).map(p=>object(p).text??"").join("");
    if (!item.encrypted_content && !thought) return [];
    return [thought?{type:"thinking",thinking:thought,...(item.encrypted_content?{signature:item.encrypted_content}:{})}:{type:"redacted_thinking",data:item.encrypted_content}];
  }
  return [];
}
function counts(value: unknown) {
  const u=object(value), cached=Number(object(u.input_tokens_details).cached_tokens??0);
  return {input:Number(u.input_tokens??0),output:Number(u.output_tokens??0),cached};
}
export function encodeOutput(wire: Wire, response: Obj, alias: string): Obj {
  if (wire==="responses") return response;
  const content=(Array.isArray(response.output)?response.output:[]).flatMap(item=>blocks(object(item)));
  const u=counts(response.usage);
  const calls=content.filter(p=>p.type==="tool_use");
  const stop=response.status==="incomplete"?"max_tokens":calls.length?"tool_use":"end_turn";
  if(wire==="messages") return {id:response.id,type:"message",role:"assistant",model:alias,content,stop_reason:stop,stop_sequence:null,
    usage:{input_tokens:u.input-u.cached,cache_read_input_tokens:u.cached,output_tokens:u.output}};
  const message:Obj={role:"assistant",content:content.filter(p=>p.type==="text").map(p=>p.text).join("")||null};
  if(calls.length) message.tool_calls=calls.map(c=>({id:c.id,type:"function",function:{name:c.name,arguments:JSON.stringify(c.input)}}));
  const thought=content.filter(p=>p.type==="thinking").map(p=>p.thinking).join("");
  if(thought) message.reasoning_content=thought;
  return {id:response.id,object:"chat.completion",created:response.created_at??Math.floor(Date.now()/1000),model:alias,
    choices:[{index:0,message,finish_reason:stop==="tool_use"?"tool_calls":stop==="max_tokens"?"length":"stop"}],
    usage:response.usage?{prompt_tokens:u.input,completion_tokens:u.output,total_tokens:u.input+u.output,prompt_tokens_details:{cached_tokens:u.cached}}:null};
}
type Block = {index:number; header:Obj; pieces:Obj[]; started:boolean; done:boolean};
// Chat permits interleaved tool calls. Messages clients expect each block to
// finish before the next one opens, so buffer only blocks waiting their turn.
export class ClientStream {
  private id="resp_"+randomUUID();
  private created=Math.floor(Date.now()/1000);
  private began=false;
  private readonly blocks=new Map<string,Block>();
  private readonly tools=new Map<number,number>();
  private readonly sequence:Block[]=[];
  private head=0;
  private buffered=0;
  constructor(private wire: Exclude<Wire,"responses">, private alias:string,private streamUsage:boolean) {}
  private chat(delta:Obj,finish:unknown=null, usage?:unknown):string {
    return "data: "+JSON.stringify({id:this.id,object:"chat.completion.chunk",created:this.created,model:this.alias,
      choices:usage?[]:[{index:0,delta,finish_reason:finish}],...(usage?{usage}:{})})+"\n\n";
  }
  private block(key:string,header:Obj) {
    let b=this.blocks.get(key);
    if(!b){b={index:this.sequence.length,header,pieces:[],started:false,done:false};this.blocks.set(key,b);this.sequence.push(b);}
    return b;
  }
  private flush() {
    let out="";
    while(this.head<this.sequence.length) {
      const b=this.sequence[this.head]!;
      if(!b.started){out+=frame("content_block_start",{index:b.index,content_block:b.header}).raw;b.started=true;}
      for(const d of b.pieces){out+=frame("content_block_delta",{index:b.index,delta:d}).raw;this.buffered-=JSON.stringify(d).length;}
      b.pieces.length=0;
      if(!b.done) break;
      out+=frame("content_block_stop",{index:b.index}).raw;this.head++;
    }
    return out;
  }
  private push(block:Block,delta:Obj) {
    this.buffered+=JSON.stringify(delta).length;
    if(this.buffered>4*1024*1024) throw new Error("Concurrent content limit exceeded.");
    block.pieces.push(delta);
  }
  convert(e:Obj):string {
    const type=String(e.type),item=object(e.item),r=object(e.response);
    const index=Number(e.output_index??0), part=Number(e.content_index??e.summary_index??0);
    const key=index+"."+part;
    let out="";
    if(!this.began) {
      this.id=String(r.id??this.id);this.created=Number(r.created_at??this.created);this.began=true;
      out=this.wire==="chat"?this.chat({role:"assistant",content:""}):frame("message_start",{message:{
        id:this.id,type:"message",role:"assistant",content:[],model:this.alias,stop_reason:null,stop_sequence:null,
        usage:object(encodeOutput("messages",r,this.alias).usage)}}).raw;
    }
    if(type==="error" || type==="response.failed") {
      const error={type:"api_error",message:"Upstream stream failed."};
      return out+(this.wire==="chat"?"data: "+JSON.stringify({error})+"\n\n":frame("error",{error}).raw);
    }
    if(type==="response.output_item.added" && item.type==="function_call"){
      const n=this.tools.size;this.tools.set(index,n);
      if(this.wire==="chat") out+=this.chat({tool_calls:[{index:n,id:item.call_id,type:"function",function:{name:item.name,arguments:""}}]});
      else this.block(key,{type:"tool_use",id:item.call_id,name:item.name,input:{}});
    }
    if(type==="response.content_part.added" && this.wire==="messages")this.block(key,{type:"text",text:""});
    if(type==="response.reasoning_summary_part.added" && this.wire==="messages")this.block(key,{type:"thinking",thinking:""});
    if(typeof e.delta==="string") {
      const tool=type==="response.function_call_arguments.delta",thinking=type==="response.reasoning_summary_text.delta";
      if(tool || thinking || type==="response.output_text.delta" || type==="response.refusal.delta") {
        if(this.wire==="chat")out+=this.chat(tool?{tool_calls:[{index:this.tools.get(index),function:{arguments:e.delta}}]}:thinking?{reasoning_content:e.delta}:{content:e.delta});
        else {
          const b=this.blocks.get(key)??this.block(key,thinking?{type:"thinking",thinking:""}:{type:"text",text:""});
          this.push(b,tool?{type:"input_json_delta",partial_json:e.delta}:thinking?{type:"thinking_delta",thinking:e.delta}:{type:"text_delta",text:e.delta});
        }
      }
    }
    if(this.wire==="messages" && type==="response.content_part.done"){
      const b=this.blocks.get(key);if(b)b.done=true;
    }
    if(this.wire==="messages" && type==="response.output_item.done"){
      const b=this.blocks.get(key);
      if(item.type==="reasoning" && item.encrypted_content) {
        if(b)this.push(b,{type:"signature_delta",signature:item.encrypted_content});
        else this.block(key,{type:"redacted_thinking",data:item.encrypted_content}).done=true;
      }
      for(const [id,block] of this.blocks)if(id.startsWith(index+"."))block.done=true;
    }
    if(this.wire==="messages")out+=this.flush();
    if(type==="response.completed" || type==="response.incomplete") {
      const final=encodeOutput(this.wire,r,this.alias);
      if(this.wire==="chat") {
        const choice=object((final.choices as Obj[])[0]);
        out+=this.chat({},choice.finish_reason);
        if(this.streamUsage && final.usage) out+=this.chat({},null,final.usage);
        out+="data: [DONE]\n\n";
      } else {
        for(const b of this.blocks.values())b.done=true;
        out+=this.flush()+frame("message_delta",{delta:{stop_reason:final.stop_reason,stop_sequence:null},usage:final.usage}).raw+frame("message_stop",{}).raw;
      }
    }
    return out;
  }
}
