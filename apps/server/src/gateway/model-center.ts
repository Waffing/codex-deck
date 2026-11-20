import { randomUUID } from "node:crypto";
import type { BenchmarkResult, ProviderBalance } from "@codexdeck/shared";
import { discoveredModelSchema } from "@codexdeck/shared";
import type { ServerContext } from "../app.js";
import type { models, providers } from "../db/schema.js";
import { usageLogs } from "../db/schema.js";
import { decryptSecret } from "../security/crypto.js";
import { withProviderKey } from "./credentials.js";
import { estimateUsageCost,OutputTiming } from "./metrics.js";
import { readSse } from "./sse.js";
import { upstreamFetch } from "./transport.js";
import { upstreamHeaders, upstreamUrl } from "./upstream.js";
import { toChatRequest } from "./transforms.js";

type ProviderRow=typeof providers.$inferSelect;
type ModelRow=typeof models.$inferSelect;
type Dict=Record<string,unknown>;
const record=(value:unknown):Dict=>value && typeof value==="object" && !Array.isArray(value)?value as Dict:{};
const number=(value:unknown)=>typeof value==="number" && Number.isFinite(value)?value:null;

async function readJson(response:Response):Promise<Dict> {
  if(!response.body) throw new Error("Empty upstream response.");
  const reader=response.body.getReader();
  let bytes=0;
  const chunks:Uint8Array[]=[];
  try {
    for(;;) {
      const {value,done}=await reader.read();
      if(done) break;
      bytes+=value.length;
      if(bytes>4_194_304) throw new Error("Upstream response is too large.");
      chunks.push(value);
    }
    return record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } finally { await reader.cancel(); reader.releaseLock(); }
}

function inference(provider:ProviderRow,context:ServerContext,boundPort?:number) {
  const signal=AbortSignal.timeout(Math.min(30000,context.gatewayConfig.upstream_timeout_ms));
  return (endpoint:string,body?:object)=>withProviderKey(provider,context,(key,headers)=>
    upstreamFetch(upstreamUrl(provider.baseUrl,endpoint),{method:body?"POST":"GET",signal,
      body:body?JSON.stringify(body):undefined,headers:upstreamHeaders(headers,key)},
    !!key || Object.values(headers).some(Boolean),[boundPort,context.gatewayConfig.port]));
}

export async function discoverModels(provider:ProviderRow,context:ServerContext,boundPort?:number) {
  const response=await inference(provider,context,boundPort)("models");
  if(!response.ok) { await response.body?.cancel(); throw new Error(`Model discovery returned HTTP ${response.status}.`); }
  const {data}=await readJson(response);
  if(!Array.isArray(data)) throw new Error("Invalid upstream model list.");
  const unique=new Map<string,ReturnType<typeof discoveredModelSchema.parse>>();
  for(const raw of data) {
    const item=record(raw);
    if(typeof item.id!=="string" || unique.has(item.id)) continue;
    const architecture=record(item.architecture);
    const meta=number(item.context_length??item.context_window??record(item.top_provider).context_length);
    const hint=/(?:^|[-_:])(\d{1,4})([km])(?:$|[-_:])/i.exec(item.id);
    const inferred=hint ? Number(hint[1])*(hint[2].toLowerCase()==="m"?1_000_000:1000):128000;
    const tags=new Set<string>();
    if(Array.isArray(architecture.input_modalities) && architecture.input_modalities.includes("image")) tags.add("vision");
    if(Array.isArray(item.supported_parameters) && item.supported_parameters.includes("tools")) tags.add("tools");
    if(item.supports_reasoning_summaries===true) tags.add("reasoning_summary");
    for(const tag of ["responses","chat","tools","vision","reasoning","reasoning_summary"]) {
      if(Array.isArray(item.capabilities) && item.capabilities.includes(tag) || record(item.capabilities)[tag]===true) tags.add(tag);
    }
    const upstreamWindow=meta!==null && Number.isSafeInteger(meta) && meta>0 && meta<=2147483647;
    const entry=discoveredModelSchema.safeParse({model_id:item.id,context_window:upstreamWindow?meta:inferred,context_source:upstreamWindow?"upstream":"inferred",capabilities:[...tags]});
    if(entry.success) unique.set(item.id,entry.data);
  }
  return {models:[...unique.values()]};
}

export function balanceUrl(base:string,endpoint:string) {
  const url=new URL(endpoint,base);
  if (!["http:","https:"].includes(url.protocol) || url.origin!==new URL(base).origin || url.username || url.password || url.search || url.hash) {
    throw Object.assign(new Error("Balance endpoint must be a same-origin path without credentials, query or fragment."),{statusCode:400});
  }
  return url;
}

export async function fetchBalance(provider:ProviderRow,ctx:ServerContext,boundPort?:number):Promise<ProviderBalance> {
  const previous=provider.lastBalanceJson ? JSON.parse(provider.lastBalanceJson) as ProviderBalance : null;
  const now=new Date().toISOString();
  const result:ProviderBalance={checked_at:now,balance_at:previous?.balance_at??null,amount:previous?.amount??null,unit:previous?.unit??null,status:"unsupported"};
  const endpoint=provider.balanceEndpoint??({openrouter:"/api/v1/credits",oneapi_newapi:"/api/user/self"} as Record<string,string>)[provider.preset];
  if(!endpoint) return result;
  try {
    const url=balanceUrl(provider.baseUrl,endpoint);
    const token=provider.balanceTokenEnc?decryptSecret(provider.balanceTokenEnc,ctx.masterKey):"";
    const headers=upstreamHeaders({},token);
    if(provider.balanceUserId) headers.set("New-Api-User",provider.balanceUserId);
    const response=await upstreamFetch(url,{method:"GET",headers,signal:AbortSignal.timeout(Math.min(8000,ctx.gatewayConfig.upstream_timeout_ms))},
      !!token,[boundPort,ctx.gatewayConfig.port]);
    if(!response.ok) {
      await response.body?.cancel();
      return {...result,status:[401,403].includes(response.status)?"unauthorized":[404,405].includes(response.status)?"unsupported":"error",error:`HTTP ${response.status}`};
    }
    const json=await readJson(response);
    if(json.success===false) return {...result,status:"error",error:"Upstream rejected balance lookup."};
    const data=record(json.data??json);
    const total=number(data.total_credits),usage=number(data.total_usage);
    let amount=number(data.balance??data.remaining??data.amount);
    let unit=typeof data.currency==="string" && /^[A-Za-z]{3}$/.test(data.currency)?data.currency.toUpperCase():"credits";
    if(total!==null && usage!==null) { amount=total-usage; unit="USD"; }
    else if(number(data.quota)!==null) {amount=number(data.quota);unit="quota";}
    if(amount===null) return {...result,status:"unsupported",error:"Unrecognized balance format."};
    return {checked_at:now,balance_at:now,status:"ok",amount,unit};
  } catch { return {...result,status:"error",error:"Balance endpoint unavailable or invalid."}; }
}

export async function benchmarkModel(model:ModelRow,provider:ProviderRow,context:ServerContext,limit:1|32,boundPort?:number):Promise<BenchmarkResult> {
  const started=performance.now(), timing=new OutputTiming(started);
  const result:BenchmarkResult={model_id:model.id,ttft_ms:null,tokens_per_sec:null,sample_tokens:limit,output_tokens:null,status:"failed",tested_at:new Date().toISOString()};
  let output:number|null=null,input:number|null=null,cached:number|null=null,status=502;
  try {
    const probe=inference(provider,context,boundPort);
    const caps=model.lastProbeJson ? JSON.parse(model.lastProbeJson).capabilities : {};
    let chat=JSON.parse(provider.quirksJson).force_chat || model.protocol==="chat" || model.protocol==="auto" && caps.chat && !caps.responses;
    const prompt=limit===1?"Answer 1.":"Count from 1 to 100 separated by spaces.";
    const budget=Math.min(model.maxOutputTokens,limit);
    const request={model:model.modelId,input:prompt,stream:true,max_output_tokens:budget};
    const call=()=>chat?probe("chat/completions",toChatRequest(request,model.modelId)):probe("responses",request);
    let response=await call();
    if(model.protocol==="auto" && !chat && [404,405].includes(response.status)) {await response.body?.cancel();chat=true;response=await call();}
    if(!response.ok || !response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
      status=response.ok?502:response.status;
      await response.body?.cancel(); result.error=`Upstream HTTP ${response.status} or unsupported stream.`; return result;
    }
    let terminal:"completed"|"failed"|undefined;
    for await(const frame of readSse(response.body)) {
      if(!frame.data || frame.data==="[DONE]") continue;
      const chunk=JSON.parse(frame.data);
      if(chunk.error || ["error","response.failed"].includes(chunk.type)) throw new Error();
      if(chat) {
        const reason=chunk.choices?.[0]?.finish_reason;
        if(reason) terminal=reason==="stop" || reason==="length" ? "completed":"failed";
      } else if(chunk.type==="response.incomplete") {
        terminal=chunk.response?.incomplete_details?.reason==="max_output_tokens" ? "completed":"failed";
      } else if(chunk.type==="response.completed" && chunk.response && (!chunk.response.status || chunk.response.status==="completed")) terminal="completed";
      timing.delta(chat?chunk.choices?.[0]?.delta?.content:chunk.type==="response.output_text.delta"?chunk.delta:null);
      const usage=chat?chunk.usage:chunk.response?.usage;
      if(usage) {
        output=number(chat?usage.completion_tokens:usage.output_tokens);input=number(chat?usage.prompt_tokens:usage.input_tokens);
        cached=number(chat?usage.prompt_tokens_details?.cached_tokens??usage.prompt_cache_hit_tokens:usage.input_tokens_details?.cached_tokens);
      }
    }
    if(terminal!=="completed" || (timing.ttft===null && !(output!==null && Number.isSafeInteger(output) && output>0))) {
      result.error=terminal==="failed"?"Upstream did not complete the generation.":"No measured or completed generation sample.";
      return result;
    }
    result.status="ok";status=200;result.ttft_ms=timing.ttft;result.tokens_per_sec=limit>1?timing.speed(output??0):null;
  } catch { result.error="Benchmark connection, stream or timeout error."; }
  finally {
    const valid=(n:number|null)=>n!==null && Number.isSafeInteger(n) && n>=0;
    result.output_tokens=valid(output)?output:null;
    const inTokens=valid(input)?input!:0,outTokens=valid(output)?output!:0;
    const hit=valid(cached) && cached!<=inTokens?cached:null;
    context.orm.insert(usageLogs).values({id:randomUUID(),modelId:model.id,providerId:provider.id,requestedAlias:context.masker.maskString(model.alias),inputTokens:inTokens,outputTokens:outTokens,
      ...estimateUsageCost(model,inTokens,outTokens,hit),cachedInputTokens:hit,usageKnown:valid(input)&&valid(output),ttftMs:result.ttft_ms,tokensPerSec:result.tokens_per_sec,
      statusCode:status,latencyMs:Math.round(performance.now()-started),error:result.error,createdAt:result.tested_at}).run();
    context.onUsageRecorded?.();
  }
  return result;
}
