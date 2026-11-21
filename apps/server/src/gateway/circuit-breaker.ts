import type {ServerContext} from "../app.js";

export type Circuit={state:"closed"|"open"|"half_open";opened_at:number|null;consecutive_failures:number;failure_threshold:number;cooldown_seconds:number};
export function readCircuit(ctx:ServerContext,id:string):Circuit {
  const raw=ctx.native.prepare("SELECT circuit_breaker_json FROM providers WHERE id=?").pluck().get(id);
  if(typeof raw!=="string") throw Object.assign(new Error("Unknown provider."),{statusCode:404});
  return {state:"closed",opened_at:null,consecutive_failures:0,failure_threshold:3,cooldown_seconds:30,...JSON.parse(raw)};
}
function save(ctx:ServerContext,id:string,c:Circuit) {
  ctx.native.prepare("UPDATE providers SET circuit_breaker_json=? WHERE id=?").run(JSON.stringify(c),id);
}
// Each closed generation shares a token. Opening or resetting invalidates late completions.
const leases=new WeakMap<ServerContext,Map<string,symbol>>();
function providerLeases(ctx:ServerContext) {
  let map=leases.get(ctx);
  if(!map) {map=new Map();leases.set(ctx,map);}
  return map;
}
export function resetCircuit(ctx:ServerContext,id:string){
  const c=readCircuit(ctx,id);
  save(ctx,id,{...c,state:"closed",opened_at:null,consecutive_failures:0});
  providerLeases(ctx).delete(id);
}
export function acquireCircuit(ctx:ServerContext,id:string):symbol|null {
  return ctx.native.transaction(()=>{
    const c=readCircuit(ctx,id);
    const map=providerLeases(ctx),current=map.get(id);
    if(c.state==="closed" && current) return current;
    if(c.state!=="closed"){
      if(c.state==="half_open" && current) return null;
      if(Date.now()-(c.opened_at??0)<c.cooldown_seconds*1000) return null;
      save(ctx,id,{...c,state:"half_open",opened_at:Date.now()});
    }
    const token=Symbol();map.set(id,token);return token;
  }).immediate();
}
export function finishCircuit(ctx:ServerContext,id:string,status:number,lease:symbol) {
  ctx.native.transaction(()=>{
    const c=readCircuit(ctx,id);
    ctx.native.prepare("INSERT INTO gateway_provider_attempts(provider_id,status_code) VALUES(?,?)").run(id,status);
    ctx.native.prepare("DELETE FROM gateway_provider_attempts WHERE provider_id=? AND id < (SELECT id FROM gateway_provider_attempts WHERE provider_id=? ORDER BY id DESC LIMIT 1 OFFSET 19)").run(id,id);
    const map=providerLeases(ctx);
    if(c.state==="open" || map.get(id)!==lease) return;
    const failed=status>=500 || [401,403,408,429].includes(status);
    const failures=failed?c.consecutive_failures+1:0;
    const opened=failed && (c.state==="half_open" || failures>=c.failure_threshold);
    save(ctx,id,{...c,state:opened?"open":"closed",opened_at:opened?Date.now():null,consecutive_failures:failures});
    if(opened || c.state==="half_open") map.delete(id);
  }).immediate();
}
