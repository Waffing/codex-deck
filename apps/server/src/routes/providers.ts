import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import {
  modelCreateSchema, modelPatchSchema, modelSchema,
  providerCreateSchema, providerPatchSchema, providerSchema,
  benchmarkRequestSchema,modelBatchSchema,type ModelCreate,type BenchmarkResult,
} from "@codexdeck/shared";
import type { ServerContext } from "../app.js";
import { createRequireAdmin } from "../auth.js";
import { models, providers } from "../db/schema.js";
import { encryptSecret } from "../security/crypto.js";
import { keyFields,keyStatuses,sealHeaders } from "../gateway/credentials.js";
import { balanceUrl,benchmarkModel,discoverModels,fetchBalance } from "../gateway/model-center.js";
import {validatePublicFields} from "../gateway/patch-pipeline.js";
import { providerPresets } from "../gateway/presets.js";
import { probeProvider } from "../gateway/probe.js";
import { canSaveCredentialTransport } from "../gateway/transport.js";

export function providerDto(row: typeof providers.$inferSelect,context:ServerContext) {
  return providerSchema.parse({
    id: row.id, name: row.name, preset: row.preset, base_url: row.baseUrl,
    protocol_type:row.protocolType,patch_rules:JSON.parse(row.patchRulesJson),circuit_breaker:JSON.parse(row.circuitBreakerJson),
    weight:row.weight,rpm_limit:row.rpmLimit,daily_budget:row.dailyBudget,monthly_budget:row.monthlyBudget,budget_action:row.budgetAction,
    api_key_masked: row.apiKeyMasked,
    keys:keyStatuses(row,context),rotation_strategy:row.rotationStrategy,balance_endpoint:row.balanceEndpoint,
    has_balance_token:!!row.balanceTokenEnc,balance_user_id:row.balanceUserId,last_balance:row.lastBalanceJson?JSON.parse(row.lastBalanceJson):null,
    headers: Object.fromEntries(Object.keys(JSON.parse(row.headersJson)).map(name => [name, "[REDACTED]"])),
    quirks: JSON.parse(row.quirksJson), last_probe: row.lastProbeJson ? JSON.parse(row.lastProbeJson) : null,
    enabled: row.enabled, created_at: row.createdAt, updated_at: row.updatedAt,
  });
}

export function modelDto(row: typeof models.$inferSelect) {
  return modelSchema.parse({
    last_probe:row.lastProbeJson ? JSON.parse(row.lastProbeJson) : null,
    context_window:row.contextWindow,max_output_tokens:row.maxOutputTokens,cache_read_price_per_1m:row.cacheReadPricePer1m,
    capabilities:JSON.parse(row.capabilitiesJson),last_benchmark:row.lastBenchmarkJson?JSON.parse(row.lastBenchmarkJson):null,
    confirmed_free:row.confirmedFree, pricing_currency:row.pricingCurrency,cost_input_cny_per_million:row.costInputCnyPerMillion,
    cost_output_cny_per_million:row.costOutputCnyPerMillion,
    id: row.id, alias: row.alias, provider_id: row.providerId, model_id: row.modelId,
    protocol: row.protocol, fallback_model_ids: JSON.parse(row.fallbackModelIdsJson),
    cost_input_usd_per_million: row.costInputUsdPerMillion, cost_output_usd_per_million: row.costOutputUsdPerMillion,
    enabled: row.enabled, created_at: row.createdAt, updated_at: row.updatedAt,
  });
}

type ById = { Params: { id: string } };

export function registerProviderRoutes(app: FastifyInstance, context: ServerContext): void {
  const db = context.orm;
  const auth = { preHandler: createRequireAdmin(context) };
  const getProvider = (id: string) => db.select().from(providers).where(eq(providers.id, id)).get();
  const getModel = (id: string) => db.select().from(models).where(eq(models.id, id)).get();
  const sql=context.native;
  const boundPort=()=> (app.server.address() as AddressInfo|null)?.port;
  function references(model: typeof models.$inferSelect) {
    const threads=sql.prepare("SELECT count(*) FROM threads WHERE active_model_alias=?").pluck().get(model.alias) as number;
    const fallback=sql.prepare("SELECT alias FROM models WHERE EXISTS(SELECT 1 FROM json_each(fallback_model_ids_json) WHERE value=?)").pluck().all(model.id);
    const isDefault=!!sql.prepare("SELECT 1 FROM settings WHERE key='default_model' AND value=?").get(model.alias);
    const routes=sql.prepare("SELECT slug FROM routing_profiles WHERE EXISTS(SELECT 1 FROM json_each(targets_json) WHERE json_extract(value,'$.model_id')=?)").pluck().all(model.id);
    return {threads,fallback:[...fallback,...routes],isDefault};
  }
  function inUse(model:typeof models.$inferSelect) {
    const refs=references(model);
    return !!(refs.threads || refs.fallback.length || refs.isDefault);
  }
  app.get("/api/models/default",auth,async()=>({alias:sql.prepare("SELECT value FROM settings WHERE key='default_model'").pluck().get() ?? null}));
  app.put<{Body:{alias?:string}}>("/api/models/default",auth,async(req,reply)=>{
    const alias=req.body?.alias;
    if(typeof alias!=="string" || !sql.prepare("SELECT 1 FROM models m JOIN providers p ON p.id=m.provider_id WHERE m.enabled AND p.enabled AND m.alias=?").get(alias)) return reply.code(400).send({error:"Choose an enabled model."});
    sql.prepare("INSERT OR REPLACE INTO settings VALUES('default_model',?,?)").run(alias,new Date().toISOString());
    return {alias};
  });
  app.get<ById>("/api/models/:id/references",auth,async(req,reply)=>{
    const model=getModel(req.params.id);
    return model?references(model):reply.code(404).send({error:"Unknown model."});
  });
  app.post<ById & {Body:{replacement_id?:string}}>("/api/models/:id/replace",auth,async(req,reply)=>{
    const old=getModel(req.params.id), replacement=typeof req.body?.replacement_id==="string"?getModel(req.body.replacement_id):undefined;
    if(!old || !replacement?.enabled || !getProvider(replacement.providerId)?.enabled || old.id===replacement.id) return reply.code(400).send({error:"Choose a different enabled replacement."});
    sql.transaction(()=>{
      sql.prepare("UPDATE threads SET active_model_alias=? WHERE active_model_alias=?").run(replacement.alias,old.alias);
      sql.prepare("UPDATE settings SET value=? WHERE key='default_model' AND value=?").run(replacement.alias,old.alias);
      for(const route of sql.prepare("SELECT id,targets_json,active_target_index FROM routing_profiles WHERE EXISTS(SELECT 1 FROM json_each(targets_json) WHERE json_extract(value,'$.model_id')=?)").all(old.id) as {id:string;targets_json:string;active_target_index:number}[]){
        const targets=(JSON.parse(route.targets_json) as {model_id:string;weight?:number}[]).map(t=>({...t,model_id:t.model_id===old.id?replacement.id:t.model_id}));
        const selected=targets[route.active_target_index]?.model_id;
        const unique=targets.filter((t,i)=>targets.findIndex(other=>other.model_id===t.model_id)===i);
        sql.prepare("UPDATE routing_profiles SET targets_json=?,active_target_index=?,updated_at=? WHERE id=?").run(JSON.stringify(unique),Math.max(0,unique.findIndex(t=>t.model_id===selected)),new Date().toISOString(),route.id);
      }
      for(const row of db.select().from(models).all()) {
        const ids:string[]=JSON.parse(row.fallbackModelIdsJson);
        if(ids.includes(old.id)) db.update(models).set({fallbackModelIdsJson:JSON.stringify([...new Set(ids.map(id=>id===old.id?replacement.id:id).filter(id=>id!==row.id))])}).where(eq(models.id,row.id)).run();
      }
    }).immediate();
    return references(old);
  });
  app.get("/api/providers/presets", auth, async () => Object.values(providerPresets));
  app.get("/api/providers", auth, async () => db.select().from(providers).orderBy(asc(providers.createdAt)).all().map(row=>providerDto(row,context)));
  app.get<ById>("/api/providers/:id", auth, async (request, reply) => {
    const provider = getProvider(request.params.id);
    return provider ? providerDto(provider,context) : reply.code(404).send({ error: "Provider not found." });
  });

  function balanceSecret(value:string) {
    context.masker.register(value);
    return value?encryptSecret(value,context.masterKey):null;
  }

  app.post("/api/providers", auth, async (request, reply) => {
    const parsed = providerCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid provider." });
    const p = parsed.data;
    validatePublicFields(p,context.masker);
    if(p.balance_endpoint) balanceUrl(p.base_url,p.balance_endpoint);
    if(!await canSaveCredentialTransport(new URL(p.base_url),!!(p.api_key || p.api_keys?.length || p.balance_token) || Object.values(p.headers).some(Boolean))) return reply.code(400).send({error:"Remote credentials require HTTPS."});
    const now = new Date().toISOString();
    const row = db.insert(providers).values({
      id: randomUUID(), name: p.name, preset: p.preset, baseUrl: p.base_url, ...keyFields({...p,api_key:p.api_key||undefined},context),
      rotationStrategy:p.rotation_strategy,balanceEndpoint:p.balance_endpoint||null,balanceUserId:p.balance_user_id||null,balanceTokenEnc:balanceSecret(p.balance_token??""),
      protocolType:p.protocol_type===undefined?providerPresets[p.preset].protocol_type:p.protocol_type,
      patchRulesJson:JSON.stringify(p.patch_rules??providerPresets[p.preset].patch_rules??{}),circuitBreakerJson:JSON.stringify(p.circuit_breaker??{}),
      weight:p.weight,rpmLimit:p.rpm_limit,dailyBudget:p.daily_budget,monthlyBudget:p.monthly_budget,budgetAction:p.budget_action,
      headersJson: sealHeaders(p.headers, context), quirksJson: JSON.stringify(p.quirks),
      enabled: p.enabled, createdAt: now, updatedAt: now,
    }).returning().get();
    return reply.code(201).send(providerDto(row,context));
  });
  app.patch<ById>("/api/providers/:id", auth, async (request, reply) => {
    const parsed = providerPatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid provider update." });
    const p = parsed.data;
    const old=getProvider(request.params.id);
    if(!old) return reply.code(404).send({error:"Provider not found."});
    const base=p.base_url??old.baseUrl;
    const sameOrigin=new URL(base).origin===new URL(old.baseUrl).origin;
    const balanceEndpoint=p.balance_endpoint===undefined?(sameOrigin?old.balanceEndpoint:null):p.balance_endpoint||null;
    const changedPreset=p.preset && p.preset!==old.preset ? providerPresets[p.preset] : undefined;
    const protocol=p.protocol_type===undefined && changedPreset ? changedPreset.protocol_type??null : p.protocol_type;
    const rules=p.patch_rules??(changedPreset ? changedPreset.patch_rules??{} : undefined);
    validatePublicFields({...p,name:p.name??old.name,base_url:base,balance_endpoint:balanceEndpoint,patch_rules:rules??JSON.parse(old.patchRulesJson)},context.masker);
    if(balanceEndpoint) balanceUrl(base,balanceEndpoint);
    if(!sameOrigin && p.retain_key_ids?.length) {
      return reply.code(409).send({error:"The provider origin changed. Remove retained keys and enter credentials for the new origin."});
    }
    const existingIds=keyStatuses(old,context).map(key=>key.id);
    const keepingAll=sameOrigin && p.api_key===undefined && !p.api_keys?.length &&
      JSON.stringify(p.retain_key_ids??(p.api_keys===undefined?existingIds:[]))===JSON.stringify(existingIds);
    const pool=keepingAll?undefined:keyFields(p,context,sameOrigin?old:undefined);
    const customHeaders=p.headers??(sameOrigin?undefined:{});
    const sealedHeaders=customHeaders===undefined?undefined:sealHeaders(customHeaders,context);
    const hasHeaders=Object.values(customHeaders??JSON.parse(old.headersJson)).some(Boolean);
    const hasKey=pool?!!pool.apiKeyCiphertext:!!old.apiKeyCiphertext;
    const hasBalanceToken=!!(p.balance_token??(sameOrigin?old.balanceTokenEnc:null));
    const implicitMove=!sameOrigin && (
      (p.api_keys===undefined && p.api_key===undefined && !!old.apiKeyCiphertext) ||
      (p.headers===undefined && Object.values(JSON.parse(old.headersJson)).some(Boolean)) ||
      (p.balance_token===undefined && !!old.balanceTokenEnc)
    );
    if(!await canSaveCredentialTransport(new URL(base),hasKey || hasBalanceToken || hasHeaders || implicitMove)) return reply.code(400).send({error:"Remote credentials require HTTPS."});
    const clearProbe=base!==old.baseUrl || (protocol!==undefined && protocol!==old.protocolType) || !!rules || !!pool || sealedHeaders!==undefined || (p.quirks && JSON.stringify(p.quirks)!==old.quirksJson);
    const row = sql.transaction(()=>{
      const updated = db.update(providers).set({
        name: p.name, preset: p.preset, baseUrl: p.base_url, enabled: p.enabled,
        protocolType:protocol,patchRulesJson:rules&&JSON.stringify(rules),
        circuitBreakerJson:p.circuit_breaker&&JSON.stringify({...JSON.parse(old.circuitBreakerJson),...p.circuit_breaker}),
        weight:p.weight,rpmLimit:p.rpm_limit,dailyBudget:p.daily_budget,monthlyBudget:p.monthly_budget,budgetAction:p.budget_action,
        ...pool, rotationStrategy:p.rotation_strategy,balanceEndpoint,
        balanceTokenEnc:p.balance_token!==undefined?balanceSecret(p.balance_token):sameOrigin?undefined:null,
        balanceUserId:p.balance_user_id!==undefined?p.balance_user_id||null:sameOrigin?undefined:null,
        lastBalanceJson:!sameOrigin || balanceEndpoint!==old.balanceEndpoint || p.balance_token!==undefined ||
          (p.balance_user_id!==undefined && (p.balance_user_id||null)!==old.balanceUserId) || (p.preset!==undefined && p.preset!==old.preset)?null:undefined,
        headersJson:sealedHeaders, quirksJson:p.quirks && JSON.stringify(p.quirks),
        lastProbeJson:clearProbe ? null : undefined,
        updatedAt:new Date(Math.max(Date.now(),(Date.parse(old.updatedAt)||0)+1)).toISOString(),
      }).where(and(eq(providers.id, request.params.id),eq(providers.updatedAt,old.updatedAt))).returning().get();
      if(updated && clearProbe) db.update(models).set({lastProbeJson:null,lastBenchmarkJson:null}).where(eq(models.providerId,old.id)).run();
      return updated;
    }).immediate();
    return row ? providerDto(row,context) : reply.code(409).send({error:"Provider changed during update. Reload and retry."});
  });
  app.delete<ById>("/api/providers/:id", auth, async (request, reply) => {
    if(db.select().from(models).where(eq(models.providerId,request.params.id)).all().some(inUse)) return reply.code(409).send({error:"Migrate the referenced models before deleting this provider."});
    const result = db.delete(providers).where(eq(providers.id, request.params.id)).run();
    return result.changes ? reply.code(204).send() : reply.code(404).send({ error: "Provider not found." });
  });

  app.post<ById>("/api/providers/:id/probe", auth, async (request, reply) => {
    const p = getProvider(request.params.id);
    if (!p) return reply.code(404).send({ error: "Provider not found." });
    const input=request.body as {model_id?:string}|null;
    const list = db.select().from(models).where(eq(models.providerId,p.id)).all().filter(m=>m.enabled);
    const model=input?.model_id ? list.find(m=>m.id===input.model_id) : list[0];
    if(input?.model_id && !model) return reply.code(400).send({error:"Unknown enabled model on this provider."});
    const bound = app.server.address() as AddressInfo | null;
    const result = await probeProvider(p, model?.modelId, context, bound?.port);
    const updated=db.update(providers).set({ lastProbeJson: JSON.stringify(result) })
      .where(and(eq(providers.id, p.id), eq(providers.updatedAt, p.updatedAt))).run();
    if(updated.changes && model) db.update(models).set({lastProbeJson:JSON.stringify(result)}).where(and(eq(models.id,model.id),eq(models.updatedAt,model.updatedAt))).run();
    return result;
  });

  app.get("/api/models", auth, async () => db.select().from(models).orderBy(asc(models.createdAt)).all().map(modelDto));
  app.post<ById>("/api/providers/:id/balance",auth,async(req,reply)=>{
    const provider=getProvider(req.params.id);
    if(!provider) return reply.code(404).send({error:"Provider not found."});
    const balance=await fetchBalance(provider,context,boundPort());
    db.update(providers).set({lastBalanceJson:JSON.stringify(balance)}).where(and(eq(providers.id,provider.id),eq(providers.updatedAt,provider.updatedAt))).run();
    return balance;
  });
  app.post<ById>("/api/providers/:id/fetch-models",auth,async(req,reply)=>{
    const provider=getProvider(req.params.id);
    if(!provider) return reply.code(404).send({error:"Provider not found."});
    try {return await discoverModels(provider,context,boundPort());}
    catch {return reply.code(502).send({error:"Could not retrieve the upstream model list."});}
  });
  app.get<ById>("/api/models/:id", auth, async (request, reply) => {
    const model = getModel(request.params.id);
    return model ? modelDto(model) : reply.code(404).send({ error: "Model not found." });
  });

  function validFallbacks(ids: string[] | undefined, self?: string) {
    return !ids || (new Set(ids).size === ids.length && ids.every(id => id !== self && !!getModel(id)));
  }

  function insertModel(m:ModelCreate) {
    if(sql.prepare("SELECT 1 FROM routing_profiles WHERE slug=?").get(m.alias)) throw Object.assign(new Error("Alias already in use."),{statusCode:409});
    const now = new Date().toISOString();
    return db.insert(models).values({
      contextWindow:m.context_window,maxOutputTokens:m.max_output_tokens,cacheReadPricePer1m:m.cache_read_price_per_1m,capabilitiesJson:JSON.stringify(m.capabilities),
      confirmedFree:m.confirmed_free,pricingCurrency:m.pricing_currency,costInputCnyPerMillion:m.cost_input_cny_per_million,costOutputCnyPerMillion:m.cost_output_cny_per_million,
      id: randomUUID(), providerId: m.provider_id, modelId: m.model_id, alias: m.alias, protocol: m.protocol,
      fallbackModelIdsJson: JSON.stringify(m.fallback_model_ids), costInputUsdPerMillion: m.cost_input_usd_per_million,
      costOutputUsdPerMillion: m.cost_output_usd_per_million, enabled: m.enabled, createdAt: now, updatedAt: now,
    }).returning().get();
  }
  app.post("/api/models", auth, async (request, reply) => {
    const parsed=modelCreateSchema.safeParse(request.body);
    if(!parsed.success) return reply.code(400).send({error:"Invalid model."});
    const m=parsed.data;
    if(m.max_output_tokens>m.context_window || !getProvider(m.provider_id) || !validFallbacks(m.fallback_model_ids)) return reply.code(400).send({error:"Invalid model limits, provider or fallback."});
    if(db.select().from(models).where(eq(models.alias,m.alias)).get()) return reply.code(409).send({error:"Duplicate model alias."});
    return reply.code(201).send(modelDto(insertModel(m)));
  });
  app.post("/api/models/batch",auth,async(req,reply)=>{
    const parsed=modelBatchSchema.safeParse(req.body);
    if(!parsed.success || !getProvider(parsed.data.provider_id)) return reply.code(400).send({error:"Invalid model selection or provider."});
    const {provider_id,models:chosen}=parsed.data;
    return sql.transaction(()=>{
      const imported:ReturnType<typeof modelDto>[]=[];
      const skipped:string[]=[];
      const channelModel=sql.prepare("SELECT 1 FROM models WHERE provider_id=? AND model_id=?");
      const aliasTaken=sql.prepare("SELECT 1 FROM (SELECT alias FROM models UNION ALL SELECT slug FROM routing_profiles) WHERE alias=?");
      for(const entry of chosen) {
        if(channelModel.get(provider_id,entry.model_id) || (entry.alias && aliasTaken.get(entry.alias))) {
          skipped.push(entry.model_id);
          continue;
        }
        let alias=entry.alias??entry.model_id.slice(0,120);
        if(!entry.alias) {
          for(let i=2;aliasTaken.get(alias);i++) {
            const suffix=`-${i}`;
            alias=entry.model_id.slice(0,120-suffix.length)+suffix;
          }
        }
        imported.push(modelDto(insertModel(modelCreateSchema.parse({...entry,alias,provider_id,max_output_tokens:Math.min(16384,entry.context_window??128000)}))));
      }
      return {imported,skipped};
    }).immediate();
  });
  let benchmarking=false;
  app.post("/api/models/benchmark",auth,async(req,reply)=>{
    const parsed=benchmarkRequestSchema.safeParse(req.body);
    if(!parsed.success) return reply.code(400).send({error:"Invalid benchmark request."});
    if(benchmarking) return reply.code(409).send({error:"A benchmark is already running."});
    const jobs:{model:typeof models.$inferSelect;provider:typeof providers.$inferSelect}[]=[];
    for(const id of new Set(parsed.data.model_ids)) {
      const model=getModel(id),provider=model?getProvider(model.providerId):null;
      if(!model?.enabled || !provider?.enabled) return reply.code(400).send({error:"Select enabled models with enabled providers."});
      jobs.push({model,provider});
    }
    benchmarking=true;
    try {
      const results:BenchmarkResult[]=[];
      let next=0;
      const worker=async()=>{
        while(next<jobs.length) {
          const index=next++,{model,provider}=jobs[index];
          const result=await benchmarkModel(model,provider,context,parsed.data.sample_tokens,boundPort());
          if(getProvider(provider.id)?.updatedAt===provider.updatedAt) db.update(models).set({lastBenchmarkJson:JSON.stringify(result)}).where(and(eq(models.id,model.id),eq(models.updatedAt,model.updatedAt))).run();
          results[index]=result;
        }
      };
      await Promise.all(Array.from({length:Math.min(jobs.length,parsed.data.concurrency)},worker));
      return {results};
    } finally {benchmarking=false;}
  });
  app.patch<ById>("/api/models/:id", auth, async (request, reply) => {
    const parsed = modelPatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid model update." });
    const m = parsed.data;
    const id = request.params.id;
    if(m.alias && sql.prepare('SELECT 1 FROM routing_profiles WHERE slug=?').get(m.alias)) return reply.code(409).send({error:'Alias already in use.'});
    const old=getModel(id);
    if (!old) return reply.code(404).send({ error: "Model not found." });
    if((m.max_output_tokens??old.maxOutputTokens)>(m.context_window??old.contextWindow)) return reply.code(400).send({error:"Maximum output exceeds model context window."});
    if(m.enabled===false && inUse(old)) return reply.code(409).send({error:"Migrate this model's references before disabling it."});
    if ((m.provider_id && !getProvider(m.provider_id)) || !validFallbacks(m.fallback_model_ids, id)) return reply.code(400).send({ error: "Unknown provider or invalid fallback." });
    const existing = m.alias && db.select().from(models).where(eq(models.alias, m.alias)).get();
    if (existing && existing.id !== id) return reply.code(409).send({ error: "Duplicate model alias." });
    const row = sql.transaction(()=>{
    if(m.alias && m.alias!==old.alias) {
      sql.prepare("UPDATE threads SET active_model_alias=? WHERE active_model_alias=?").run(m.alias,old.alias);
      sql.prepare("UPDATE settings SET value=? WHERE key='default_model' AND value=?").run(m.alias,old.alias);
    }
    return db.update(models).set({
      lastProbeJson:m.model_id && m.model_id!==old.modelId || m.provider_id && m.provider_id!==old.providerId ? null:undefined,
      confirmedFree:m.confirmed_free,pricingCurrency:m.pricing_currency,costInputCnyPerMillion:m.cost_input_cny_per_million,costOutputCnyPerMillion:m.cost_output_cny_per_million,
      contextWindow:m.context_window,maxOutputTokens:m.max_output_tokens,cacheReadPricePer1m:m.cache_read_price_per_1m,
      capabilitiesJson:m.capabilities&&JSON.stringify(m.capabilities),
      lastBenchmarkJson:m.protocol || m.model_id || m.provider_id ? null : undefined,
      providerId: m.provider_id, modelId: m.model_id, alias: m.alias, protocol: m.protocol,
      fallbackModelIdsJson: m.fallback_model_ids && JSON.stringify(m.fallback_model_ids),
      costInputUsdPerMillion: m.cost_input_usd_per_million, costOutputUsdPerMillion: m.cost_output_usd_per_million,
      enabled: m.enabled, updatedAt: new Date().toISOString(),
    }).where(eq(models.id, id)).returning().get();
    }).immediate();
    return modelDto(row);
  });
  app.delete<ById>("/api/models/:id", auth, async (request, reply) => {
    const model=getModel(request.params.id);
    if(model && inUse(model)) return reply.code(409).send({error:"Migrate this model's threads, default or fallback references first."});
    const result = db.delete(models).where(eq(models.id, request.params.id)).run();
    return result.changes ? reply.code(204).send() : reply.code(404).send({ error: "Model not found." });
  });
}
