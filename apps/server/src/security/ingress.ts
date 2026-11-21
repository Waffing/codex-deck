import type { FastifyRequest } from "fastify";
import ipaddr from "ipaddr.js";
import { timingSafeEqual } from "node:crypto";

export function normalizeIp(value:string):string|null {
  if(!ipaddr.isValid(value)) return null;
  return ipaddr.process(value).toString();
}

export function validRange(range:string) {
  if (!range.includes("/")) return normalizeIp(range)!==null;
  try { ipaddr.parseCIDR(range); return true; } catch { return false; }
}

export function inRange(ip:string, range:string) {
  const normalized=normalizeIp(ip);
  if (!normalized) return false;
  if (!range.includes("/")) return normalized===normalizeIp(range);
  try {
    const [network,prefix]=ipaddr.parseCIDR(range);
    const address=ipaddr.parse(normalized);
    return address.kind()===network.kind() && address.match(network,prefix);
  } catch { return false; }
}
function peer(req:FastifyRequest) {
  return normalizeIp(req.raw.socket.remoteAddress??"")??"unknown";
}
function hasProxyHeader(req:FastifyRequest) {
  return Object.keys(req.headers).some(name=>name==="forwarded" || name==="x-real-ip" || name==="x-codexdeck-proxy" || name.startsWith("x-forwarded-"));
}
function localName(req:FastifyRequest) {
  return /^(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?$/i.test(req.headers.host??"");
}
export function directLocal(req:FastifyRequest) {
  return !("encrypted" in req.raw.socket) && localName(req) && !hasProxyHeader(req) &&
    (inRange(peer(req),"127.0.0.0/8") || peer(req)==="::1");
}
export function localPanel(req:FastifyRequest) {
  return directLocal(req) || (!("encrypted" in req.raw.socket) && localName(req) && !hasProxyHeader(req) &&
    !!process.env.CODEXDECK_LOCAL_PEER && normalizeIp(process.env.CODEXDECK_LOCAL_PEER)===peer(req));
}
function trusted(ip:string) {
  return (process.env.CODEXDECK_TRUSTED_PROXIES??"").split(",").some(rule=>rule.trim() && inRange(ip,rule.trim()));
}
function managedClient(req:FastifyRequest):string|null {
  const header=req.headers["x-codexdeck-proxy"],source=req.headers["x-forwarded-for"],token=process.env.CODEXDECK_MANAGED_PROXY_TOKEN;
  if(!token || !/^[0-9a-f]{64}$/i.test(token) || typeof header!=="string" || !/^[0-9a-f]{64}$/i.test(header) ||
    "encrypted" in req.raw.socket || req.headers["x-forwarded-proto"]!=="https" || typeof source!=="string") return null;
  const client=normalizeIp(source.trim()),address=peer(req);
  if(!client || !ipaddr.isValid(address) || !["loopback","private","uniqueLocal"].includes(ipaddr.process(address).range())) return null;
  return timingSafeEqual(Buffer.from(header),Buffer.from(token))?client:null;
}
export function clientIp(req:FastifyRequest) {
  const managed=managedClient(req);
  if(managed) return managed;
  let result=peer(req);
  const header=req.headers["x-forwarded-for"];
  if (typeof header!=="string" || !trusted(result)) return result;
  for(const hop of header.split(",").reverse()) {
    if(!trusted(result)) break;
    const next=normalizeIp(hop.trim());
    if(!next) return peer(req);
    result=next;
  }
  return result;
}
export function secureTransport(req:FastifyRequest) {
  return verifiedHttps(req) || process.env.CODEXDECK_COOKIE_SECURE==="true" || !!process.env.CODEXDECK_DOMAIN;
}
export function verifiedHttps(req:FastifyRequest) {
  return "encrypted" in req.raw.socket ||
    !!managedClient(req) || (trusted(peer(req)) && req.headers["x-forwarded-proto"]==="https");
}
