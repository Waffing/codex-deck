import {randomUUID} from "node:crypto";
import type {ServerContext} from "../app.js";
import {signPayload} from "../security/crypto.js";

export const qualityError=(statusCode:number,message:string)=>Object.assign(new Error(message),{statusCode});

export async function qualityModelText(ctx:ServerContext, port:number, threadId:string, model:string,
  purpose:"review"|"compaction"|"handoff", instructions:string, input:string, maxTokens:number, turnId?:string) {
  const now=Math.floor(Date.now()/1000);
  const token=signPayload({aud:"codexdeck-internal",thread_id:threadId,purpose,model_alias:model,
    ...(turnId && {review_turn_id:turnId}),iat:now,exp:now+60,nonce:randomUUID()},ctx.masterKey);
  const response=await fetch("http://127.0.0.1:"+port+"/internal/v1/responses",{method:"POST",redirect:"error",
    headers:{"Content-Type":"application/json",authorization:"Bearer "+token},
    body:JSON.stringify({model,instructions,input:ctx.masker.maskString(input),stream:false,max_output_tokens:maxTokens}),
    signal:AbortSignal.timeout(ctx.gatewayConfig.upstream_timeout_ms+2000)});
  if(!response.ok) {await response.body?.cancel();throw qualityError(502,"Model request failed (HTTP "+response.status+").");}
  const result=await response.json() as {status?:string;output?:{type?:string;content?:{type?:string;text?:string}[]}[]};
  const answer=result.output?.filter(i=>i.type==="message").flatMap(i=>i.content??[]).filter(i=>i.type==="output_text").map(i=>i.text??"").join("\n").trim();
  if(result.status!=="completed" || !answer || answer.length>64000) throw qualityError(502,"Incomplete model response.");
  return ctx.masker.maskString(answer);
}
