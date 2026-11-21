import type {patchRulesSchema,ProviderPatch} from "@codexdeck/shared";
import type {z} from "zod";
import type {SecretMasker} from "../security/secret-masker.js";

export function validatePublicFields(input:ProviderPatch,masker:SecretMasker) {
  const supplied=[input.api_key,input.balance_token,...input.api_keys??[],...Object.values(input.headers??{})];
  for(const [name,value] of Object.entries(input.headers??{})) if(name.toLowerCase()==="authorization") supplied.push(value.replace(/^\S+\s+/,""));
  const reject=():never=>{throw Object.assign(new Error("Credentials belong in the encrypted key or header fields."),{statusCode:400});};
  function check(value:string) {
    if(masker.maskString(value,true)!==value || supplied.some(secret=>secret && (secret===value || (secret.length>4 && value.includes(secret))))) reject();
  }
  function walk(value:unknown) {
    if(typeof value==="string") check(value);
    else if(value && typeof value==="object") for(const [name,item] of Object.entries(value)) {check(name);walk(item);}
  }
  for(const url of [input.base_url,input.balance_endpoint]) if(url){
    let decoded:string;
    try {decoded=decodeURIComponent(url);}catch{reject();return;}
    check(decoded);
    for(const segment of decoded.split("/")) check(segment);
  }
  if(input.name) check(input.name);
  Object.keys(input.headers??{}).forEach(check);
  if(input.patch_rules){
    walk(input.patch_rules);
    if(JSON.stringify(input.patch_rules)!==JSON.stringify(masker.maskObject(input.patch_rules,true))) reject();
  }
}

export function patchRequest(body:Record<string,unknown>,rulesJson:string):Record<string,unknown> {
  const rules:z.infer<typeof patchRulesSchema>=JSON.parse(rulesJson);
  const out={...body,...rules.extra_body};
  // Model, output limits and wire mode belong to routing and quota enforcement.
  for(const key of ["model","stream","max_output_tokens","max_completion_tokens","max_tokens"]) {
    if(key in body) out[key]=body[key]; else delete out[key];
  }
  if (rules.developer_to_system && Array.isArray(out.messages)) out.messages=out.messages.map(message=>
    message?.role==="developer"?{...message,role:"system"}:message);
  if(rules.map_max_tokens && out.max_completion_tokens!==undefined){
    out.max_tokens=out.max_completion_tokens;delete out.max_completion_tokens;
  }
  for(const key of rules.strip_fields??[]) if(!["model","stream","max_output_tokens","max_completion_tokens","max_tokens"].includes(key)) delete out[key];
  if(rules.include_usage && out.stream===true && Array.isArray(out.messages))
    out.stream_options={...(out.stream_options as object),include_usage:true};
  return out;
}
