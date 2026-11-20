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
import { createRequireAdmin } from "../auth.js";
import { fileError, ignored, missing, resolveSafeWorkspacePath, saveWorkspaceFile } from "../files/sandbox.js";
import { readEditable, writeEditable } from "../files/editor.js";
import { signDownload, validateDownload } from "../files/signed-url.js";
import type { WorkspaceFiles } from "../files/workspace-files.js";
import { registerWorkspaceRoutes } from "./workspaces.js";

export function registerFileRoutes(app: FastifyInstance, ctx: ServerContext, files: WorkspaceFiles) {
  type ById = { Params: { id: string } };
  const auth = { preHandler: createRequireAdmin(ctx) };
  registerWorkspaceRoutes(app, ctx, files);
  app.register(multipart, { limits: { fileSize: 16 * 1024 * 1024, files: 1, fields: 0, parts: 1 } });
  app.addHook("onClose", async () => files.close());
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
    await saveWorkspaceFile(root, rel, buffer);
    const artifact = await files.registerArtifact(req.params.id, null, null, rel, "upload");
    return reply.code(201).send({ path: rel, artifact });
  });
  app.post("/api/artifacts/sign", auth, async req => {
    const p = artifactSignSchema.safeParse(req.body);
    if (!p.success) throw fileError(400, "Invalid artifact or turn.");
    if ("artifact_id" in p.data) return { download_url: files.signArtifact(p.data.artifact_id, p.data.ttl_seconds) };
    const subject = { kind: "turn" as const, id: p.data.turn_id };
    files.artifactsFor(subject);
    return { download_url: signDownload(subject, ctx.masterKey, p.data.ttl_seconds) };
  });
  app.get<{ Params: { "*": string } }>("/api/dl/*", async (req, reply) => {
    const subject = validateDownload(req.params["*"], ctx.masterKey);
    const artifacts = files.artifactsFor(subject);
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
