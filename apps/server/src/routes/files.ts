import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Readable } from "node:stream";
import { readdir } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import yazl from "yazl";
import { lookup } from "mime-types";
import { artifactSignSchema, filePathQuerySchema, fileSaveSchema, fileTreeQuerySchema } from "@codexdeck/shared";
import type { ServerContext } from "../app.js";
import { scopedAccess,scopedGuest } from "../temp-access/routes.js";
import {beginGuestUpload} from "../security/workspace-review.js";
import { fileError, ignored, missing, resolveSafeWorkspacePath, saveWorkspaceFile } from "../files/sandbox.js";
import { readEditable, writeEditable } from "../files/editor.js";
import { signDownload, validateDownload } from "../files/signed-url.js";
import type { WorkspaceFiles } from "../files/workspace-files.js";
import { registerWorkspaceRoutes } from "./workspaces.js";

export function registerFileRoutes(app: FastifyInstance, ctx: ServerContext, files: WorkspaceFiles) {
  type ById = { Params: { id: string } };
  const auth = scopedAccess(ctx);
  registerWorkspaceRoutes(app, ctx, files);
  app.register(multipart, { limits: { fileSize: 16 * 1024 * 1024, files: 1, fields: 0, parts: 1 } });
  app.addHook("onClose", async () => files.close());
  app.get<ById & {Querystring:{q?:string}}>("/api/workspaces/:id/files/search",auth,async req=>{
    const q=req.query.q??"";
    if (typeof q!=="string" || q.length>180) throw fileError(400,"Invalid file query.");
    const root=await files.getRoot(req.params.id);
    const needle=q.trim().toLowerCase();
    const results:string[]=[];
    const directories=[".codex-uploads",""];
    let visited=0;
    for (let i=0;i<directories.length && visited<12000 && results.length<150;i++) {
      const relative=directories[i];
      const absolute=await resolveSafeWorkspacePath(root,relative);
      const entries=await readdir(absolute,{withFileTypes:true}).catch(e=>{if(missing(e))return [];throw e;});
      for (const entry of entries) {
        if (++visited>12000) break;
        const name=entry.name;
        if (entry.isSymbolicLink() || ignored.has(name.toLowerCase()) || [".codex-uploads","dist","coverage",".next"].includes(name)) continue;
        const child=path.posix.join(relative,name);
        if (entry.isDirectory()) {directories.push(child);continue;}
        const lower=child.toLowerCase();
        let position=-1;
        if (!entry.isFile() || ![...needle].every(char=>(position=lower.indexOf(char,position+1))>=0)) continue;
        await resolveSafeWorkspacePath(root,child);
        results.push(child);
        if(results.length>=150) break;
      }
    }
    results.sort((a,b)=>Number(b.toLowerCase().includes(needle))-Number(a.toLowerCase().includes(needle))||a.length-b.length||a.localeCompare(b));
    return {files:results.slice(0,50)};
  });
  app.get<ById & { Querystring: { path?: string } }>("/api/workspaces/:id/files/tree", auth, async req => {
    const root = await files.getRoot(req.params.id);
    const params = fileTreeQuerySchema.safeParse(req.query);
    if (!params.success) throw fileError(400, "Invalid directory path.");
    const rel = params.data.path;
    const dir = await resolveSafeWorkspacePath(root, rel);
    if (ignored.has(path.basename(dir).toLowerCase())) throw fileError(403, "Directory is excluded.");
    const entries = await readdir(dir, { withFileTypes: true }).catch(error => {
      if (missing(error)) throw fileError(404, "Directory not found.");
      throw error;
    });
    return entries.filter(e => !ignored.has(e.name.toLowerCase())).map(e => ({
      path: path.posix.join(rel.replaceAll("\\","/"), e.name), name: e.name,
      type: e.isSymbolicLink() ? "symlink" : e.isDirectory() ? "directory" : "file",
    })).sort((a,b) => a.name.localeCompare(b.name));
  });
  app.get<ById>("/api/workspaces/:id/files/content", auth, async req => {
    const q = filePathQuerySchema.safeParse(req.query);
    if (!q.success) throw fileError(400, "Invalid path.");
    return {path:q.data.path,mime_type:lookup(q.data.path) || "application/octet-stream",
      ...await readEditable(await files.getRoot(req.params.id),q.data.path,ctx.masker)};
  });
  app.put<ById & { Body: { path?: string; content: string }; Querystring: { path?: string } }>("/api/workspaces/:id/files/content", auth, async req => {
    const p = fileSaveSchema.safeParse({ path: req.query.path ?? req.body?.path, content: req.body?.content });
    if (!p.success) throw fileError(400, "Expected a path and UTF-8 content.");
    const revision = await writeEditable(await files.getRoot(req.params.id),p.data.path,p.data.content,req.headers["if-match"],ctx.masker);
    return { path:p.data.path, revision };
  });
  app.post<ById>("/api/workspaces/:id/files/upload", auth, async (req, reply) => {
    const root = await files.getRoot(req.params.id);
    const part = await req.file();
    if (!part) throw fileError(400, "A file is required.");
    const safeName = path.win32.basename(part.filename).replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/[. ]+$/, "").slice(0,128) || "file";
    const rel = ".codex-uploads/" + Date.now() + "-" + randomUUID() + "-" + safeName;
    const buffer = await part.toBuffer();
    if (part.file.truncated) throw fileError(413, "File exceeds upload limit.");
    const finish=scopedGuest(req) && beginGuestUpload(ctx,req.params.id);
    try {await saveWorkspaceFile(root,rel,buffer);}
    finally {finish?.();}
    const artifact = await files.registerArtifact(req.params.id, null, null, rel, "upload");
    return reply.code(201).send({ path: rel, artifact });
  });
  app.post("/api/artifacts/sign", auth, async req => {
    const p = artifactSignSchema.safeParse(req.body);
    if (!p.success) throw fileError(400, "Invalid artifact or turn.");
    const subject = "artifact_id" in p.data ? {kind:"artifact" as const,id:p.data.artifact_id} : {kind:"turn" as const,id:p.data.turn_id};
    const artifacts=files.artifactsFor(subject), guest=scopedGuest(req);
    if(guest){
      if(artifacts.some(a=>!guest.link.workspace_ids.includes(a.workspace_id))) throw fileError(403,"Workspace outside invitation scope.");
      return {download_url:signDownload({...subject,guest_id:guest.link.id},ctx.masterKey,p.data.ttl_seconds)};
    }
    return { download_url: signDownload(subject, ctx.masterKey, p.data.ttl_seconds) };
  });
  app.get<{ Params: { "*": string } }>("/api/dl/*", async (req, reply) => {
    const subject = validateDownload(req.params["*"], ctx.masterKey);
    const artifacts = files.artifactsFor(subject);
    const guest=scopedGuest(req);
    if(subject.guest_id && guest?.link.id!==subject.guest_id || guest && artifacts.some(a=>!guest.link.workspace_ids.includes(a.workspace_id)))
      throw fileError(403,"Guest download unavailable.");
    reply.header("Cache-Control", "private, no-store").header("X-Content-Type-Options", "nosniff");
    if (subject.kind === "artifact") {
      const item = artifacts[0];
      const handle = await files.openArtifact(item.id);
      return reply.type(item.mime_type ?? "application/octet-stream")
        .header("Content-Disposition", "attachment; filename*=UTF-8''" + encodeURIComponent(item.name))
        .send(handle.createReadStream());
    }
    const zip = new yazl.ZipFile();
    const seen = new Set<string>();
    for (const item of artifacts) {
      if (seen.has(item.path)) continue;
      seen.add(item.path);
      const handle = await files.openArtifact(item.id);
      await handle.close();
      zip.addReadStreamLazy(item.path, {}, callback => {
        void files.openArtifact(item.id).then(handle => { callback(null, handle.createReadStream()); }, error => { zip.emit("error", error); });
      });
    }
    zip.on("error", error => (zip.outputStream as Readable).destroy(error));
    zip.end();
    return reply.type("application/zip").header("Content-Disposition",'attachment; filename="artifacts.zip"').send(zip.outputStream);
  });
}
