import { lookup } from "node:dns";
import { lookup as resolveHost } from "node:dns/promises";
import { networkInterfaces } from "node:os";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { Agent, fetch as request } from "undici";

export function privateAddress(address:string) {
  const value=ipaddr.process(address.split("%")[0]);
  return value.range()!=="unicast" || Object.values(networkInterfaces()).flat()
    .some(entry=>entry && ipaddr.process(entry.address.split("%")[0]).toNormalizedString()===value.toNormalizedString());
}
export function allowCredentialTransport(url:URL, credentials:boolean) {
  if(!credentials || url.protocol==="https:") return true;
  const host=url.hostname.replace(/^\[|\]$/g,"");
  if(host==="localhost" || (isIP(host) && ipaddr.process(host).range()==="loopback")) return true;
  return (!isIP(host) || trustedPrivate(host)) && (process.env.CODEXDECK_TRUSTED_HTTP_ORIGINS ?? "").split(",").some(origin=>origin.trim()===url.origin);
}
const trustedPrivate=(address:string)=>["loopback","private","uniqueLocal"].includes(ipaddr.process(address).range());
export async function canSaveCredentialTransport(url:URL, credentials:boolean) {
  if (!allowCredentialTransport(url,credentials)) return false;
  const host=url.hostname.replace(/^\[|\]$/g,"");
  if (!credentials || url.protocol==="https:" || isIP(host)) return true;
  const answers=await resolveHost(host,{all:true}).catch(()=>[]);
  return answers.length>0 && answers.every(entry=>trustedPrivate(entry.address));
}

// Validate the answers actually used to open the connection, preserving the TLS hostname.
function addressAgent(accept:(address:string)=>boolean) {
  return new Agent({connect:{lookup(host,options,callback){
    lookup(host,{all:true,family:options.family===4||options.family===6?options.family:0},(error,answers)=>{
      if(error || !answers.length || !answers.every(a=>accept(a.address))) {
        callback(error ?? new Error("Provider address blocked by network policy."),"",0); return;
      }
      if(options.all) callback(null,answers);
      else callback(null,answers[0].address,answers[0].family);
    });
  }}});
}
const publicAgent=addressAgent(address=>!privateAddress(address));
export function publicMcpProbe(url:URL,body:string,signal:AbortSignal) {
  const host=url.hostname.replace(/^\[|\]$/g,"");
  if(url.protocol!=="https:" || url.username || url.password || host==="localhost" ||
     (isIP(host) && privateAddress(host)) || url.port==="22")throw new Error("Expected a public HTTPS MCP endpoint.");
  return request(url,{method:"POST",headers:{"content-type":"application/json",accept:"application/json, text/event-stream"},
    body,signal,redirect:"error",dispatcher:publicAgent});
}
const loopbackAgent=addressAgent(address=>ipaddr.process(address.split("%")[0]).range()==="loopback");
const privateAgent=addressAgent(trustedPrivate);
export function targetPolicy(url:URL,credentials:boolean,controlPorts:(number|undefined)[]) {
  if(!allowCredentialTransport(url,credentials)) throw new Error("Remote credentials require HTTPS.");
  const port=Number(url.port || (url.protocol==="https:"?443:80));
  const host=url.hostname.replace(/^\[|\]$/g,"");
  const loopback=host==="localhost" || isIP(host)>0 && ipaddr.process(host).range()==="loopback";
  const trustedOrigin=url.protocol==="http:" && (process.env.CODEXDECK_TRUSTED_HTTP_ORIGINS ?? "").split(",").some(origin=>origin.trim()===url.origin)
    && (!isIP(host) || trustedPrivate(host));
  const privateLiteral=isIP(host)>0 && privateAddress(host);
  const protectedPort=[22,80,443,...controlPorts].includes(port);
  if(protectedPort && (host==="localhost" || privateLiteral)) throw new Error("Probe target uses a protected port.");
  if(port===22 || (protectedPort && url.protocol==="http:" && credentials)) throw new Error("Probe target uses a protected port.");
  if(privateLiteral && !loopback && !trustedOrigin) throw new Error("Provider address blocked by network policy.");
  return loopback ? loopbackAgent : trustedOrigin ? privateAgent : publicAgent;
}
export function upstreamFetch(url:URL,init:{method:string;headers:Headers;body?:string;signal:AbortSignal},credentials:boolean,ports:(number|undefined)[]) {
  const dispatcher=targetPolicy(url,credentials,ports);
  return request(url,{...init,headers:Object.fromEntries(init.headers.entries()),redirect:"error",dispatcher}) as unknown as Promise<Response>;
}
