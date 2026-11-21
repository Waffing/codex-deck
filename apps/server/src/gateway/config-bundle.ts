import {randomBytes,randomUUID,scrypt} from "node:crypto";
import {promisify} from "node:util";
import {z} from "zod";
import {modelCreateSchema,providerCreateSchema,routingProfileSchema} from "@codexdeck/shared";
import type {ServerContext} from "../app.js";
import {providers,models} from "../db/schema.js";
import {providerDto,modelDto} from "../routes/providers.js";
import {decryptSecret,encryptSecret} from "../security/crypto.js";
import {keyFields,readPool,readCredentials,sealHeaders} from "./credentials.js";
import {profiles,saveProfile} from "./router-engine.js";
import {canSaveCredentialTransport} from "./transport.js";
import {validatePublicFields} from "./patch-pipeline.js";
import {providerPresets} from "./presets.js";
import {balanceUrl} from "./model-center.js";

const contents=z.object({providers:z.array(providerCreateSchema.extend({id:z.string().min(1)})).max(256),
  models:z.array(modelCreateSchema.extend({id:z.string().min(1)})).max(10000),routes:z.array(routingProfileSchema).max(1000)});
const derive=promisify(scrypt);
const exportOptions=z.object({mode:z.enum(["redacted","encrypted"]).default("redacted"),passphrase:z.string().min(12).max(1024).optional()});
const envelope=z.discriminatedUnion("mode",[
  z.object({format:z.literal("codexdeck-config-v1"),mode:z.literal("encrypted"),salt:z.string().regex(/^[0-9a-f]{32}$/),ciphertext:z.string().max(3_000_000)}),
  z.object({format:z.literal("codexdeck-config-v1"),mode:z.literal("redacted"),config:contents}),
]);
function invalid(message:string):never {throw Object.assign(new Error(message),{statusCode:400});}
const publicPaths=new Set(["","/","/v1",...Object.values(providerPresets).flatMap(p=>p.defaultBaseUrl?[new URL(p.defaultBaseUrl).pathname]:[])]);
function shareableEndpoint(value:string) {
  const url=new URL(value);
  return url.origin+(publicPaths.has(url.pathname)?url.pathname:"/");
}
export async function exportBundle(ctx:ServerContext,input:unknown) {
  const options=exportOptions.safeParse(input??{});
  if(!options.success) invalid("Invalid export options.");
  const {mode,passphrase}=options.data;
  if(mode==="encrypted" && !passphrase) invalid("Use a passphrase of at least 12 characters.");
  const config=contents.parse({
    providers:ctx.orm.select().from(providers).all().map(row=>{
      const base={...providerDto(row,ctx),headers:{},api_keys:[] as string[]};
      if(mode==="redacted") {
        const {extra_body,...rules}=base.patch_rules??{};
        return {...base,patch_rules:rules,base_url:shareableEndpoint(base.base_url),balance_endpoint:null,balance_user_id:null};
      }
      return {...base,api_keys:readPool(row,ctx).map(k=>k.value),headers:readCredentials(row,ctx).headers,
        balance_token:row.balanceTokenEnc?decryptSecret(row.balanceTokenEnc,ctx.masterKey):undefined};
    }),
    models:ctx.orm.select().from(models).all().map(modelDto),routes:profiles(ctx),
  });
  if(mode==="redacted") {
    const safe=ctx.masker.maskObject(config);
    return {format:"codexdeck-config-v1",mode,config:{...safe,providers:safe.providers.map(({api_key,api_keys,balance_token,...fields})=>fields)}};
  }
  const salt=randomBytes(16),key=await derive(passphrase!,salt,32) as Buffer;
  return {format:"codexdeck-config-v1",mode,salt:salt.toString("hex"),ciphertext:encryptSecret(JSON.stringify(config),key)};
}
export async function importBundle(ctx:ServerContext,input:unknown) {
  const parsed=z.object({bundle:envelope,passphrase:z.string().min(12).max(1024).optional()}).safeParse(input);
  if(!parsed.success) invalid("Invalid configuration bundle.");
  const {bundle,passphrase}=parsed.data;
  let config:z.infer<typeof contents>;
  if(bundle.mode==="encrypted") {
    if(!passphrase) invalid("Passphrase required.");
    const key=await derive(passphrase,Buffer.from(bundle.salt,"hex"),32) as Buffer;
    try{config=contents.parse(JSON.parse(decryptSecret(bundle.ciphertext,key)));}catch{invalid("Unable to authenticate the configuration bundle.");}
  }else config=bundle.config;
  const providerIds=new Map(config.providers.map(p=>[p.id,randomUUID()]));
  const modelIds=new Map(config.models.map(m=>[m.id,randomUUID()]));
  if(providerIds.size!==config.providers.length || modelIds.size!==config.models.length) invalid("Duplicate bundle IDs.");
  for(const p of config.providers){
    validatePublicFields(p,ctx.masker);
    if(p.balance_endpoint) balanceUrl(p.base_url,p.balance_endpoint);
    const credentials=!!(p.api_key||p.api_keys?.length||p.balance_token||Object.values(p.headers).some(Boolean));
    if(bundle.mode==="redacted" && (credentials || Object.keys(p.headers).length || p.balance_endpoint || p.balance_user_id || p.patch_rules?.extra_body || !publicPaths.has(new URL(p.base_url).pathname))) invalid("A redacted bundle cannot contain private provider configuration.");
    if(!await canSaveCredentialTransport(new URL(p.base_url),credentials)) invalid("Remote credentials require HTTPS.");
  }
  return ctx.native.transaction(()=>{
    const now=new Date().toISOString();
    for(const m of config.models){
      if(!providerIds.has(m.provider_id)||m.max_output_tokens>m.context_window||m.fallback_model_ids.some(id=>!modelIds.has(id)||id===m.id))
        invalid("Invalid bundle model or fallback.");
      if(ctx.native.prepare("SELECT 1 FROM (SELECT alias FROM models UNION ALL SELECT slug FROM routing_profiles) WHERE alias=?").get(m.alias))
        throw Object.assign(new Error("Model alias already exists: "+m.alias),{statusCode:409});
    }
    if(new Set(config.models.map(m=>m.alias)).size!==config.models.length) invalid("Duplicate model aliases.");
    for(const p of config.providers){
      if(p.balance_token)ctx.masker.register(p.balance_token);
      ctx.orm.insert(providers).values({id:providerIds.get(p.id)!,name:p.name,preset:p.preset,baseUrl:p.base_url,
        ...keyFields({...p,api_key:p.api_key||undefined},ctx),rotationStrategy:p.rotation_strategy,balanceEndpoint:p.balance_endpoint,
        balanceUserId:p.balance_user_id,balanceTokenEnc:p.balance_token?encryptSecret(p.balance_token,ctx.masterKey):null,
        headersJson:sealHeaders(p.headers,ctx),quirksJson:JSON.stringify(p.quirks),protocolType:p.protocol_type,
        patchRulesJson:JSON.stringify(p.patch_rules??{}),circuitBreakerJson:JSON.stringify(p.circuit_breaker??{}),weight:p.weight,
        rpmLimit:p.rpm_limit,dailyBudget:p.daily_budget,monthlyBudget:p.monthly_budget,budgetAction:p.budget_action,enabled:p.enabled,
        createdAt:now,updatedAt:now}).run();
    }
    for(const m of config.models) ctx.orm.insert(models).values({id:modelIds.get(m.id)!,providerId:providerIds.get(m.provider_id)!,modelId:m.model_id,
      alias:m.alias,protocol:m.protocol,fallbackModelIdsJson:JSON.stringify(m.fallback_model_ids.map(id=>modelIds.get(id))),contextWindow:m.context_window,
      maxOutputTokens:m.max_output_tokens,cacheReadPricePer1m:m.cache_read_price_per_1m,capabilitiesJson:JSON.stringify(m.capabilities),
      confirmedFree:m.confirmed_free,pricingCurrency:m.pricing_currency,costInputUsdPerMillion:m.cost_input_usd_per_million,
      costOutputUsdPerMillion:m.cost_output_usd_per_million,costInputCnyPerMillion:m.cost_input_cny_per_million,
      costOutputCnyPerMillion:m.cost_output_cny_per_million,enabled:m.enabled,createdAt:now,updatedAt:now}).run();
    for(const route of config.routes) saveProfile(ctx,{...route,targets:route.targets.map(t=>({...t,model_id:modelIds.get(t.model_id)}))});
    return {providers:providerIds.size,models:modelIds.size,routing_profiles:config.routes.length};
  }).immediate();
}
