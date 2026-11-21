import path from "node:path";
import { lstat } from "node:fs/promises";
import type { FastifyInstance, FastifyReply } from "fastify";
import { contentType } from "mime-types";
import { resolveSafeWorkspacePath, openWorkspaceFile } from "./files/sandbox.js";
import { repositoryRoot, workspaceDirectory } from "./security/paths.js";

import {collectShareAssets} from "./security/share-ingress.js";

export function mountWeb(app:FastifyInstance, directory:string, workspaceRoot=repositoryRoot, shareAssets=new Set<string>()) {
  app.register(async scope => {
    const dist=await workspaceDirectory(workspaceRoot,directory);
    if (path.relative(dist,path.resolve(workspaceRoot,directory))) throw new Error("Unexpected web distribution link.");
    const miss=(reply:FastifyReply)=>reply.code(404).send({error:"Not found."});
    await collectShareAssets(dist,shareAssets);
    scope.get<{Params:{slug:string}}>("/s/:slug",async(req,reply)=>{
      if(!/^[A-Za-z0-9_-]{32}$/.test(req.params.slug))return miss(reply);
      const handle=await openWorkspaceFile(dist,"share.html");
      reply.header("cache-control","no-store").header("referrer-policy","no-referrer").header("x-content-type-options","nosniff")
        .header("content-security-policy","default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; font-src 'self' data: blob:; worker-src 'self' blob:; frame-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
        .type("text/html; charset=utf-8");
      return reply.send(handle.createReadStream());
    });
    scope.get("/*",async(req,reply)=>{
      const raw=req.raw.url?.split("?")[0] ?? "/";
      let pathname:string;
      try { pathname=decodeURIComponent(raw); } catch { return miss(reply); }
      if (/^\/(api|ws|preview|internal|live|health|s)(?:\/|$)/i.test(pathname)) return reply.callNotFound();
      if (!pathname.startsWith("/") || /(?:^|\/)\.|[\\:%\u0000]/.test(pathname)) return miss(reply);
      let filename=pathname.slice(1) || "index.html";
      const real=await resolveSafeWorkspacePath(dist,filename);
      if (path.relative(real,path.resolve(dist,filename))) return miss(reply);
      const info=await lstat(real).catch((err:NodeJS.ErrnoException)=>{if(err.code==="ENOENT")return null;throw err;});
      if (!info?.isFile()) {
        const accepts=req.headers.accept;
        if (path.extname(filename) || filename.startsWith("assets/") || (accepts && !accepts.includes("text/html") && !accepts.includes("*/*"))) return miss(reply);
        filename="index.html";
        const index=await resolveSafeWorkspacePath(dist,filename);
        if (path.relative(path.join(dist,filename),index)) return miss(reply);
        const indexInfo=await lstat(index);
        if (!indexInfo.isFile() || indexInfo.nlink!==1) return miss(reply);
      } else if(info.nlink!==1) return miss(reply);
      reply.header("x-content-type-options","nosniff");
      if(filename==="index.html") reply.header("content-security-policy","frame-src 'self'");
      if(filename==="index.html" || filename==="sw.js" || filename==="manifest.webmanifest") reply.header("cache-control","no-cache");
      if(filename.startsWith("assets/") || filename.startsWith("icons/"))reply.header("X-CodexDeck-Static","1");
      const handle=await openWorkspaceFile(dist,filename);
      try {
        reply.type(contentType(path.extname(filename)) || "application/octet-stream").header("content-length",(await handle.stat()).size);

        return reply.send(handle.createReadStream());
      } catch(error) { await handle.close(); throw error; }
    });
  });
}
