import type {models,providers} from "../db/schema.js";
import {createHash} from "node:crypto";
import type {ServerContext} from "../app.js";

export interface ProxyKey {id:string;allowed_models:string[];rate_limit_rpm:number;tpm_limit:number;daily_budget:number;monthly_budget:number}
export function authenticateProxy(ctx:ServerContext,authorization:string|undefined,scope:string):ProxyKey {
  const match=/^Bearer (cdk_live_[a-zA-Z0-9_-]+)$/.exec(authorization??"");
  const sql="SELECT id,allowed_models_json,scopes_json,rate_limit_rpm,tpm_limit,daily_budget,monthly_budget FROM api_keys WHERE key_hash=? AND revoked_at IS NULL";
  const row=match && ctx.native.prepare(sql).get(createHash("sha256").update(match[1]).digest("hex")) as (ProxyKey&{scopes_json:string;allowed_models_json:string})|undefined;
  if(!row) throw Object.assign(new Error("Invalid API key."),{statusCode:401});
  if(!(JSON.parse(row.scopes_json) as string[]).includes(scope)) throw Object.assign(new Error("Missing proxy scope."),{statusCode:403});
  ctx.masker.register(match![1]);
  return {...row,allowed_models:JSON.parse(row.allowed_models_json)};
}
export function authorizeModel(key:ProxyKey,alias:string) {
  if(!key.allowed_models.includes("*") && !key.allowed_models.includes(alias)) throw Object.assign(new Error("Model not permitted."),{statusCode:403});
}
type Hit={at:number;tokens:number};
const windows=new WeakMap<ServerContext,Map<string,Hit[]>>();
function hits(ctx:ServerContext,id:string,now=Date.now()):Hit[] {
  const map=windows.get(ctx)??new Map<string,Hit[]>();windows.set(ctx,map);
  const entries=(map.get(id)??[]).filter(hit=>now-hit.at<60000);
  map.set(id,entries);
  return entries;
}
function reserve(ctx:ServerContext,id:string,rpm:number,tpm:number,tokens:number) {
  const now=Date.now(),window=hits(ctx,id,now);
  if((rpm>0 && window.length>=rpm)||(tpm>0 && window.reduce((n,h)=>n+h.tokens,tokens)>tpm))
    throw Object.assign(new Error("Gateway rate limit reached."),{statusCode:429,retryAfter:Math.max(1,Math.ceil(((window[0]?.at??now)+60000-now)/1000))});
  const hit={at:now,tokens};window.push(hit);
  const settle=(actual:number)=>{if(Number.isFinite(actual) && actual>=0) hit.tokens=actual;};
  return Object.assign(settle,{resize(total:number){
    const active=hits(ctx,id);
    if(tpm>0 && active.reduce((n,h)=>n+(h===hit?0:h.tokens),total)>tpm)
      throw Object.assign(new Error("Gateway rate limit reached."),{statusCode:429,retryAfter:60});
    hit.tokens=total;
  }});
}
export function budgetUsage(ctx:ServerContext,type:"provider"|"key",id:string) {
  const today=new Date().toISOString().slice(0,10);
  return ctx.native.prepare("SELECT currency,SUM(CASE WHEN day=? THEN amount ELSE 0 END) AS daily_used,SUM(amount) AS monthly_used FROM gateway_budget_usage WHERE owner_type=? AND owner_id=? AND day>=? GROUP BY currency")
    .all(today,type,id,today.slice(0,7)+"-01") as {currency:string;daily_used:number;monthly_used:number}[];
}
function checkBudget(ctx:ServerContext,type:"provider"|"key",id:string,daily:number,monthly:number,block:boolean) {
  if(!daily && !monthly) return;
  for(const row of budgetUsage(ctx,type,id)) {
    const hit=daily>0 && row.daily_used>=daily?"day":monthly>0 && row.monthly_used>=monthly?"month":null;
    if(!hit) continue;
    const now=new Date(),until=hit==="day"?Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()+1):Date.UTC(now.getUTCFullYear(),now.getUTCMonth()+1,1);
    if(block) throw Object.assign(new Error("Gateway budget reached."),{statusCode:429,retryAfter:Math.max(1,Math.ceil((until-now.getTime())/1000))});
    const eventKey=["quota.alert",type,id,row.currency,hit,now.toISOString().slice(0,hit==="day"?10:7)].join(".");
    const inserted=ctx.native.prepare("INSERT OR IGNORE INTO settings(key,value,updated_at) VALUES(?,'1',?)").run(eventKey,now.toISOString());
    if(inserted.changes) void ctx.notifySecurity?.("budget_alert",{owner_type:type,owner_id:id,period:hit,...row}).catch(()=>{});
  }
}
export function reserveKeyQuota(ctx:ServerContext,key:ProxyKey,inputTokens:number,maxOutput:number) {
  checkBudget(ctx,"key",key.id,key.daily_budget,key.monthly_budget,true);
  return reserve(ctx,"key:"+key.id,key.rate_limit_rpm,key.tpm_limit,inputTokens+maxOutput);
}
export function reserveProviderQuota(ctx:ServerContext,id:string) {
  const p=ctx.native.prepare("SELECT rpm_limit,daily_budget,monthly_budget,budget_action FROM providers WHERE id=?").get(id) as {rpm_limit:number;daily_budget:number;monthly_budget:number;budget_action:string};
  checkBudget(ctx,"provider",id,p.daily_budget,p.monthly_budget,p.budget_action==="block");
  reserve(ctx,"provider:"+id,p.rpm_limit,0,0);
}
const pendingCost=new WeakMap<ServerContext,Map<string,number>>();
export function reserveCost(ctx:ServerContext,model:typeof models.$inferSelect,provider:typeof providers.$inferSelect,
  key:ProxyKey|undefined,inputUpperBound:number,maxOutput:number) {
  const limits:{type:"provider"|"key";id:string;day:number;month:number}[]=[];
  if(key && (key.daily_budget||key.monthly_budget))limits.push({type:"key",id:key.id,day:key.daily_budget,month:key.monthly_budget});
  if(provider.budgetAction==="block" && (provider.dailyBudget||provider.monthlyBudget))limits.push({type:"provider",id:provider.id,day:provider.dailyBudget,month:provider.monthlyBudget});
  if(!limits.length)return {upper:0,release(){}};
  const cny=model.pricingCurrency==="CNY";
  const inputRate=Math.max(cny?model.costInputCnyPerMillion:model.costInputUsdPerMillion,model.cacheReadPricePer1m);
  const outputRate=cny?model.costOutputCnyPerMillion:model.costOutputUsdPerMillion;
  if(!inputRate && !outputRate && !model.confirmedFree)
    throw Object.assign(new Error("A hard budget requires model pricing or a confirmed-free model."),{statusCode:429,retryAfter:60});
  const upper=(inputUpperBound*inputRate+maxOutput*outputRate)/1000000;
  const reservations=pendingCost.get(ctx)??new Map<string,number>();pendingCost.set(ctx,reservations);
  const identifiers=limits.map(l=>[l.type,l.id,model.pricingCurrency].join(":"));
  for(const [i,l] of limits.entries()){
    const spent=budgetUsage(ctx,l.type,l.id).find(u=>u.currency===model.pricingCurrency);
    const total=upper+(reservations.get(identifiers[i])??0);
    if((l.day>0&&(spent?.daily_used??0)+total>l.day)||(l.month>0&&(spent?.monthly_used??0)+total>l.month))
      throw Object.assign(new Error("Insufficient remaining gateway budget for this request."),{statusCode:429,retryAfter:60});
  }
  for(const id of identifiers)reservations.set(id,(reservations.get(id)??0)+upper);
  let released=false;
  return {upper,release(){
    if(released)return;released=true;
    for(const id of identifiers){
      const left=(reservations.get(id)??0)-upper;if(left>1e-12)reservations.set(id,left);else reservations.delete(id);
    }
  }};
}
export function quotaOverview(ctx:ServerContext) {
  function rows(type:"provider"|"key",sql:string) {
    return (ctx.native.prepare(sql).all() as {id:string}[]).map(row=>{
      const window=hits(ctx,type+":"+row.id);
      return {...row,rpm:window.length,tpm:window.reduce((sum,h)=>sum+h.tokens,0),usage:budgetUsage(ctx,type,row.id)};
    });
  }
  return {keys:rows("key","SELECT id,name,rate_limit_rpm AS rpm_limit,tpm_limit,daily_budget,monthly_budget FROM api_keys WHERE revoked_at IS NULL"),
    providers:rows("provider","SELECT id,name,rpm_limit,daily_budget,monthly_budget,budget_action FROM providers")};
}
