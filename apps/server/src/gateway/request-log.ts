import {randomUUID} from "node:crypto";
import type {ServerContext} from "../app.js";
import {encryptSecret} from "../security/crypto.js";

export interface GatewayRequestRecord {
  request_id:string;source_type:string;virtual_model:string;inbound_protocol:string;status_code:number;
  api_key_id?:string|null;thread_id?:string|null;provider_id?:string|null;actual_model?:string|null;outbound_protocol?:string|null;
  failover_chain?:unknown[];error_summary?:string|null;ttft_ms?:number|null;total_ms?:number|null;tokens_per_sec?:number|null;
  input_tokens?:number;output_tokens?:number;cached_tokens?:number|null;cost_estimate?:number;currency?:string|null;
}
export function debugState(ctx:ServerContext) {
  const expiry=Number(ctx.native.prepare("SELECT value FROM settings WHERE key='gateway.debug.until'").pluck().get());
  return {enabled:expiry>Date.now(),expires_at:expiry>Date.now()?new Date(expiry).toISOString():null};
}
function safeCapture(ctx:ServerContext,value:unknown):string {
  const json=JSON.stringify(ctx.masker.maskObject(value),(key,item)=>
    /^(authorization|proxy-authorization|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|password|cookie|set-cookie|secret)$/i.test(key)?"[REDACTED]":item)??"null";
  return json.length>65536?JSON.stringify({truncated:true,preview:json.slice(0,65000)}):json;
}
export function recordGatewayRequest(ctx:ServerContext,data:GatewayRequestRecord,debug?:unknown) {
  const log=ctx.masker.maskObject(data) as GatewayRequestRecord;
  const cost=log.cost_estimate??0,now=new Date().toISOString();
  const payload=debug!==undefined && debugState(ctx).enabled?encryptSecret(safeCapture(ctx,debug),ctx.masterKey):null;
  ctx.native.transaction(()=>{
    const inserted=ctx.native.prepare(`INSERT INTO gateway_request_logs (id,request_id,source_type,api_key_id,thread_id,virtual_model,provider_id,actual_model,inbound_protocol,outbound_protocol,failover_chain_json,status_code,error_summary,ttft_ms,total_ms,tokens_per_sec,input_tokens,output_tokens,cached_tokens,cost_estimate,currency,debug_payload_enc,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(request_id) DO NOTHING`).run(randomUUID(),log.request_id,log.source_type,log.api_key_id??null,log.thread_id??null,log.virtual_model,log.provider_id??null,log.actual_model??null,log.inbound_protocol,log.outbound_protocol??null,JSON.stringify(log.failover_chain??[]),
      log.status_code,log.error_summary?.slice(0,512)??null,log.ttft_ms??null,log.total_ms??null,log.tokens_per_sec??null,log.input_tokens??0,log.output_tokens??0,log.cached_tokens??null,cost,log.currency??null,payload,now);
    if(!inserted.changes) return;
    if(cost>0 && log.currency) {
      const increment=ctx.native.prepare("INSERT INTO gateway_budget_usage(day,owner_type,owner_id,currency,amount) VALUES(?,?,?,?,?) ON CONFLICT(owner_type,owner_id,currency,day) DO UPDATE SET amount=amount+excluded.amount");
      if(log.provider_id) increment.run(now.slice(0,10),"provider",log.provider_id,log.currency,cost);
      if(log.api_key_id) increment.run(now.slice(0,10),"key",log.api_key_id,log.currency,cost);
    }
    const setting=ctx.native.prepare("SELECT value FROM settings WHERE key=?").pluck();
    const days=Math.max(1,Math.min(365,Number(setting.get("gateway.log.days"))||30));
    const count=Math.max(1,Math.min(100000,Number(setting.get("gateway.log.count"))||10000));
    ctx.native.prepare("DELETE FROM gateway_request_logs WHERE created_at<?").run(new Date(Date.now()-days*86400000).toISOString());
    ctx.native.prepare("DELETE FROM gateway_request_logs WHERE rowid IN (SELECT rowid FROM gateway_request_logs ORDER BY created_at DESC,id LIMIT -1 OFFSET ?)").run(count);
  })();
}
