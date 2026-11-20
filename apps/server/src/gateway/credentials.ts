import type { ServerContext } from "../app.js";
import { decryptSecret, encryptSecret } from "../security/crypto.js";
import { providers } from "../db/schema.js";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { maskApiKeySuffix } from "../security/secret-masker.js";
import type { ProviderPatch } from "@codexdeck/shared";

type Context = Pick<ServerContext, "masterKey" | "masker">;
type ProviderRow = typeof providers.$inferSelect;
type Stored = Pick<ProviderRow, "apiKeyCiphertext" | "apiKeysEnc" | "headersJson" | "balanceTokenEnc">;
type PoolEntry = {id:string;value:string};

function readPool(provider: Stored, context:Context):PoolEntry[] {
  const keys:PoolEntry[]=provider.apiKeysEnc ? JSON.parse(decryptSecret(provider.apiKeysEnc,context.masterKey))
    : provider.apiKeyCiphertext ? [{id:"legacy",value:decryptSecret(provider.apiKeyCiphertext,context.masterKey)}] : [];
  for (const key of keys) context.masker.register(key.value);
  return keys;
}

function badPool(message:string):never { throw Object.assign(new Error(message),{statusCode:400}); }
export function keyFields(input:ProviderPatch, context:Context, old?:ProviderRow) {
  if (input.api_key!==undefined && (input.api_keys!==undefined || input.retain_key_ids!==undefined)) badPool("Choose a single key or a key pool.");
  const oldKeys=old ? readPool(old,context) : [];
  const retained=(input.retain_key_ids??[]).map(id=>oldKeys.find(key=>key.id===id)??badPool("Unknown retained key."));
  const values=input.api_keys??(input.api_key ? [input.api_key] : []);
  const entries=[...retained,...values.map(value=>oldKeys.find(key=>key.value===value)??{id:randomUUID(),value})];
  if (entries.length>64 || entries.length!==new Set(entries.map(entry=>entry.value)).size) badPool("Key pool contains duplicate or excess keys.");
  for(const entry of entries) context.masker.register(entry.value);
  const first=entries[0]?.value??null;
  return {apiKeysEnc:encryptSecret(JSON.stringify(entries),context.masterKey),apiKeyMasked:maskApiKeySuffix(first),
    apiKeyCiphertext:first?encryptSecret(first,context.masterKey):null};
}

type Cooling = {status:"cooldown"|"unauthorized";until:number};
const poolStates=new WeakMap<Context,Map<string,{next:number;cooling:Map<string,Cooling>}>>();
function poolState(context:Context, id:string) {
  const pools=poolStates.get(context)??new Map<string,{next:number;cooling:Map<string,Cooling>}>(); poolStates.set(context,pools);
  const state=pools.get(id)??{next:0,cooling:new Map<string,Cooling>()}; pools.set(id,state);
  for(const [key,cool] of state.cooling) if(cool.until<=Date.now()) state.cooling.delete(key);
  return state;
}
export function keyStatuses(provider:ProviderRow,context:Context) {
  const state=poolState(context,provider.id);
  return readPool(provider,context).map(({id,value})=>{
    const cooling=state.cooling.get(id);
    return {id,masked:maskApiKeySuffix(value),status:cooling?.status??"ready",cooldown_until:cooling?new Date(cooling.until).toISOString():null};
  });
}
export async function withProviderKey(provider:ProviderRow,context:Context,call:(key:string,headers:Record<string,string>)=>Promise<Response>) {
  const {headers}=readCredentials(provider,context);
  const entries=readPool(provider,context);
  if (!entries.length) return call("",headers);
  const state=poolState(context,provider.id);
  const candidates=entries.filter(key=>!state.cooling.has(key.id));
  const start=provider.rotationStrategy==="round_robin" && candidates.length ? state.next++%candidates.length : 0;
  let status=429;
  for (let i=0;i<candidates.length;i++) {
    const item=candidates[(start+i)%candidates.length];
    if(state.cooling.has(item.id)) continue;
    const response=await call(item.value,headers);
    if (![401,429].includes(response.status)) return response;
    status=response.status;
    const retry=response.headers.get("retry-after");
    const seconds=retry && /^\d+$/.test(retry)?Number(retry):NaN;
    const delay=Number.isFinite(seconds)?seconds*1000:retry?Date.parse(retry)-Date.now():NaN;
    const duration=Number.isFinite(delay)?Math.min(86400000,Math.max(1000,delay)):(status===401?300000:30000);
    state.cooling.set(item.id,{status:status===401?"unauthorized":"cooldown",until:Date.now()+duration});
    await response.body?.cancel();
  }
  if(!candidates.length && entries.every(item=>state.cooling.get(item.id)?.status==="unauthorized")) status=401;
  return new Response(null,{status});
}

export function sealHeaders(headers: Record<string, string>, context: Context): string {
  return JSON.stringify(Object.fromEntries(Object.entries(headers).map(([name, value]) => {
    registerHeader(name, value, context);
    return [name, value ? encryptSecret(value, context.masterKey) : ""];
  })));
}

function registerHeader(name: string, value: string, context: Context) {
  if (!value) return;
  // Header names are administrator-defined, including nonstandard credential names.
  context.masker.register(value);
  if (/^authorization$/i.test(name)) context.masker.register(value.replace(/^\S+\s+/, ""));
}

export function readCredentials(provider: Stored, context: Context) {
  const apiKey = readPool(provider,context)[0]?.value??"";
  if (provider.balanceTokenEnc) context.masker.register(decryptSecret(provider.balanceTokenEnc,context.masterKey));
  const sealed: Record<string, string> = JSON.parse(provider.headersJson);
  const headers = Object.fromEntries(Object.entries(sealed).map(([name, encrypted]) => {
    const value = encrypted ? decryptSecret(encrypted, context.masterKey) : "";
    registerHeader(name, value, context);
    return [name, value];
  }));
  return { apiKey, headers };
}

export function registerCredentialMasks(provider:Stored,context:Context):void { readCredentials(provider,context); }

export function registerStoredCredentials(context: ServerContext) {
  context.native.transaction(()=>{
    for(const provider of context.orm.select().from(providers).all()) {
      const {apiKey}=readCredentials(provider,context);
      if(!provider.apiKeysEnc && apiKey) {
        context.orm.update(providers).set(keyFields({api_key:apiKey},context)).where(eq(providers.id,provider.id)).run();
      }
    }
  }).immediate();
}
