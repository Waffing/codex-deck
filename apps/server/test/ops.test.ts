import { installationCode } from "../src/routes/auth.js";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createServer as listener } from "node:net";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import WebSocket from "ws";
import { beforeAll,afterAll,expect,test } from "vitest";
import { deploymentCheckSchema } from "@codexdeck/shared";
import { openDatabase } from "../src/db/index.js";
import { SecretMasker } from "../src/security/secret-masker.js";
import { signPayload } from "../src/security/crypto.js";
import { registerAuthRoutes } from "../src/routes/auth.js";
import { parseGatewayConfig } from "../src/app.js";
import { WorkspaceFiles } from "../src/files/workspace-files.js";
import { registerOps, type OpsService } from "../src/server-ops/routes.js";
import { command, PortPool } from "../src/server-ops/probe.js";

const app=Fastify();
const secret="sk-"+randomBytes(16).toString("hex");
let dir:string, root:string, workspace:string, origin:string, cookie:string, token:string, service:OpsService;
let db:Awaited<ReturnType<typeof openDatabase>>;
let approve=true;
const requested:string[]=[];
let approvalCount=0;
let scoped="",clearScope=false;
beforeAll(async()=>{
  dir=await mkdtemp(path.join(tmpdir(),"codexdeck-ops-"));
  const data=path.join(dir,"data");await mkdir(data);
  db=await openDatabase(data,dir);
  const ctx={...db,masterKey:randomBytes(32),masker:new SecretMasker(),gatewayConfig:parseGatewayConfig(),
    resolveSessionLease:(value:string,kind:"model"|"ops")=>kind==="ops" && value==="cdlease_ops_fixture" ? scoped || null : null};
  ctx.masker.register(secret);
  const events={append:(_t:string,type:string)=>requested.push(type)};
  const files=new WorkspaceFiles(ctx,data,events.append);
  const record=await files.create("ops-fixture","semi");workspace=record.id;root=await files.getRoot(record.id);
  const now=new Date().toISOString();
  db.native.prepare("INSERT INTO threads(id,workspace_id,title,status,created_at,updated_at) VALUES('ops-thread',?,'test','idle',?,?)").run(workspace,now,now);
  token=signPayload({aud:"codexdeck-ops",thread_id:"ops-thread",iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+600},ctx.masterKey);
  scoped=signPayload({aud:"codexdeck-ops",thread_id:"ops-thread",task_id:"scoped-turn",iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+600},ctx.masterKey);
  await app.register(websocket);
  registerAuthRoutes(app,ctx);
  service=registerOps(app,ctx,files,events,{async requestOpsApproval(){approvalCount++;if(clearScope) scoped="";return approve;}},{dataDirectory:data,workspaceRoot:dir});
  origin=await app.listen({host:"127.0.0.1",port:0});
  const setup=await fetch(origin+"/api/auth/setup",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({ setup_code: installationCode(ctx.native,ctx.masterKey),password:"fixture-admin-1234"})});
  cookie=setup.headers.get("set-cookie")!.split(";")[0];
},30000);
afterAll(async()=>{
  await app.close();db?.native.close();
  if(dir) await rm(dir,{recursive:true,force:true});
});
function op(name:string,body:unknown={},credential=token) {
  return fetch(origin+"/internal/ops/"+name,{method:"POST",headers:{authorization:"Bearer "+credential,"content-type":"application/json"},body:JSON.stringify(body)});
}

test("expires revoked and inactive ops leases, including revocation while awaiting approval",async()=>{
  const credential="cdlease_ops_fixture";
  expect((await op("server_inspect",{},credential)).status).toBe(401);
  db.native.prepare("INSERT INTO tasks(id,workspace_id,thread_id,prompt,status,created_at,updated_at) VALUES('scoped-turn',?,'ops-thread','inspect','running','','')").run(workspace);
  expect((await op("server_inspect",{},credential)).status).toBe(200);
  clearScope=true;
  try {expect((await op("port_allocate",{},credential)).status).toBe(401);}
  finally {clearScope=false;db.native.prepare("DELETE FROM tasks WHERE id='scoped-turn'").run();}
  expect((await op("server_inspect",{},credential)).status).toBe(401);
});

test("preserves separate stdout and stderr when a deployment emits both streams",async()=>{
  const output=await command(process.execPath,["-e","console.log('ready');console.error('Traceback fixture')"],{logs:true});
  expect(output).toContain("[stdout] ready");expect(output).toContain("[stderr] Traceback fixture");
  expect(deploymentCheckSchema.parse({ok:true,checked_at:"2026-01-01"})).toEqual({ok:true,checked_at:"2026-01-01"});
});

test("records live runtime and port inventory; leases exclude protected, control and occupied ports",async()=>{
  const inspect=await (await op("server_inspect")).json();
  expect(inspect.cpu_count).toBeGreaterThan(0);
  expect(inspect.runtimes.node).toBe(process.version);
  expect(JSON.parse(await readFile(path.join(dir,"data","server-profile.json"),"utf8"))).toEqual(inspect);
  const pool=new PortPool([1,10005],()=>10000);
  for(const port of [22,80,443,10000]) expect(pool.safe(port)).toBe(false);
  const lease=await (await op("port_allocate")).json();
  const actual=listener().once("error",()=>{});
  const result=once(actual,"error");actual.listen(lease.port,"127.0.0.1");
  expect((await result)[0]).toMatchObject({code:"EADDRINUSE"});
  expect((await fetch(origin+"/preview/"+lease.port+"/",{headers:{cookie}})).status).toBe(403);
  expect((await fetch(origin+"/internal/ops/server_inspect",{method:"POST"})).status).toBe(401);
});

test("rejects host-process deployments in production by default",async()=>{
  const previousNodeEnv=process.env.NODE_ENV;
  const previousLocalDeployments=process.env.CODEXDECK_ALLOW_LOCAL_DEPLOYMENTS;
  process.env.NODE_ENV="production";
  delete process.env.CODEXDECK_ALLOW_LOCAL_DEPLOYMENTS;
  try {
    expect((await op("app_deploy_staging",{mode:"local"})).status).toBe(403);
  } finally {
    if(previousNodeEnv===undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV=previousNodeEnv;
    if(previousLocalDeployments===undefined) delete process.env.CODEXDECK_ALLOW_LOCAL_DEPLOYMENTS;
    else process.env.CODEXDECK_ALLOW_LOCAL_DEPLOYMENTS=previousLocalDeployments;
  }
});

test("stages immutable releases, previews managed ports, runs HTTP/log/browser checks, and restores previous live traffic on failed promotion",async()=>{
  const pub=path.join(root,"public");await mkdir(pub);await writeFile(path.join(pub,"index.html"),"release-A");
  const create=async()=>{const r=await op("app_deploy_staging",{mode:"local"});expect(await r.clone().text()).toContain("staging");return r.json();};
  const a=await create();
  const preview=origin+"/preview/"+a.port+"/";
  expect((await fetch(preview)).status).toBe(401);
  const positive=await fetch(preview,{headers:{cookie}});
  expect(await positive.text()).toBe("release-A");expect(positive.headers.get("content-security-policy")).toContain("sandbox");
  expect((await fetch(origin+"/preview/"+(new URL(origin).port)+"/",{headers:{cookie}})).status).toBe(403);
  db.native.prepare("INSERT INTO tasks(id,workspace_id,thread_id,prompt,status,created_at,updated_at) VALUES('ops-turn',?,'ops-thread','verify','running','','')").run(workspace);
  const report=await (await op("verify_url",{deployment_id:a.id,expected_content:"release-A",check_browser:true})).json();
  expect(report.http.status).toBe(200);expect(report.http.content_match).toBe(true);expect(report.logs.issues).toEqual([]);
  if(report.browser.status==="completed") {
    expect(report.browser.artifacts.length).toBe(2);
    for(const id of report.browser.artifacts) {
      const name=db.native.prepare("SELECT path FROM artifacts WHERE id=?").pluck().get(id) as string;
      expect(db.native.prepare("SELECT turn_id FROM artifacts WHERE id=?").pluck().get(id)).toBe("ops-turn");
      expect((await readFile(path.join(root,name))).subarray(1,4).toString()).toBe("PNG");
    }
  } else {
    expect(report.browser).toMatchObject({status:"unavailable",message:expect.stringContaining("Chromium")});
    expect(report.ok).toBe(false);
  }
  expect((await (await op("app_promote_live",{deployment_id:a.id})).json()).deployment.status).toBe("live");
  await writeFile(path.join(pub,"index.html"),"release-B");
  const restarted=await app.inject({method:"POST",url:"/api/deployments/"+a.id+"/action",headers:{cookie},payload:{action:"restart"}});
  expect(restarted.statusCode).toBe(200);
  expect(restarted.json()).toMatchObject({id:a.id,status:"live",last_verification:{ok:true}});
  expect(await (await fetch(origin+restarted.json().preview_url,{headers:{cookie}})).text()).toBe("release-A");
  const b=await create();approve=false;
  try {expect((await op("app_promote_live",{deployment_id:b.id})).status).toBe(403);}
  finally {approve=true;}
  const promotion=await (await op("app_promote_live",{deployment_id:b.id,path:"/missing.html"})).json();
  expect(promotion.verification.http.status).toBe(404);expect(promotion.deployment.status).toBe("rolled_back");
  expect(promotion.deployment.last_verification).toMatchObject({ok:false, http:{status:404},path:"/missing.html"});
  expect(await (await fetch(origin+"/live/"+workspace+"/")).text()).toBe("release-A");
  const html='<!doctype html><link rel="icon" href="data:,"><script>throw new Error("fixture page error")</script>release-C';
  await writeFile(path.join(pub,"index.html"),html);
  const c=await create();
  let done=false;
  const pending=op("app_promote_live",{deployment_id:c.id,expected_content:"release-C",check_browser:true}).then(r=>r.json()).finally(()=>{done=true;});
  do {
    expect(await (await fetch(origin+"/live/"+workspace+"/")).text()).toBe("release-A");
    await new Promise(r=>setTimeout(r,15));
  } while(!done);
  const blocked=await pending;
  expect(blocked.verification).toMatchObject({ok:false,http:{status:200,content_match:true}});
  if(blocked.verification.browser.status==="completed") expect(blocked.verification.browser.issues).toContain("fixture page error");
  expect(approvalCount).toBeGreaterThanOrEqual(4);
  expect(requested).toContain("ops_failed");
},30000);

test("starts a workspace Node HTTP entry and forwards GET, POST and WebSocket without admin cookies",async()=>{
  await mkdir(path.join(root,"node-app"));
  const source=[
    "const http=require('node:http'), crypto=require('node:crypto');",
    "const s=http.createServer((req,res)=>{res.setHeader('Set-Cookie','upstream=bad');if(req.headers.cookie || req.headers.authorization)res.end('bad');else if(req.method==='POST')req.pipe(res);else res.end('node-service');});",
    "s.on('upgrade',(req,socket)=>{const accept=crypto.createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: '+accept+'\\r\\n\\r\\n');socket.write(Buffer.from([129,2,79,75]));});",
    "s.listen(+process.env.PORT,process.env.HOST,()=>{console.log("+JSON.stringify(secret)+");console.error('UncaughtException fixture');});",
  ].join("\n");
  await writeFile(path.join(root,"node-app","app.cjs"),source);
  const result=await op("app_deploy_staging",{mode:"local",public_dir:"node-app",entry:"app.cjs"});
  expect(result.status).toBe(200); const appInfo=await result.json();
  const preview=origin+"/preview/"+appInfo.port+"/";
  const res=await fetch(preview,{method:"POST",headers:{cookie,authorization:"Bearer private","content-type":"text/plain"},body:"streamed body"});
  expect(await res.text()).toBe("streamed body");expect(res.headers.get("set-cookie")).toBeNull();
  const log=await op("app_logs",{deployment_id:appInfo.id});expect(await log.text()).not.toContain(secret);
  const blocked=await (await op("app_promote_live",{deployment_id:appInfo.id})).json();
  expect(blocked.verification).toMatchObject({ok:false,http:{status:200},logs:{issues:["[stderr] UncaughtException fixture"]}});
  const socket=new WebSocket(preview.replace("http:","ws:"),{headers:{cookie}});
  try {expect((await once(socket,"message"))[0].toString()).toBe("OK");} finally {socket.terminate();}
},30000);

test("stages entries in public and keeps existing workspace-root entries working",async()=>{
  const pub=path.join(root,"public");
  await mkdir(pub,{recursive:true});
  const serve=(label:string)=>`require("node:http").createServer((req,res)=>res.end(${JSON.stringify(label)})).listen(+process.env.PORT,process.env.HOST)`;
  const entry="serve-entry.cjs";
  await writeFile(path.join(pub,entry),serve("public entry"));
  async function stageAndRead() {
    const response=await op("app_deploy_staging",{mode:"local",entry});
    expect(response.status).toBe(200);
    const staged=await response.json();
    return (await fetch(origin+staged.preview_url,{headers:{cookie}})).text();
  }
  expect(await stageAndRead()).toBe("public entry");
  await writeFile(path.join(root,entry),serve("workspace entry"));
  expect(await stageAndRead()).toBe("workspace entry");
},30000);

test("exposes the seven tools through a real MCP stdio process and scoped HTTP callback",async()=>{
  const entry=fileURLToPath(new URL("../../../packages/ops-mcp/dist/index.js",import.meta.url));
  const child=spawn(process.execPath,[entry],{env:{SystemRoot:process.env.SystemRoot,CODEXDECK_OPS_URL:origin,CODEXDECK_OPS_TOKEN:token},stdio:["pipe","pipe","pipe"],windowsHide:true});
  const lines=createInterface({input:child.stdout});
  const queue=lines[Symbol.asyncIterator]();
  const send=(record:unknown)=>child.stdin.write(JSON.stringify(record)+"\n");
  async function call(id:number,method:string,params:unknown={}) {
    send({jsonrpc:"2.0",id,method,params});
    const row=await queue.next();expect(row.done).toBe(false);
    const data=JSON.parse(row.value!);expect(data.id).toBe(id);expect(data.error).toBeUndefined();return data.result;
  }
  try {
    await call(1,"initialize",{protocolVersion:"2025-03-26",capabilities:{},clientInfo:{name:"test",version:"1"}});
    send({jsonrpc:"2.0",method:"notifications/initialized"});
    const list=await call(2,"tools/list");expect(list.tools.length).toBe(7);
    const inspect=await call(3,"tools/call",{name:"server_inspect",arguments:{}});
    expect(JSON.parse(inspect.content[0].text).runtimes.node).toBe(process.version);
  } finally {lines.close();const exited=once(child,"exit");child.stdin.end();await exited;}
},15000);
