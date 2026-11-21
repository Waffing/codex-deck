import type { ResponseRequest } from "@codexdeck/shared";
import type { SecretMasker } from "../security/secret-masker.js";

// Select Responses content fields explicitly. Tool declarations, invocation IDs, image/file
// encodings and routing options must retain their wire representation.
const textFields = new Set(["text","content","output","input","summary","refusal","code","command","diff","stdout","stderr","logs"]);
export function redactVaultInput(request:ResponseRequest, masker:SecretMasker):ResponseRequest {
  const vault=masker.workspace;
  if (vault.empty) return request;
  function argumentsJson(source:string) {
    let changed=false;
    try {
      const parsed:unknown=JSON.parse(source, (_key, value:unknown)=>{
        if (typeof value!=="string") return value;
        const safe=vault.maskLiterals(value);
        if (safe!==value) changed=true;
        return safe;
      });
      return changed ? JSON.stringify(parsed) : source;
    } catch {return vault.maskLiterals(source);}
  }
  function content(value:unknown):unknown {
    if (typeof value==="string") return vault.maskLiterals(value);
    if (Array.isArray(value)) return value.map(content);
    if (value && typeof value==="object") return item(value as Record<string,unknown>);
    return value;
  }
  function item(input:Record<string,unknown>):Record<string,unknown> {
    const safe={...input};
    for (const [key,value] of Object.entries(input)) {
      if (key==="arguments" && typeof value==="string") safe[key]=argumentsJson(value);
      else if (textFields.has(key) || key==="action" || key==="operation") safe[key]=content(value);
    }
    return safe;
  }
  return {...request, ...(request.instructions!==undefined && {instructions:vault.maskLiterals(request.instructions)}),
    input:typeof request.input==="string" ? vault.maskLiterals(request.input) : request.input.map(item)};
}
