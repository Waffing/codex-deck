import http from "node:http";
import { createReadStream } from "node:fs";
import { realpath,stat } from "node:fs/promises";
import path from "node:path";

const root = await realpath(process.argv[2]);
const port = Number(process.argv[3]);
const types:Record<string,string> = {".html":"text/html; charset=utf-8",".js":"text/javascript",".mjs":"text/javascript",".css":"text/css",".json":"application/json",".png":"image/png",".jpg":"image/jpeg",".svg":"image/svg+xml",".ico":"image/x-icon",".wasm":"application/wasm"};
const server = http.createServer(async (req,res) => {
  if (!["HEAD","GET"].includes(req.method ?? "")) { res.writeHead(405).end(); return; }
  try {
    const pieces = decodeURIComponent((req.url ?? "/").split("?")[0]).split("/");
    if (pieces.some(v=>v.startsWith(".") || /[\\:\0]/.test(v))) { res.writeHead(403).end(); return; }
    if (!pieces.at(-1)) pieces.push("index.html");
    const file = await realpath(path.join(root,...pieces));
    const relative = path.relative(root,file);
    if (!relative || relative === ".." || relative.startsWith(".."+path.sep) || path.isAbsolute(relative)) { res.writeHead(403).end(); return; }
    if (!(await stat(file)).isFile()) { res.writeHead(404).end(); return; }
    res.setHeader("content-type",types[path.extname(file)] ?? "application/octet-stream");
    if (req.method === "HEAD") res.end();
    else createReadStream(file).on("error",()=>res.destroy()).pipe(res);
  } catch { res.writeHead(404).end(); }
});
server.listen(port,"127.0.0.1",()=>process.send?.("ready"));
process.on("disconnect",()=>process.exit(0));
