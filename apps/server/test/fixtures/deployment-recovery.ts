import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { stagingInput, verificationInput } from "@codexdeck/shared";
import { openDatabase } from "../../src/db/index.js";
import { parseGatewayConfig } from "../../src/app.js";
import { WorkspaceFiles } from "../../src/files/workspace-files.js";
import { SecretMasker } from "../../src/security/secret-masker.js";
import { registerOps } from "../../src/server-ops/routes.js";

const [dir,mode] = process.argv.slice(2);
const db=await openDatabase(dir);
const ctx={...db,masker:new SecretMasker(),masterKey:randomBytes(32),gatewayConfig:parseGatewayConfig()};
const files=new WorkspaceFiles(ctx,dir,()=>{});
const app=Fastify();
await app.register(websocket);
const svc=registerOps(app,ctx,files,{append(){}},{async requestOpsApproval(){return true;}},
  {dataDirectory:dir,portPool:[21010,21100]});
const origin=await app.listen({host:"127.0.0.1",port:0});
if(mode==="seed") {
  const {id}=await files.create("Recovery","semi");
  const root=await files.getRoot(id);
  await mkdir(path.join(root,"public"));
  for(const marker of ["old","current"]) {
    await writeFile(path.join(root,"public","index.html"),marker);
    const d=await svc.deployer.stage(id,null,stagingInput.parse({mode:"local"}),svc.getProfile());
    await svc.deployer.promote(verificationInput.parse({deployment_id:d.id,expected_content:marker}));
  }
}
const live=svc.deployer.rows().find(row=>row.status==="live");
if(!live) throw new Error("Lost live deployment during startup");
process.send?.({url:origin+"/live/"+live.workspace_id+"/",id:live.id});
process.on("message",async action=>{
  if(action==="rollback") {await svc.deployer.rollback(live.id);process.send?.("done");}
  if(action==="close") {await app.close();db.native.close();process.disconnect();}
});
