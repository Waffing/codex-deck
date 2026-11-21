import type { FastifyRequest } from "fastify";
import {openWorkspaceFile} from "../files/sandbox.js";

const slugSegment="[A-Za-z0-9_-]{32}";
const shell=new RegExp("^/s/"+slugSegment+"$");
const content=new RegExp("^/api/public/shares/"+slugSegment+"/(content|download)$");
const verify=new RegExp("^/api/public/shares/"+slugSegment+"/verify$");

export function publicShareRoute(req:FastifyRequest) {
  const p=req.url.split("?")[0];
  const route=req.routeOptions.url;
  if(req.method==="POST") return route==="/api/public/shares/:slug/verify" && verify.test(p);
  return (req.method==="GET" || req.method==="HEAD") &&
    (route==="/s/:slug" && shell.test(p) ||
      (route==="/api/public/shares/:slug/content" || route==="/api/public/shares/:slug/download") && content.test(p));
}

type Entry={file:string;imports?:string[];dynamicImports?:string[];css?:string[];assets?:string[]};
export async function collectShareAssets(dist:string,assets:Set<string>) {
  const handle=await openWorkspaceFile(dist,".vite/manifest.json").catch(error=>{
    if(error.statusCode===404) return undefined;
    throw error;
  });
  if(!handle)return;
  let manifest:Record<string,Entry>;
  try {manifest=JSON.parse(await handle.readFile("utf8"));} finally {await handle.close();}
  const seen=new Set<string>();
  function add(key:string) {
    const entry=manifest[key];
    if(!entry || seen.has(key))return;
    seen.add(key);
    for(const name of [entry.file,...entry.css??[],...entry.assets??[]]) {
      if(/^assets\/[\w.-]+$/.test(name)) assets.add("/"+name);
    }
    for(const imported of [...entry.imports??[],...entry.dynamicImports??[]]) add(imported);
  }
  add("share.html");
}
