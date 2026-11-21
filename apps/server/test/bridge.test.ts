import { installationCode } from "../src/routes/auth.js";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer as httpServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import Fastify from "fastify";
import { afterEach,beforeEach,expect,it,vi } from "vitest";
import { parseGatewayConfig, type ServerContext } from "../src/app.js";
import { registerAuthRoutes } from "../src/routes/auth.js";
import {registerSettingsRoutes} from "../src/settings/routes.js";
import { registerThreadRoutes } from "../src/routes/threads.js";
import { registerConsoleRoutes } from "../src/routes/console.js";
import { registerGatewayRoutes } from "../src/gateway/server.js";
import { openDatabase, resolveDataDirectory } from "../src/db/index.js";
import { ThreadManager } from "../src/codex/manager.js";
import { RpcClient } from "../src/codex/rpc-client.js";
import { WorkspaceFiles } from "../src/files/workspace-files.js";
import { ThreadEvents } from "../src/ws/events.js";
import { Notifications } from "../src/notifications/index.js";
import { SecretMasker } from "../src/security/secret-masker.js";
import { encryptSecret } from "../src/security/crypto.js";
import {completeAnswer,turnEvents} from "../src/codex/timeline.js";
import {projectTurn} from "@codexdeck/shared";
import {collectVerification,runVerifyGate} from "../src/codex/verify-gate.js";
import {registerWorkspaceRoutes} from "../src/routes/workspaces.js";
import {registerWorkspaceSecretRoutes} from "../src/security/workspace-secrets.js";

const fake = fileURLToPath(new URL("../tests/fixtures/fake-app-server.mjs",import.meta.url));
let root: string, ctx: ServerContext, app: ReturnType<typeof Fastify>, manager: ThreadManager;
let mock: ReturnType<typeof httpServer>, workspace: string, thread: string, cookie: string;
let upstream: string[], notices: string[];
let gate:typeof runVerifyGate;
beforeEach(async () => {
  gate=runVerifyGate;
  root = await mkdtemp(path.join(tmpdir(),"codexdeck-bridge-"));
  const data = await resolveDataDirectory("data",root);
  ctx = { ...await openDatabase(data,root),gatewayConfig:parseGatewayConfig(),masterKey:randomBytes(32),masker:new SecretMasker() };
  app = Fastify();
  upstream = []; notices = [];
  mock = httpServer(async (request,response) => {
    let data = ""; for await (const chunk of request) data += chunk;
    const body = JSON.parse(data);
    if (request.url === "/notice") { notices.push(body.event); response.end("ok"); return; }
    upstream.push(body.model);
    response.setHeader("content-type","application/json");
    if(String(body.instructions??"").startsWith("Produce a concise structured handoff")) {
      response.end(JSON.stringify({status:"completed",output:[{type:"message",content:[{type:"output_text",text:"Preserve the verified result.txt artifact."}]}]}));return;
    }
    response.end(JSON.stringify({id:"test",object:"response",status:"completed",model:body.model,output:[]}));
  });
  mock.listen(0,"127.0.0.1"); await once(mock,"listening");
  const base = "http://127.0.0.1:" + (mock.address() as AddressInfo).port;
  ctx.native.prepare(`INSERT INTO providers(id,name,preset,base_url,headers_json,quirks_json,enabled,created_at,updated_at)
    VALUES('p','p','custom',?,'{}','{}',1,'','')`).run(base + "/v1");
  ctx.native.exec(`INSERT INTO models(id,provider_id,alias,model_id,protocol,created_at,updated_at) VALUES
    ('a','p','aaa','real-a','responses','',''),('b','p','bbb','real-b','responses','','')`);
  ctx.native.prepare(`INSERT INTO notification_channels(id,name,type,config_json,enabled,created_at,updated_at)
    VALUES('n','n','webhook',?,1,'','')`).run(encryptSecret(JSON.stringify({url:base+"/notice"}),ctx.masterKey));
  const events = new ThreadEvents(ctx);
  const files = new WorkspaceFiles(ctx,data,(t,k,p) => events.append(t,k,p));
  workspace = (await files.create("Test workspace","conservative")).id;
  manager = new ThreadManager(ctx,files,events,new Notifications(ctx),{
    dataDirectory:data,workspaceRoot:root,codexBin:fake,port:() => (app.server.address() as AddressInfo).port,
    approvalTimeoutMs:650, notifyAfterMs:30,verifyGate:opts=>gate(opts),
  });
  registerSettingsRoutes(app,ctx,manager,data);
  registerThreadRoutes(app,ctx,manager);
  registerWorkspaceRoutes(app,ctx,files);
  registerWorkspaceSecretRoutes(app,ctx);
  registerConsoleRoutes(app,ctx,files);
  registerAuthRoutes(app,ctx);
  registerGatewayRoutes(app,ctx);
  await app.listen({host:"127.0.0.1",port:0});
  const setup = await app.inject({method:"POST",url:"/api/auth/setup",payload:{ setup_code: installationCode(ctx.native,ctx.masterKey),password:"FixtureAdminPassword"}});
  cookie = String(setup.headers["set-cookie"]).split(";")[0];
  const created = await app.inject({method:"POST",url:"/api/threads",headers:{cookie},payload:{workspace_id:workspace,model_alias:"aaa"}});
  expect(created.statusCode).toBe(201);
  thread = created.json().id;
});
afterEach(async () => {
  await manager?.close();
  await app?.close();
  mock?.closeAllConnections();
  if (mock?.listening) await new Promise<void>(resolve => mock.close(() => resolve()));
  ctx?.native.close();
  if (root) await rm(root,{recursive:true,force:true});
});
const poll = (assertion:()=>void) => vi.waitFor(assertion,{timeout:6000,interval:15});
it("keeps accepted message IDs replayable and rejects new full-access turns when the executor is unavailable",async()=>{
  const url="/api/threads/"+thread+"/messages";
  const message={prompt:"hello",client_msg_id:randomUUID()};
  const accepted=await post(url,message);
  expect(accepted.statusCode).toBe(202);
  await poll(()=>expect(status(accepted.json().task_id)).toBe("completed"));
  ctx.native.prepare("UPDATE workspaces SET automation_level='unrestricted' WHERE id=?").run(workspace);
  vi.stubEnv("CODEXDECK_INSTALL_MODE","native");
  vi.stubEnv("CODEXDECK_BWRAP_PATH","/missing-test-executor/bwrap");
  try {
    expect((await post(url,message)).json().task_id).toBe(accepted.json().task_id);
    expect((await post(url,{...message,prompt:"different"})).statusCode).toBe(409);
    const rejected=await post(url,{prompt:"new message",client_msg_id:randomUUID()});
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().code).toBe("EXECUTOR_UNAVAILABLE");
    expect(ctx.native.prepare("SELECT count(*) FROM tasks WHERE thread_id=?").pluck().get(thread)).toBe(1);
  } finally {vi.unstubAllEnvs();}
});
it("runs a read-only plan, revises it and admits exactly one write turn after approval",async()=>{
  const base="/api/threads/"+thread;
  const first=await post(base+"/messages",{mode:"plan",prompt:"计划更新 result.txt"});
  expect(first.statusCode).toBe(202);
  await poll(()=>expect(status(first.json().task_id)).toBe("completed"));
  expect(events("fixture/process").at(-1)).toMatchObject({sandbox:"read-only",approvalPolicy:"never",hasOps:false,opsConfigured:false});
  expect(ctx.native.prepare("SELECT count(*) FROM checkpoints WHERE thread_id=?").pluck().get(thread)).toBe(0);
  const quality=await app.inject({url:base+"/quality",headers:{cookie}});
  expect(quality.json().plan).toMatchObject({turn_id:first.json().task_id,status:"ready",markdown:expect.stringContaining("风险与验收")});
  expect((await post(base+"/messages",{prompt:"直接执行",mode:"execute"})).statusCode).toBe(409);
  const revised=await post(base+"/plan/revise",{turn_id:first.json().task_id,feedback:"增加测试"});
  expect(revised.statusCode).toBe(202);await poll(()=>expect(status(revised.json().task_id)).toBe("completed"));
  expect((await post(base+"/plan/approve",{turn_id:first.json().task_id})).statusCode).toBe(409);
  const payload={turn_id:revised.json().task_id};
  const [one,two]=await Promise.all([post(base+"/plan/approve",payload),post(base+"/plan/approve",payload)]);
  expect(one.statusCode).toBe(202);expect(two.json().task_id).toBe(one.json().task_id);
  await poll(()=>expect(status(one.json().task_id)).toBe("completed"));
  expect(events("fixture/process").at(-1)).toMatchObject({sandbox:"workspace-write",approvalPolicy:"on-request",hasOps:true});
  expect((await app.inject({url:base+"/quality",headers:{cookie}})).json().plan).toBeNull();
},20000);

const fixtureRunner=String.raw`
let job="";process.stdin.on("data",c=>job+=c).once("end",()=>{
  const {commands,env}=JSON.parse(job);
  const send=x=>console.log(JSON.stringify(x));
  for(const [index,c] of commands.entries()) {
    send({kind:"start",index});
    const value=env.QUALITY_TEST??"no credential";
    for(const text of [value.slice(0,5),value.slice(5)]) send({kind:"output",index,stream:"stdout",text});
    if(c==="wait") {setTimeout(()=>{},30000);return;}
    send({kind:"end",index,code:c==="fail"?1:0});if(c==="fail")break;
  }
});`;

it("detects safe manifest scripts and streams bounded retries with masked verification output",async()=>{
  const base="/api/workspaces/"+workspace;
  const workspacePath=String(ctx.native.prepare("SELECT path FROM workspaces WHERE id=?").pluck().get(workspace));
  await writeFile(path.join(workspacePath,"package.json"),JSON.stringify({packageManager:"pnpm@11",scripts:{test:"ignored",lint:"ignored"}}));
  expect((await post(base+"/verify-commands/detect")).json()).toEqual({commands:["pnpm run lint","pnpm run test"]});
  const secret="fixture-opaque-value-for-check";
  expect((await post(base+"/secrets",{key_name:"QUALITY_TEST",value:secret,inject_on_verify:true})).statusCode).toBe(201);
  const cfg=await app.inject({method:"PATCH",url:base+"/quality",headers:{cookie},payload:{verify_commands:["fail"],auto_verify_enabled:true,max_self_heal_retries:2}});
  expect(cfg.statusCode).toBe(200);
  const granted:string[][]=[];
  gate=async opts=>{
    granted.push(Object.keys(opts.env));return collectVerification(opts,{file:process.execPath,args:["-e",fixtureRunner],env:{},stop:async()=>{}});
  };
  const first=await submit("change a file");
  await poll(()=>expect(events("verify_gate_result")).toHaveLength(3));
  const results=events("verify_gate_result");
  expect(results.map(r=>[r.status,r.attempt])).toEqual([["repairing",0],["repairing",1],["failed",2]]);
  expect(results.every(r=>r.commands[0].output==="[REDACTED]")).toBe(true);
  expect(granted).toEqual(Array.from({length:3},()=>["QUALITY_TEST"]));
  expect(ctx.native.prepare("SELECT count(*) FROM tasks WHERE verify_root_id=?").pluck().get(first)).toBe(2);
  expect(JSON.stringify(ctx.native.prepare("SELECT * FROM thread_events").all())).not.toContain(secret);
},25000);

it("keeps external verification credential-free until an administrator reviews the workspace",async()=>{
  const base="/api/workspaces/"+workspace;
  await post(base+"/secrets",{key_name:"QUALITY_TEST",value:"fixture-safe-value",inject_on_verify:true});
  await app.inject({method:"PATCH",url:base+"/quality",headers:{cookie},payload:{verify_commands:["pass"],auto_verify_enabled:true}});
  gate=opts=>collectVerification(opts,{file:process.execPath,args:["-e",fixtureRunner],env:{},stop:async()=>{}});
  const first=manager.submit(thread,"external change").task_id;
  ctx.native.prepare("INSERT INTO api_keys(id,name,key_hash,scopes_json,created_at) VALUES('external','test','unique','[]','')").run();
  ctx.native.prepare("UPDATE tasks SET api_key_id='external' WHERE id=?").run(first);
  await poll(()=>expect(status(first)).toBe("completed"));
  expect(events("verify_gate_result").at(-1)).toMatchObject({status:"passed",requires_review:true,commands:[{output:"no credential"}]});
  const retry=await post("/api/threads/"+thread+"/verify",{turn_id:first,reviewed:true});
  expect(retry.statusCode).toBe(202);await poll(()=>expect(status(retry.json().task_id)).toBe("completed"));
  expect(events("verify_gate_result").at(-1)).toMatchObject({requires_review:false,commands:[{output:"[REDACTED]"}]});
},15000);

it("interrupts verification and never queues a repair after cancellation",async()=>{
  await app.inject({method:"PATCH",url:"/api/workspaces/"+workspace+"/quality",headers:{cookie},payload:{verify_commands:["wait"],auto_verify_enabled:true}});
  gate=opts=>collectVerification(opts,{file:process.execPath,args:["-e",fixtureRunner],env:{},stop:async()=>{}});
  const first=await submit("change and wait");
  await poll(()=>expect(events("verify_gate_progress").length).toBeGreaterThan(0));
  expect((await post("/api/threads/"+thread+"/interrupt")).statusCode).toBe(204);
  await poll(()=>expect(status(first)).toBe("cancelled"));
  expect(events("verify_gate_result").at(-1)).toMatchObject({status:"cancelled",attempt:0});
  expect(ctx.native.prepare("SELECT count(*) FROM tasks WHERE verify_root_id=?").pluck().get(first)).toBe(0);
});
async function post(path: string, payload: Record<string,unknown> = {}) {
  return app.inject({method:"POST",url:path,headers:{cookie},payload});
}
async function submit(prompt: string, threadId = thread) {
  const result = await post("/api/threads/" + threadId + "/messages",{prompt});
  expect(result.statusCode).toBe(202);
  return String(result.json().task_id);
}
function status(id: string) {
  return ctx.native.prepare("SELECT status FROM tasks WHERE id=?").pluck().get(id);
}
function events(type: string) {
  return (ctx.native.prepare("SELECT payload_json FROM thread_events WHERE thread_id=? AND type=? ORDER BY sequence")
    .pluck().all(thread,type) as string[]).map(text => JSON.parse(text));
}
async function pending() {
  const stmt = ctx.native.prepare("SELECT id FROM approvals WHERE status='pending' AND thread_id=?").pluck();
  await poll(() => expect(stmt.get(thread)).toBeTruthy()); return String(stmt.get(thread));
}
async function decision(id: string, action: string, guidance?: string) {
  const result = await post("/api/approvals/" + id + "/decision",{decision:action,user_guidance:guidance});
  expect(result.statusCode).toBe(204);
}
it("opens history without waking Codex, deduplicates focus and correlates the first optimistic message",async()=>{
  const http="/api/threads/"+thread;
  const get=(url:string)=>app.inject({url,headers:{cookie}});
  const empty=await get(http+"/turns");
  expect(empty.json()).toMatchObject({turns:[],latest_seq_id:0,has_more:false,active_turn:null});
  await get(http+"/history");
  expect(events("fixture/process")).toHaveLength(0);
  await Promise.all([post(http+"/warmup"),post(http+"/warmup")]).then(res=>expect(res.map(r=>r.statusCode)).toEqual([204,204]));
  await poll(()=>expect(events("fixture/process")).toHaveLength(1));
  const request={prompt:"核对  所有  工作区中的历史回合和最终交付物，保留后续计划安排",client_msg_id:randomUUID()};
  const response=await Promise.all([post(http+"/messages",request),post(http+"/messages",request)]);
  const id=response[0].json().task_id as string;
  expect(response.every(r=>r.statusCode===202&&r.json().task_id===id&&r.json().client_msg_id===request.client_msg_id)).toBe(true);
  expect((await post(http+"/messages",{...request,prompt:"changed"})).statusCode).toBe(409);
  await poll(()=>expect(status(id)).toBe("completed"));
  const result=(await get(http+"/turns")).json();
  expect(result.turns).toHaveLength(1);
  expect(result.turns[0]).toMatchObject({id,client_msg_id:request.client_msg_id,user_content:request.prompt,status:"completed"});
  expect(events("task_queued")).toEqual([{task_id:id,client_msg_id:request.client_msg_id}]);
  const title=Array.from(request.prompt.replace(/\s+/g," ")).slice(0,24).join("");
  expect(events("thread_updated")).toEqual([expect.objectContaining({title})]);
  expect(ctx.native.prepare("SELECT title FROM threads WHERE id=?").pluck().get(thread)).toBe(title);
  expect(events("fixture/process")).toHaveLength(1);
});
it("activates a warm session lease only while its assigned turn uses the client",async()=>{
  const spawn=vi.spyOn(RpcClient,"start");
  const before=WorkspaceFiles.prototype.beforeTurn;
  let resume!:()=>void;
  const barrier=new Promise<void>(resolve=>{resume=resolve;});
  const checkpoint=vi.spyOn(WorkspaceFiles.prototype,"beforeTurn").mockImplementationOnce(async function(this:WorkspaceFiles,...args){
    await barrier;
    return before.apply(this,args);
  });
  try {
    await manager.warmup(thread);
    const lease=spawn.mock.calls[0]![1].CODEXDECK_INTERNAL_TOKEN!;
    const authorized=()=>Boolean(ctx.resolveSessionLease!(lease,"model"));
    expect(authorized()).toBe(false);
    const task=await submit("wait");
    await poll(()=>expect(checkpoint).toHaveBeenCalledOnce());
    expect(authorized()).toBe(false);
    resume();
    await poll(()=>expect(authorized()).toBe(true));
    await manager.cancel(task);
    await poll(()=>expect(status(task)).toBe("cancelled"));
    expect(authorized()).toBe(false);
  } finally {resume();checkpoint.mockRestore();spawn.mockRestore();}
});

it("kills only the selected live process and releases its workspace for queued work",async()=>{
  expect((await app.inject("/api/admin/runtime/tasks")).statusCode).toBe(401);
  const waiting=await submit("wait");
  await poll(()=>expect(events("item/agentMessage/delta")).toContainEqual(expect.objectContaining({delta:"started!"})));
  const tasks=(await app.inject({url:"/api/admin/runtime/tasks",headers:{cookie}})).json();
  expect(tasks).toEqual([expect.objectContaining({thread_id:thread,task_id:waiting,workspace_id:workspace,pid:expect.any(Number)})]);
  const queued=await submit("next task");
  expect((await post("/api/admin/runtime/tasks/"+thread+"/kill")).json()).toMatchObject({terminated:true,task_id:waiting});
  await poll(()=>expect(status(waiting)).toBe("cancelled"));
  await poll(()=>expect(status(queued)).toBe("completed"));
  expect((await post("/api/admin/runtime/tasks/"+thread+"/kill")).statusCode).toBe(404);
  expect((await app.inject({url:"/api/admin/runtime/tasks",headers:{cookie}})).json()).toEqual([]);
});

it("keeps command output out of the initial HTTP page and requires the correct turn for step details",async()=>{
  const id=randomUUID();
  const http="/api/threads/"+thread+"/turns";
  const get=(url:string)=>app.inject({url,headers:{cookie}});
  ctx.native.prepare("INSERT INTO tasks(id,workspace_id,thread_id,prompt,status,created_at,updated_at) VALUES(?,?,?,'hello','completed','','')")
    .run(id,workspace,thread);
  const source=new ThreadEvents(ctx);
  const log="result "+randomUUID();
  source.append(thread,"item/completed",{item:{id:"command",type:"commandExecution",command:"read",aggregatedOutput:log}},id);
  source.append(thread,"task_completed",{task_id:id},id);
  const initial=await get(http);
  expect(initial.statusCode).toBe(200);
  expect(initial.payload).not.toContain(log);
  const entry=initial.json().turns[0];
  expect(entry.timeline[0].operations[0]).toMatchObject({id:"command",detail:""});
  expect((await get("/api/turns/"+id+"/steps/command")).json().detail).toContain(log);
  expect((await get("/api/turns/"+id+"/steps/missing")).statusCode).toBe(404);
  expect((await app.inject("/api/turns/"+id+"/steps/command")).statusCode).toBe(401);
  expect((await get(http+"?limit=0")).statusCode).toBe(400);
  expect((await get(http+"?before_turn_index="+entry.turn_index)).json().turns).toHaveLength(0);
  expect(events("fixture/process")).toHaveLength(0);
});

it("steers and interrupts a live turn, hot-switches the real gateway without respawning, and resumes after a crash", async () => {
  const waiting = await submit("wait");
  await poll(() => expect(events("item/agentMessage/delta")).toContainEqual(expect.objectContaining({delta:"started!"})));
  expect((await post("/api/threads/"+thread+"/inject",{prompt:"new direction!"})).statusCode).toBe(204);
  await poll(() => expect(events("item/agentMessage/delta").at(-1).delta).toBe("guidance:new direction!"));
  expect((await post("/api/threads/"+thread+"/interrupt")).statusCode).toBe(204);
  await poll(() => expect(status(waiting)).toBe("cancelled"));
  const a = await submit("gateway");
  await poll(() => expect(status(a)).toBe("completed"));
  const processCount=events("fixture/process").length;
  const changed = await app.inject({method:"PATCH",url:"/api/threads/"+thread+"/model",headers:{cookie},payload:{model_alias:"bbb",reasoning_effort:"high"}});
  expect(changed.statusCode).toBe(200);
  const b = await submit("gateway");
  await poll(() => expect(status(b)).toBe("completed"));
  expect(upstream).toEqual(["real-a","real-b"]);
  expect(events("fixture/process")).toHaveLength(processCount);
  const crash = await submit("crash");
  await poll(() => expect(status(crash)).toBe("failed"));
  await poll(() => expect(events("fixture/process")).toHaveLength(processCount+1));
  const process = events("fixture/process");
  expect(process.at(-1)).toMatchObject({threadId:process[0].threadId,method:"thread/resume"});
  expect(process.at(-1).pid).not.toBe(process.at(-2).pid);
  const after = await submit("gateway");
  await poll(() => expect(status(after)).toBe("completed"));
});
it("serves approvals over two-way RPC, remembers scoped rules, delivers guidance and timeout reminders",async () => {
  for (const [command,action] of [["git diff --stat","approve"],["pnpm test","approve_session"]]) {
    const task = await submit("approve:"+command);
    const id=await pending();
    const approval=(await app.inject({url:"/api/approvals",headers:{cookie}})).json().find((row:{id:string})=>row.id===id);
    expect(Date.parse(approval.expires_at)).toBeGreaterThan(Date.parse(approval.created_at));
    expect(events("approval_req").at(-1).expires_at).toBe(approval.expires_at);
    await decision(id,action);
    await poll(() => expect(status(task)).toBe("completed"));
  }
  const allowed = await submit("approve:pnpm test");
  await poll(() => expect(status(allowed)).toBe("completed"));
  expect(events("approval_req")).toHaveLength(2);
  const denied = await submit("approve:pnpm build");
  await decision(await pending(),"deny_guide","use the existing build");
  await poll(() => expect(status(denied)).toBe("completed"));
  expect(ctx.native.prepare("SELECT assistant_markdown FROM thread_turns WHERE id=?").pluck().get(denied)).toContain("guidance:use the existing build");
  expect(events("fixture/approval").at(-1).decision).toBe("decline");
  const aborted = await submit("approve:pnpm test && other");
  await decision(await pending(),"abort");
  await poll(() => expect(status(aborted)).toBe("cancelled"));
  const timed = await submit("approve:pnpm install");
  await poll(() => expect(status(timed)).toBe("completed"));
  expect(events("approval_resolved").at(-1).decision).toBe("timeout");
  expect(events("fixture/approval").at(-1).decision).toBe("decline");
  expect(notices).toContain("approval_pending");
});
it("recovers queued work once, expires disconnected approvals and records interrupted host work without replay",async () => {
  const insert = ctx.native.prepare("INSERT INTO tasks(id,thread_id,workspace_id,prompt,status,summary,created_at,updated_at) VALUES(?,?,?,?,?,'','','')");
  insert.run("stale",thread,workspace,"gateway","running");
  insert.run("queued",thread,workspace,"normal turn","queued");
  ctx.native.prepare("INSERT INTO approvals(id,thread_id,action,payload_json,status,created_at,risk_level) VALUES('orphan',?,'ops','{}','pending','','high')").run(thread);
  manager.recover(); manager.recover();
  expect(status("stale")).toBe("failed");
  expect(ctx.native.prepare("SELECT status FROM approvals WHERE id='orphan'").pluck().get()).toBe("disconnected");
  await poll(() => expect(status("queued")).toBe("completed"));
  expect(upstream).toEqual([]);
  expect(events("task_completed")).toHaveLength(1);
});

it("serializes different threads in one workspace and cancels waiting turns",async () => {
  const second = manager.createThread(workspace,"aaa").id;
  const first = await submit("wait");
  const next = await submit("one",second);
  const skipped = await submit("two",second);
  await poll(() => expect(events("item/agentMessage/delta")).toHaveLength(1));
  expect(status(next)).toBe("queued"); await manager.cancel(skipped); expect(status(skipped)).toBe("cancelled");
  await manager.cancel(first);
  await poll(() => expect(status(next)).toBe("completed"));
  expect(ctx.native.prepare("SELECT count(*) FROM artifacts WHERE thread_id=?").pluck().get(second)).toBe(1);
});

it("compacts into a fresh resumable runtime, rejects concurrent work and keeps the full local history",async()=>{
  const first=await submit("verify changes");
  await poll(()=>expect(status(first)).toBe("completed"));
  const old=ctx.native.prepare("SELECT remote_thread_id FROM threads WHERE id=?").pluck().get(thread);
  const [compact,duplicate]=await Promise.all([post(`/api/threads/${thread}/compact`,{model_alias:"bbb"}),post(`/api/threads/${thread}/compact`,{model_alias:"bbb"})]);
  expect(compact.statusCode,compact.body).toBe(200);
  expect(duplicate.json()).toEqual(compact.json());
  expect(compact.json()).toMatchObject({summary:"Preserve the verified result.txt artifact.",estimated:true});
  expect(upstream.at(-1)).toBe("real-b");
  expect(ctx.native.prepare("SELECT remote_thread_id FROM threads WHERE id=?").pluck().get(thread)).not.toBe(old);
  expect((await post(`/api/threads/${thread}/compact`)).json()).toEqual(compact.json());
  expect(upstream.filter(name=>name==="real-b")).toHaveLength(1);
  const next=await submit("check handoff");
  await poll(()=>expect(status(next)).toBe("completed"));
  const answer=ctx.native.prepare("SELECT answer_markdown FROM tasks WHERE id=?").pluck().get(next);
  expect(answer).toContain("Preserve the verified result.txt artifact.");expect(answer).not.toContain("verify changes");
  const running=await submit("wait");
  await poll(()=>expect(status(running)).toBe("running"));
  expect((await post(`/api/threads/${thread}/compact`)).statusCode).toBe(409);
  expect((await app.inject({method:"DELETE",url:`/api/threads/${thread}`,headers:{cookie}})).statusCode).toBe(409);
  await manager.cancel(running);
  await poll(()=>expect(status(running)).toBe("cancelled"));
  const update=await app.inject({method:"PATCH",url:`/api/threads/${thread}`,headers:{cookie},payload:{pinned:true,title:"Reviewed"}});
  expect(update.json()).toMatchObject({pinned:true,title:"Reviewed"});
  expect((await app.inject({method:"DELETE",url:`/api/threads/${thread}`,headers:{cookie}})).statusCode).toBe(204);
});

it("uses persisted Codex effective windows, invalidates only on model switch, and masks legacy split answers on replay",async()=>{
  const id=await submit("test effective window");await poll(()=>expect(status(id)).toBe("completed"));
  const list=async()=>(await app.inject({url:"/api/threads",headers:{cookie}})).json()[0];
  expect(await list()).toMatchObject({last_context_tokens:16000,effective_context_window:64000});
  const select=async(payload:Record<string,string>)=>(await app.inject({method:"PATCH",url:`/api/threads/${thread}/model`,headers:{cookie},payload})).json();
  expect((await select({reasoning_effort:"high"})).effective_context_window).toBe(64000);
  expect(await select({model_alias:"bbb"})).toMatchObject({effective_context_window:null,last_context_tokens:null});
  expect(await select({model_alias:"aaa"})).toMatchObject({effective_context_window:null,last_context_tokens:null});
  const source=new ThreadEvents(ctx), fixtureSecret="fixture-sensitive-split-value";
  ctx.masker.register(fixtureSecret);
  const seq=source.append(thread,"item/agentMessage/delta",{itemId:"old",delta:"fixture-sensitive-"},id).seq_id;
  source.append(thread,"item/agentMessage/delta",{itemId:"old",delta:"split-value"},id);
  expect(completeAnswer(ctx.native,thread,id,ctx.masker)).toContain("[REDACTED]");
  const view=projectTurn(turnEvents(ctx.native,thread,id,ctx.masker,true));
  expect(view.answer).not.toContain(fixtureSecret);expect(JSON.stringify(view.debug)).not.toContain("fixture-sensitive-");
  const replayed:string[]=[];
  await new Promise<void>(resolve=>{const off=source.follow(thread,seq-1,e=>replayed.push(String((e.payload as {delta:string}).delta)),id,()=>{off();resolve();});});
  expect(replayed.join("")).toBe("[REDACTED]");
});
