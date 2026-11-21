import { createServer } from "node:https";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { workspaceFile } from "./paths.js";

/** The HTTPS socket enters the same hooks, WS subscriptions and task manager as local HTTP. */
export async function listenPublicTls(app:FastifyInstance, data:string, privatePort:number, host="0.0.0.0") {
  const value=process.env.CODEXDECK_TLS_PORT;
  if (!value) return;
  const port=Number(value);
  if (!Number.isInteger(port) || port<1024 || port>65535 || port===privatePort) throw new Error("Invalid public TLS port.");
  const key=await readFile(await workspaceFile(data,path.join(data,"panel-tls.key")));
  const cert=await readFile(await workspaceFile(data,path.join(data,"panel-tls.crt")));
  const server=createServer({key,cert,minVersion:"TLSv1.2"},app.routing);
  server.on("upgrade",(req,socket,head)=>{
    if (!app.server.emit("upgrade",req,socket,head)) socket.destroy();
  });
  await new Promise<void>((resolve,reject)=>{
    server.once("error",reject);
    server.listen(port,host,()=>{server.off("error",reject);resolve();});
  });
  return server;
}
