import path from "node:path";
import { lstat } from "node:fs/promises";
import type { FastifyInstance, FastifyReply } from "fastify";
import fastifyStatic from "@fastify/static";
import { resolveSafeWorkspacePath } from "./files/sandbox.js";
import { repositoryRoot, workspaceDirectory } from "./security/paths.js";

export function mountWeb(app:FastifyInstance, directory:string, workspaceRoot=repositoryRoot) {
  app.register(async scope => {
    const dist=await workspaceDirectory(workspaceRoot,directory);
    if (path.relative(dist,path.resolve(workspaceRoot,directory))) throw new Error("Unexpected web distribution link.");
    await scope.register(fastifyStatic,{root:dist,serve:false,dotfiles:"deny"});
    const miss=(reply:FastifyReply)=>reply.code(404).send({error:"Not found."});
    scope.get("/*",async(req,reply)=>{
      const raw=req.raw.url?.split("?")[0] ?? "/";
      let pathname:string;
      try { pathname=decodeURIComponent(raw); } catch { return miss(reply); }
      if (/^\/(api|ws|preview|internal|live|health)(?:\/|$)/i.test(pathname)) return reply.callNotFound();
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
      if(filename==="index.html") reply.header("cache-control","no-cache");
      return reply.sendFile(filename);
    });
  });
}
