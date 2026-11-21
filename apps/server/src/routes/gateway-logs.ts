import type {FastifyInstance} from "fastify";
import {randomUUID} from "node:crypto";
import {z} from "zod";
import type {ServerContext} from "../app.js";
import {createRequireAdmin} from "../auth.js";
import {readCircuit,resetCircuit} from "../gateway/circuit-breaker.js";
import {debugState} from "../gateway/request-log.js";
import {quotaOverview} from "../gateway/quota.js";
import {listRoutableModels,profiles,saveProfile} from "../gateway/router-engine.js";
import {decryptSecret,signPayload} from "../security/crypto.js";
import {verifiedHttps} from "../security/ingress.js";
import {exportBundle,importBundle} from "../gateway/config-bundle.js";
import {routeStrategySchema} from "@codexdeck/shared";

type Id={Params:{id:string}};
type Log={id:string;request_id:string;provider_id:string|null;actual_model:string|null;virtual_model:string;failover_chain_json:string;debug_payload_enc:string|null};
function dto(row:Log) {
  const {debug_payload_enc,failover_chain_json,...rest}=row;
  return {...rest,failover_chain:JSON.parse(failover_chain_json),has_debug:!!debug_payload_enc};
}
function parse<T>(schema:z.ZodType<T>,input:unknown):T {
  const p=schema.safeParse(input);
  if(!p.success) throw Object.assign(new Error("Invalid gateway options."),{statusCode:400});
  return p.data;
}
export function registerGatewayAdmin(app:FastifyInstance,ctx:ServerContext) {
  const db=ctx.native,auth={preHandler:createRequireAdmin(ctx)};
  app.get("/api/routing-profiles",auth,async()=>profiles(ctx));
  app.post("/api/routing-profiles",auth,async(req,reply)=>reply.code(201).send(saveProfile(ctx,req.body)));
  app.patch<Id>("/api/routing-profiles/:id",auth,async req=>saveProfile(ctx,req.body,req.params.id));
  app.delete<Id>("/api/routing-profiles/:id",auth,async(req,reply)=>{
    const row=db.prepare("SELECT slug FROM routing_profiles WHERE id=?").pluck().get(req.params.id);
    if(!row) return reply.code(404).send({error:"Unknown route."});
    if(db.prepare("SELECT 1 FROM threads WHERE active_model_alias=? UNION ALL SELECT 1 FROM settings WHERE key='default_model' AND value=?").get(row,row))
      return reply.code(409).send({error:"Migrate references before removing this route."});
    db.prepare("DELETE FROM routing_profiles WHERE id=?").run(req.params.id);
    return reply.code(204).send();
  });
  app.post<Id>("/api/routing-profiles/:id/switch",auth,async req=>{
    const patch=parse(z.object({active_target_index:z.number().int().nonnegative().optional(),strategy:routeStrategySchema.optional(),is_global_default:z.boolean().optional()}).strict(),req.body);
    return saveProfile(ctx,patch,req.params.id);
  });
  app.get("/api/providers/health-matrix",auth,async()=>{
    const attempts=db.prepare("SELECT status_code FROM gateway_provider_attempts WHERE provider_id=? ORDER BY id DESC LIMIT 20").pluck();
    return {providers:(db.prepare("SELECT id FROM providers").pluck().all() as string[]).map(provider_id=>{
      const states=(attempts.all(provider_id) as number[]).reverse();
      return {provider_id,states,availability:states.length?states.filter(n=>n>=200&&n<300).length/states.length:null,circuit:readCircuit(ctx,provider_id)};
    })};
  });
  app.post<Id>("/api/providers/:id/reset-circuit",auth,async req=>{resetCircuit(ctx,req.params.id);return readCircuit(ctx,req.params.id);});
  app.get("/api/gateway/debug",auth,async()=>debugState(ctx));
  app.patch("/api/gateway/debug",auth,async req=>{
    const p=parse(z.object({enabled:z.boolean(),ttl_minutes:z.number().int().min(1).max(60).default(15)}),req.body);
    db.prepare("INSERT OR REPLACE INTO settings VALUES('gateway.debug.until',?,?)").run(String(p.enabled?Date.now()+60000*p.ttl_minutes:0),new Date().toISOString());
    return debugState(ctx);
  });
  app.get("/api/gateway/quotas",auth,async()=>quotaOverview(ctx));
  app.get("/api/gateway/logs",auth,async req=>{
    const {limit,offset,...filters}=parse(z.object({limit:z.coerce.number().int().min(1).max(200).default(50),offset:z.coerce.number().int().nonnegative().default(0),
      provider_id:z.string().optional(),inbound_protocol:z.string().optional(),outbound_protocol:z.string().optional(),source_type:z.string().optional(),
      virtual_model:z.string().optional(),status_code:z.coerce.number().int().optional()}),req.query);
    const where=Object.keys(filters).length?" WHERE "+Object.keys(filters).map(key=>key+"=?").join(" AND "):"";
    const args=Object.values(filters);
    return {items:(db.prepare("SELECT * FROM gateway_request_logs"+where+" ORDER BY created_at DESC,id LIMIT ? OFFSET ?").all(...args,limit,offset) as Log[]).map(dto),
      total:db.prepare("SELECT count(*) FROM gateway_request_logs"+where).pluck().get(...args)};
  });
  const getLog=(id:string)=>db.prepare("SELECT * FROM gateway_request_logs WHERE id=?").get(id) as Log|undefined;
  app.get<Id>("/api/gateway/logs/:id",auth,async(req,reply)=>{
    const row=getLog(req.params.id);
    if(!row) return reply.code(404).send({error:"Unknown request."});
    return {...dto(row),debug_payload:row.debug_payload_enc?JSON.parse(decryptSecret(row.debug_payload_enc,ctx.masterKey)):null};
  });
  app.post<Id>("/api/gateway/logs/:id/replay",auth,async(req,reply)=>{
    const row=getLog(req.params.id);
    if(!row) return reply.code(404).send({error:"Unknown request."});
    const p=parse(z.object({provider_id:z.string().min(1).optional()}),req.body??{});
    const model=p.provider_id?db.prepare("SELECT alias FROM models WHERE provider_id=? AND enabled=1 ORDER BY (model_id=?) DESC,alias LIMIT 1").pluck().get(p.provider_id,row.actual_model):row.virtual_model;
    if(typeof model!=="string" || !listRoutableModels(ctx).includes(model)) return reply.code(400).send({error:"Choose an enabled target model."});
    const now=Math.floor(Date.now()/1000);
    const token=signPayload({aud:"codexdeck-internal",purpose:"replay",single_target:!!p.provider_id,iat:now,exp:now+60,nonce:randomUUID()},ctx.masterKey);
    const probe=await app.inject({method:"POST",url:"/internal/v1/responses",headers:{host:"localhost",authorization:"Bearer "+token},
      remoteAddress:"127.0.0.1",payload:{model,input:"Reply OK.",max_output_tokens:1,stream:false}});
    return {status_code:probe.statusCode,request_id:probe.headers["x-request-id"],model};
  });
  app.get<{Querystring:{api_key_id?:string;model?:string}}>("/api/gateway/client-snippets",auth,async(req,reply)=>{
    const selected=req.query.api_key_id?db.prepare("SELECT allowed_models_json FROM api_keys WHERE id=? AND revoked_at IS NULL").pluck().get(req.query.api_key_id):'["*"]';
    if(typeof selected!=="string") return reply.code(404).send({error:"Unknown active key."});
    const allow=JSON.parse(selected) as string[],choices=listRoutableModels(ctx).filter(m=>allow.includes("*")||allow.includes(m));
    const requested=req.query.model??choices[0];
    const model=requested && ctx.masker.maskString(requested);
    if(!model || !requested || !choices.includes(requested)) return reply.code(400).send({error:"Choose an allowed model."});
    const host=req.headers.host??"localhost";
    if(!/^(?:[a-z0-9.-]+|\[[a-f0-9:]+\])(?::\d{1,5})?$/i.test(host)) return reply.code(400).send({error:"Invalid hostname."});
    const base=(verifiedHttps(req)?"https://":"http://")+host;
    const codex=['model_provider = "codexdeck"',"model = "+JSON.stringify(model),"","[model_providers.codexdeck]",'name = "CodexDeck"',"base_url = "+JSON.stringify(base+"/v1"),'wire_api = "responses"','env_key = "CODEXDECK_API_KEY"'].join("\n");
    const claude=['export ANTHROPIC_BASE_URL="'+base+'"','export ANTHROPIC_AUTH_TOKEN="$CODEXDECK_API_KEY"', "export ANTHROPIC_MODEL='"+model.replaceAll("'","'\\''")+"'","claude"].join("\n");
    const openai=['from openai import OpenAI','import os','client = OpenAI(base_url='+JSON.stringify(base+"/v1")+', api_key=os.environ["CODEXDECK_API_KEY"])','print(client.chat.completions.create(model='+JSON.stringify(model)+', messages=[{"role":"user","content":"Hello"}]))'].join("\n");
    return reply.type("application/json").send(JSON.stringify({codex,claude,openai,cursor:"Base URL: "+base+"/v1\nModel: "+model+"\nAPI key: CODEXDECK_API_KEY"}));
  });
  app.post("/api/providers/export",auth,async(req,reply)=>reply.header("cache-control","no-store").type("application/json").send(JSON.stringify(await exportBundle(ctx,req.body))));
  app.post("/api/providers/import",auth,async req=>importBundle(ctx,req.body));
}
