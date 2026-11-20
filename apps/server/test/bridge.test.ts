import { installationCode } from "../src/routes/auth.js";
import { randomBytes } from "node:crypto";
import { createServer as httpServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import Fastify from "fastify";
import { afterEach,beforeEach,expect,it,vi } from "vitest";
import { parseGatewayConfig, type ServerContext } from "../src/app.js";
import { registerAuthRoutes } from "../src/routes/auth.js";
import { registerThreadRoutes } from "../src/routes/threads.js";
import { registerGatewayRoutes } from "../src/gateway/server.js";
import { openDatabase, resolveDataDirectory } from "../src/db/index.js";
import { ThreadManager } from "../src/codex/manager.js";
import { WorkspaceFiles } from "../src/files/workspace-files.js";
import { ThreadEvents } from "../src/ws/events.js";
import { Notifications } from "../src/notifications/index.js";
import { SecretMasker } from "../src/security/secret-masker.js";
import { encryptSecret } from "../src/security/crypto.js";
import {completeAnswer,turnEvents} from "../src/codex/timeline.js";
import {projectTurn} from "@codexdeck/shared";

const fake = fileURLToPath(new URL("../tests/fixtures/fake-app-server.mjs",import.meta.url));
let root: string, ctx: ServerContext, app: ReturnType<typeof Fastify>, manager: ThreadManager;
let mock: ReturnType<typeof httpServer>, workspace: string, thread: string, cookie: string;
let upstream: string[], notices: string[];
beforeEach(async () => {
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
    approvalTimeoutMs:650, notifyAfterMs:30,
  });
  registerThreadRoutes(app,ctx,manager);
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
  expect(events("item/agentMessage/delta").at(-1).delta).toBe("guidance:use the existing build");
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
