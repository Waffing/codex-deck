import type { FileHandle } from "node:fs/promises";
import { basename, extname } from "node:path";
import { Readable } from "node:stream";
import { OutputMasker } from "../codex/output-masker.js";
import type { FastifyInstance, FastifyReply } from "fastify";
import { lookup } from "mime-types";
import type { ServerContext } from "../app.js";
import { createRequireAdmin } from "../auth.js";
import type { WorkspaceFiles } from "./workspace-files.js";
import { fileError, openWorkspaceFile } from "./sandbox.js";

const textTypes = new Set(["html", "htm", "svg", "csv", "md", "markdown", "mmd", "mermaid"]);
const binaryTypes = new Set(["docx", "xlsx", "xls", "pdf", "png", "jpg", "jpeg", "gif", "webp", "avif", "bmp"]);
const limit = 32 * 1024 * 1024;

export function previewHeaders(name: string) {
  const ext = extname(name).slice(1).toLowerCase();
  const mime = textTypes.has(ext) || binaryTypes.has(ext) ? lookup(name) || "text/plain" : "application/octet-stream";
  return {
    "Content-Type": mime + (/^text\/|svg/.test(mime) ? "; charset=utf-8" : ""),
    "Content-Security-Policy": "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; connect-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-DNS-Prefetch-Control": "off",
  };
}

// The same boundary-aware masker used for Codex output also covers credentials split between file chunks.
async function* maskedStream(handle: FileHandle, ctx: ServerContext) {
  const pending: string[] = [];
  const masker = new OutputMasker(ctx.masker, (_method, frame) => pending.push(String(frame.text)));
  for await (const chunk of handle.createReadStream({encoding:"utf8"})) {
    masker.push("stderr", {text:chunk});
    yield* pending.splice(0);
  }
  masker.flush();
  yield* pending;
}

export async function sendDocument(ctx: ServerContext, reply: FastifyReply, name: string, handle: FileHandle, download: boolean, beforeSend?: () => void) {
  const ext = extname(name).slice(1).toLowerCase();
  let streaming = false;
  try {
    const size = (await handle.stat()).size;
    if (size > limit && !download) throw fileError(413, "文件超过 32 MiB 预览上限。");
    let bytes: Buffer | undefined;
    let text = textTypes.has(ext);
    if (!text && !binaryTypes.has(ext)) {
      const sample = Buffer.alloc(Math.min(size, 8192));
      await handle.read(sample, 0, sample.length, 0);
      try {
        new TextDecoder("utf-8", {fatal:true}).decode(sample, {stream:true});
        text = !sample.includes(0);
      } catch { text = false; }
      if (!text && !download) throw fileError(415, "此二进制格式仅支持下载。");
    }
    if (text && size <= limit) {
      const original = Buffer.alloc(size);
      let read = 0;
      while (read < size) {
        const {bytesRead} = await handle.read(original, read, size-read, read);
        if (!bytesRead) break;
        read += bytesRead;
      }
      bytes = Buffer.from(ctx.masker.maskString(original.toString("utf8",0,read)));
    }
    beforeSend?.();
    reply.headers(previewHeaders(name));
    // Only a browser iframe navigation needs an executable document. Other consumers
    // get the same source bytes as inert text, including direct visits and fetch().
    if (["html","htm","svg"].includes(ext) && reply.request.headers["sec-fetch-dest"] !== "iframe")
      reply.type("text/plain; charset=utf-8");
    if (bytes || !text) reply.header("Content-Length", bytes?.length ?? size);
    if (download) reply.header("Content-Disposition", "attachment; filename*=UTF-8''" + encodeURIComponent(basename(name)));
    if (reply.request.method === "HEAD") return reply.send();
    if (bytes) return reply.send(bytes);
    const stream = text ? Readable.from(maskedStream(handle,ctx)) : handle.createReadStream();
    if (text) stream.once("close", () => { void handle.close().catch(()=>{}); });
    streaming = true;
    return reply.send(stream);
  } finally {
    if (!streaming) await handle.close();
  }
}

export function registerDocumentRoutes(app: FastifyInstance, ctx: ServerContext, files: WorkspaceFiles) {
  const auth = { preHandler: createRequireAdmin(ctx) };
  app.get<{ Params: { id: string }; Querystring: { download?: string } }>("/api/artifacts/:id/content", auth, async (req, reply) => {
    const [item] = files.artifactsFor({ kind: "artifact", id: req.params.id });
    return sendDocument(ctx, reply, item.name, await files.openArtifact(item.id), req.query.download === "1");
  });
  app.get<{ Params: { id: string }; Querystring: { path?: string; download?: string } }>("/api/workspaces/:id/files/preview", auth, async (req, reply) => {
    const name = req.query.path;
    if (typeof name !== "string" || name.length > 1024) throw fileError(400, "需要有效的工作区相对路径。");
    const ext = extname(name).slice(1).toLowerCase();
    if (!textTypes.has(ext) && !binaryTypes.has(ext)) throw fileError(415, "此格式请使用文本编辑器查看。");
    const root = await files.getRoot(req.params.id);
    return sendDocument(ctx, reply, name, await openWorkspaceFile(root, name), req.query.download === "1");
  });
}
