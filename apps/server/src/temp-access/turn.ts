import {randomUUID} from "node:crypto";
import {guestTools,guestToolDefinitions} from "@codexdeck/shared";
import {signPayload} from "../security/crypto.js";
import type {ServerContext} from "../app.js";
import type {ApprovalEngine,EventSink} from "../codex/approval.js";
import {readEditable,writeEditable} from "../files/editor.js";
import {getLink,deny,onLinkChange} from "./service.js";
import {securityEvent} from "../security/activity.js";

type TurnOptions={linkId:string;thread:string;task:string;workspace:string;root:string;port:number;model:string;input:unknown[];
  signal:AbortSignal;approvals:ApprovalEngine;events:EventSink};

/** Guests use only workspace-scoped server tools. A shared shell process would inherit the host's read permissions. */
export async function runGuestTurn(ctx:ServerContext,o:TurnOptions) {
  const controller=new AbortController();
  const validate=()=>{
    const l=getLink(ctx,o.linkId);
    if(l.status!=="active" || !l.workspace_ids.includes(o.workspace) || l.permission==="readonly") throw deny("Invitation is no longer active.");
    return l;
  };
  const initial=validate();
  const stopIfInvalid=()=>{
    const status=getLink(ctx,o.linkId).status;
    if(status==="expired" || status==="revoked") controller.abort();
    if(status!=="active") o.approvals.disconnect(o.thread);
  };
  const off=onLinkChange(ctx,o.linkId,stopIfInvalid);
  const shutdown=()=>o.approvals.disconnect(o.thread);
  o.signal.addEventListener("abort",shutdown,{once:true});
  const poll=setInterval(stopIfInvalid,500);poll.unref();
  const signal=AbortSignal.any([o.signal,controller.signal]);
  const history=ctx.native.prepare(`SELECT prompt,coalesce(answer_markdown,summary) answer FROM tasks
    WHERE thread_id=? AND id<>? AND status='completed' ORDER BY rowid DESC LIMIT 8`).all(o.thread,o.task) as {prompt:string;answer:string}[];
  const input:unknown[]=history.reverse().flatMap(h=>[{role:"user",content:h.prompt.slice(-4000)},{role:"assistant",content:h.answer.slice(-8000)}]);
  input.push({role:"user",content:o.input});
  const tools=guestToolDefinitions.filter(t=>t.name==="read_file" || initial.permission==="full_with_approval");
  const request=async(path:string,body:unknown)=>{
    const ops=path.startsWith("/internal/ops/");
    const now=Math.floor(Date.now()/1000),token=signPayload({aud:ops?"codexdeck-ops":"codexdeck-internal",iat:now,
      exp:now+Math.min(60,ctx.gatewayConfig.internal_token_ttl_seconds),nonce:randomUUID(),task_id:o.task,thread_id:o.thread},ctx.masterKey);
    // Approval for staging can outlive the inference timeout; the operation rechecks task and guest status before acting.
    const timeout=ops?24*3600000:ctx.gatewayConfig.upstream_timeout_ms+2000;
    const response=await fetch("http://127.0.0.1:"+o.port+path,{method:"POST",redirect:"error",signal:AbortSignal.any([signal,AbortSignal.timeout(timeout)]),
      headers:{authorization:"Bearer "+token,"content-type":"application/json"},body:JSON.stringify(body)});
    if(!response.ok){await response.body?.cancel();throw deny("Guest operation returned HTTP "+response.status,response.status);}
    return response.json();
  };
  try{
    for(let step=0;step<12;step++){
      validate();signal.throwIfAborted();
      const response=await request("/internal/v1/responses",{model:o.model,stream:false,input,tools,max_output_tokens:2048,
        instructions:"Assist with the authorized workspace. Use only the supplied tools. Cite relative paths and report approval decisions accurately."}) as
        {output?:{type:string;name?:string;arguments?:string;call_id?:string;content?:{type:string;text?:string}[]}[]};
      if(!Array.isArray(response.output)) throw deny("Invalid model response.",502);
      const calls=response.output.filter(item=>item.type==="function_call");
      const answer=response.output.flatMap(i=>i.type==="message"?(i.content??[]):[]).filter(p=>p.type==="output_text").map(p=>p.text??"").join("\n");
      if(answer)o.events.append(o.thread,"item/agentMessage/delta",{itemId:randomUUID(),delta:ctx.masker.maskString(answer)},o.task);
      if(!calls.length){if(!answer)throw deny("Model returned no reply.",502);return;}
      for(const call of calls){
        validate();signal.throwIfAborted();
        const name=call.name;
        if(!name || !tools.some(t=>t.name===name) || !call.call_id) throw deny("Unavailable guest tool.");
        let parsed:unknown;
        try{parsed=JSON.parse(call.arguments??"");}catch{throw deny("Invalid tool arguments.",400);}
        let result:unknown;
        if(name==="read_file"){
          const args=guestTools.read_file.parse(parsed),file=await readEditable(o.root,args.path,ctx.masker);
          result={revision:file.revision,content:file.content.slice(0,32000),truncated:file.content.length>32000};
        } else if(name==="write_file"){
          const args=guestTools.write_file.parse(parsed);
          const decision=await o.approvals.request(o.thread,"guest/write_file",args,o.task);
          validate();signal.throwIfAborted();
          if(decision.decision==="approve" || decision.decision==="approve_session")result=await writeEditable(o.root,args.path,args.content,args.revision,ctx.masker);
          else result="Administrator declined the change.";
        } else {
          const args=guestTools.stage_static.parse(parsed);
          result=await request("/internal/ops/app_deploy_staging",{mode:"auto",public_dir:args.public_dir});
        }
        securityEvent(ctx,"guest_tool",o.linkId,null,{thread_id:o.thread,action:name});
        input.push({type:"function_call",call_id:call.call_id,name,arguments:call.arguments},{type:"function_call_output",call_id:call.call_id,output:JSON.stringify(result)});
      }
    }
    throw deny("Guest tool step limit reached.",429);
  }finally{clearInterval(poll);off();o.signal.removeEventListener("abort",shutdown);}
}
