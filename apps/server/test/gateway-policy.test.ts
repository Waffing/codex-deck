import Database from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {randomBytes} from "node:crypto";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {type ServerContext,createServer,parseGatewayConfig} from "../src/app.js";
import {runMigrations} from "../src/db/migrations.js";
import {schema} from "../src/db/schema.js";
import {SecretMasker} from "../src/security/secret-masker.js";
import {installationCode} from "../src/routes/auth.js";
import {acquireCircuit,finishCircuit,readCircuit,resetCircuit} from "../src/gateway/circuit-breaker.js";
import {reserveCost,reserveKeyQuota,reserveProviderQuota} from "../src/gateway/quota.js";
import {recordGatewayRequest} from "../src/gateway/request-log.js";
import {routeModelIds} from "../src/gateway/router-engine.js";
import {readPool} from "../src/gateway/credentials.js";
import {importBundle} from "../src/gateway/config-bundle.js";
import {patchRequest} from "../src/gateway/patch-pipeline.js";

function context():ServerContext {
  const native=new Database(":memory:");native.pragma("foreign_keys=ON");runMigrations(native);runMigrations(native);
  return {native,orm:drizzle(native,{schema}),masterKey:randomBytes(32),masker:new SecretMasker(),gatewayConfig:parseGatewayConfig()};
}
let ctx:ServerContext,app:ReturnType<typeof createServer>,cookie:string,providerId:string,first:string,second:string;
const secret="fixture-"+randomBytes(16).toString("hex");
function send(method:"GET"|"POST"|"PATCH",url:string,payload?:Record<string,unknown>){
  return app.inject({method,url,headers:{cookie},payload});
}
beforeEach(async()=>{
  ctx=context();app=createServer(ctx);
  const auth=await app.inject({method:"POST",url:"/api/auth/setup",payload:{setup_code:installationCode(ctx.native,ctx.masterKey),password:"FixturePassword1-for-test"}});
  cookie=String(auth.headers["set-cookie"]).split(";")[0];
  const provider=await send("POST","/api/providers",{name:"Demo",preset:"custom",base_url:"http://127.0.0.1:12345/v1",api_keys:[secret],daily_budget:1,budget_action:"block",circuit_breaker:{failure_threshold:2,cooldown_seconds:1}});
  expect(provider.statusCode).toBe(201);providerId=provider.json().id;
  first=(await send("POST","/api/models",{provider_id:providerId,alias:"fast",model_id:"one"})).json().id;
  second=(await send("POST","/api/models",{provider_id:providerId,alias:"slow",model_id:"two"})).json().id;
});
afterEach(async()=>{await app.close();ctx.native.close();});
it("switches routes without restarting and applies ordered failover and weighted rotation",async()=>{
  const created=await send("POST","/api/routing-profiles",{slug:"switch",name:"Switch",is_global_default:true,targets:[{model_id:first,weight:3},{model_id:second,weight:1}]});
  expect(created.statusCode).toBe(201);
  expect(routeModelIds(ctx,"switch")).toEqual([first]);
  const url="/api/routing-profiles/"+created.json().id+"/switch";
  expect((await send("POST",url,{active_target_index:1})).statusCode).toBe(200);
  expect(routeModelIds(ctx,"switch")).toEqual([second]);
  await send("POST",url,{strategy:"priority_failover"});expect(routeModelIds(ctx,"switch")).toEqual([first,second]);
  await send("POST",url,{strategy:"weighted_rr"});expect(Array.from({length:8},()=>routeModelIds(ctx,"switch")[0]).filter(id=>id===first)).toHaveLength(6);
  expect((await send("POST","/api/models",{provider_id:providerId,alias:"switch",model_id:"conflict"})).statusCode).toBe(409);
});
it("leases exactly one half-open probe and retains real provider attempts",async()=>{
  const clock=vi.spyOn(Date,"now"),started=Date.now(),old=acquireCircuit(ctx,providerId)!;
  try {
    finishCircuit(ctx,providerId,502,acquireCircuit(ctx,providerId)!);
    expect(readCircuit(ctx,providerId).state).toBe("closed");
    finishCircuit(ctx,providerId,503,acquireCircuit(ctx,providerId)!);
    expect(acquireCircuit(ctx,providerId)).toBeNull();
    clock.mockReturnValue(started+2000);
    const probe=acquireCircuit(ctx,providerId)!;expect(probe).toBeTypeOf("symbol");
    clock.mockReturnValue(started+10000);
    expect(acquireCircuit(ctx,providerId)).toBeNull();
    finishCircuit(ctx,providerId,200,old);
    expect(readCircuit(ctx,providerId).state).toBe("half_open");
    finishCircuit(ctx,providerId,200,probe);
    expect(readCircuit(ctx,providerId).state).toBe("closed");
    const beforeReset=acquireCircuit(ctx,providerId)!;resetCircuit(ctx,providerId);
    finishCircuit(ctx,providerId,500,beforeReset);expect(readCircuit(ctx,providerId).consecutive_failures).toBe(0);
  } finally {clock.mockRestore();}
  const {providers}= (await send("GET","/api/providers/health-matrix")).json();
  expect(providers[0].states).toEqual([502,503,200,200,500]);
});
it("bounds token reservations and preserves budget enforcement after log retention",async()=>{
  const key={id:"test",allowed_models:["*"],tpm_limit:10,rate_limit_rpm:2,daily_budget:1,monthly_budget:0};
  const settle=reserveKeyQuota(ctx,key,3,6);
  expect(()=>reserveKeyQuota(ctx,key,1,2)).toThrow(/rate limit/i);
  settle(3);reserveKeyQuota(ctx,key,1,2);expect(()=>reserveKeyQuota(ctx,key,0,1)).toThrow(/rate limit/i);
  recordGatewayRequest(ctx,{request_id:"one",source_type:"external",api_key_id:"test",virtual_model:"fast",provider_id:providerId,inbound_protocol:"responses",status_code:200,currency:"USD",cost_estimate:1});
  ctx.native.prepare("DELETE FROM gateway_request_logs").run();
  expect(()=>reserveProviderQuota(ctx,providerId)).toThrow(/budget/i);
  expect(()=>reserveKeyQuota(ctx,key,0,1)).toThrow(/budget/i);
});
it("reserves outstanding maximum charges and releases them exactly once on failover",()=>{
  const provider=ctx.orm.select().from(schema.providers).get()!,model=ctx.orm.select().from(schema.models).get()!;
  model.costOutputUsdPerMillion=100000;
  const firstHold=reserveCost(ctx,model,provider,undefined,100,8);
  expect(()=>reserveCost(ctx,model,provider,undefined,100,3)).toThrow(/budget/i);
  firstHold.release();firstHold.release();
  expect(()=>reserveCost(ctx,model,provider,undefined,100,10).release()).not.toThrow();
});
it("captures only masked encrypted bodies during a bounded debug session",async()=>{
  const log={source_type:"internal",virtual_model:"fast",inbound_protocol:"responses",status_code:200};
  recordGatewayRequest(ctx,{...log,request_id:"off"},{input:secret});
  expect(ctx.native.prepare("SELECT debug_payload_enc FROM gateway_request_logs").pluck().get()).toBeNull();
  await send("PATCH","/api/gateway/debug",{enabled:true,ttl_minutes:1});
  recordGatewayRequest(ctx,{...log,request_id:"on"},{input:secret,authorization:"arbitrary-value"});
  const row=ctx.native.prepare("SELECT id,debug_payload_enc FROM gateway_request_logs WHERE request_id='on'").get() as {id:string;debug_payload_enc:string};
  expect(row.debug_payload_enc).toMatch(/^v1\./);expect(row.debug_payload_enc).not.toContain(secret);
  expect((await send("GET","/api/gateway/logs/"+row.id)).json().debug_payload).toEqual({input:"[REDACTED]",authorization:"[REDACTED]"});
  ctx.native.prepare("UPDATE settings SET value='1' WHERE key='gateway.debug.until'").run();
  expect((await send("GET","/api/gateway/debug")).json().enabled).toBe(false);
});
it("moves keys and remaps route targets across installations in an authenticated encrypted bundle",async()=>{
  await send("POST","/api/routing-profiles",{slug:"route",name:"Route",targets:[{model_id:first}]});
  const passphrase="long fixture passphrase",full=(await send("POST","/api/providers/export",{mode:"encrypted",passphrase})).json();
  const clean=(await send("POST","/api/providers/export",{mode:"redacted"})).json();
  expect(JSON.stringify([clean,full])).not.toContain(secret);
  const destination=context(),shared=context();
  try{
    await expect(importBundle(destination,{bundle:full,passphrase:"wrong passphrase"})).rejects.toThrow(/authenticate/i);
    expect((await importBundle(destination,{bundle:full,passphrase})).models).toBe(2);
    const p=destination.orm.select().from(schema.providers).get()!;
    expect(p.id).not.toBe(providerId);expect(readPool(p,destination)[0].value).toBe(secret);
    expect(routeModelIds(destination,"route")).toHaveLength(1);
    expect(await importBundle(shared,{bundle:clean})).toMatchObject({providers:1,models:2});
    expect(readPool(shared.orm.select().from(schema.providers).get()!,shared)).toEqual([]);
    await expect(importBundle(destination,{bundle:full,passphrase})).rejects.toThrow(/already exists/i);
    expect(destination.orm.select().from(schema.providers).all()).toHaveLength(1);
  }finally{destination.native.close();shared.native.close();}
});
it("applies upstream patches while retaining routing identity and bounded output",()=>{
  expect(patchRequest({model:"test",max_completion_tokens:4,store:true,stream:true,messages:[{role:"developer",content:"hello"}]},
    JSON.stringify({developer_to_system:true,map_max_tokens:true,include_usage:true,strip_fields:["store"],extra_body:{model:"other",temperature:0}})))
    .toEqual({model:"test",max_tokens:4,stream:true,messages:[{role:"system",content:"hello"}],temperature:0,stream_options:{include_usage:true}});
});
it("rejects embedded newly supplied credentials before persisting and omits private extensions from shareable bundles",async()=>{
  const entry="fixture/"+randomBytes(16).toString("hex");
  const create={name:"Other",preset:"custom",base_url:"http://127.0.0.1:12345/v1"};
  for(const input of [
    {api_keys:[entry],base_url:create.base_url+"/"+encodeURIComponent(entry)},
    {balance_token:entry,balance_endpoint:"/account/"+encodeURIComponent(entry)},
    {headers:{"X-Service":entry},patch_rules:{extra_body:{nested:[{mode:entry}]}}},
  ]) {
    expect((await send("POST","/api/providers",{...create,...input})).statusCode).toBe(400);
    expect((await send("PATCH","/api/providers/"+providerId,input)).statusCode).toBe(400);
  }
  ctx.native.prepare("UPDATE providers SET base_url=?,balance_endpoint=?,balance_user_id='1234567',patch_rules_json=? WHERE id=?")
    .run(create.base_url+"/"+encodeURIComponent(entry),"/balance/legacy-private-path",JSON.stringify({map_max_tokens:true,extra_body:{legacy:entry}}),providerId);
  const safe=(await send("POST","/api/providers/export",{mode:"redacted"})).json();
  expect(JSON.stringify(safe)).not.toContain(entry);
  expect(safe.config.providers[0]).toMatchObject({base_url:"http://127.0.0.1:12345/",balance_endpoint:null,balance_user_id:null,patch_rules:{map_max_tokens:true}});
  expect(safe.config.providers[0].patch_rules).not.toHaveProperty("extra_body");
  safe.config.providers[0].patch_rules.extra_body={legacy:entry};
  await expect(importBundle(ctx,{bundle:safe})).rejects.toThrow(/private provider configuration/i);
});
it("uses new preset defaults on legacy preset-only updates and respects explicit overrides",async()=>{
  const url="/api/providers/"+providerId;
  expect((await send("PATCH",url,{preset:"siliconflow"})).json()).toMatchObject({protocol_type:"openai_chat",patch_rules:{map_max_tokens:true}});
  expect((await send("PATCH",url,{name:"Renamed"})).json()).toMatchObject({protocol_type:"openai_chat",patch_rules:{map_max_tokens:true}});
  expect((await send("PATCH",url,{preset:"anthropic"})).json()).toMatchObject({protocol_type:"anthropic_messages",patch_rules:{}});
  expect((await send("PATCH",url,{preset:"custom",protocol_type:null,patch_rules:{include_usage:true}})).json()).toMatchObject({protocol_type:null,patch_rules:{include_usage:true}});
});
