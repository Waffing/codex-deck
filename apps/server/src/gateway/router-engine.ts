import type {ServerContext} from "../app.js";
import {type RoutingProfile,routingProfileSchema} from "@codexdeck/shared";
import {randomUUID} from "node:crypto";

type RouteRow=Omit<RoutingProfile,"targets"|"enabled"|"is_global_default"> & {targets_json:string;enabled:number;is_global_default:number};
function dto(row:RouteRow):RoutingProfile {
  const {targets_json,enabled,is_global_default,...rest}=row;
  return {...rest,targets:JSON.parse(targets_json),enabled:!!enabled,is_global_default:!!is_global_default};
}
export function profiles(ctx:ServerContext) {
  return (ctx.native.prepare("SELECT * FROM routing_profiles ORDER BY created_at,id").all() as RouteRow[]).map(dto);
}
export function saveProfile(ctx:ServerContext,input:unknown,id?:string) {
  const existing=id ? ctx.native.prepare("SELECT * FROM routing_profiles WHERE id=?").get(id) as RouteRow|undefined : undefined;
  if(id && !existing) throw Object.assign(new Error("Unknown routing profile."),{statusCode:404});
  const parsed=routingProfileSchema.safeParse(existing?{...dto(existing),...input as object}:input);
  if(!parsed.success) throw Object.assign(new Error("Invalid routing profile."),{statusCode:400});
  const p=parsed.data,db=ctx.native;
  if(p.is_global_default && !p.enabled) throw Object.assign(new Error('Default route must be enabled.'),{statusCode:400});
  const ids=new Set(p.targets.map(t=>t.model_id));
  if(ids.size!==p.targets.length || p.active_target_index>=p.targets.length || [...ids].some(mid=>!db.prepare("SELECT 1 FROM models WHERE id=?").get(mid)))
    throw Object.assign(new Error("Invalid routing targets."),{statusCode:400});
  if(db.prepare("SELECT 1 FROM models WHERE alias=?").get(p.slug) || db.prepare("SELECT 1 FROM routing_profiles WHERE slug=? AND id<>?").get(p.slug,id??""))
    throw Object.assign(new Error("Alias already in use."),{statusCode:409});
  const now=new Date().toISOString(),rid=id??randomUUID();
  return db.transaction(()=>{
    if(p.is_global_default) db.prepare("UPDATE routing_profiles SET is_global_default=0 WHERE is_global_default=1").run();
    db.prepare(`INSERT INTO routing_profiles VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET slug=excluded.slug,name=excluded.name,
        description=excluded.description,strategy=excluded.strategy,targets_json=excluded.targets_json,active_target_index=excluded.active_target_index,
        is_global_default=excluded.is_global_default,enabled=excluded.enabled,updated_at=excluded.updated_at`)
      .run(rid,p.slug,p.name,p.description,p.strategy,JSON.stringify(p.targets),p.active_target_index,+p.is_global_default,+p.enabled,existing?.created_at??now,now);
    return dto(db.prepare("SELECT * FROM routing_profiles WHERE id=?").get(rid) as RouteRow);
  }).immediate();
}
const scores=new WeakMap<ServerContext,Map<string,Map<string,number>>>();
export function routeModelIds(ctx:ServerContext,alias:string):string[] {
  const row=ctx.native.prepare("SELECT * FROM routing_profiles WHERE slug=? AND enabled=1").get(alias) as RouteRow|undefined;
  if(!row){
    const model=ctx.native.prepare("SELECT id,fallback_model_ids_json FROM models WHERE alias=? AND enabled=1").get(alias) as {id:string;fallback_model_ids_json:string}|undefined;
    return model?[...new Set<string>([model.id,...JSON.parse(model.fallback_model_ids_json)])]:[];
  }
  const p=dto(row);
  if(p.strategy==="pinned") return [p.targets[p.active_target_index].model_id];
  const lookup=ctx.native.prepare(`SELECT p.weight,COALESCE((SELECT g.ttft_ms FROM gateway_request_logs g WHERE g.provider_id=p.id AND g.actual_model=m.model_id AND g.status_code BETWEEN 200 AND 299 AND g.ttft_ms IS NOT NULL ORDER BY created_at DESC LIMIT 1),json_extract(m.last_benchmark_json,'$.ttft_ms')) AS latency FROM models m JOIN providers p ON p.id=m.provider_id WHERE m.id=? AND m.enabled=1 AND p.enabled=1`);
  const targets=p.targets.flatMap(t=>{
    const data=lookup.get(t.model_id) as {weight:number;latency:number|null}|undefined;
    return data?[{id:t.model_id,weight:t.weight??data.weight,latency:data.latency??Infinity}]:[];
  });
  if(p.strategy==="lowest_latency") targets.sort((a,b)=>a.latency-b.latency);
  if(p.strategy==="weighted_rr" && targets.length){
    const groups=scores.get(ctx)??new Map();scores.set(ctx,groups);
    const state=groups.get(p.id)??new Map<string,number>();groups.set(p.id,state);
    for(const t of targets) state.set(t.id,(state.get(t.id)??0)+t.weight);
    targets.sort((a,b)=>state.get(b.id)!-state.get(a.id)!);
    const first=targets[0].id;state.set(first,state.get(first)!-targets.reduce((sum,t)=>sum+t.weight,0));
  }
  return targets.map(t=>t.id);
}
export function listRoutableModels(ctx:ServerContext) {
  return ctx.native.prepare("SELECT m.alias FROM models m JOIN providers p ON m.provider_id=p.id WHERE m.enabled=1 AND p.enabled=1 UNION SELECT slug FROM routing_profiles WHERE enabled=1 ORDER BY 1").pluck().all() as string[];
}
