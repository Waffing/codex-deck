import {afterAll,beforeAll,expect,test} from "vitest";
import {mkdir,mkdtemp,rm,writeFile,readFile} from "node:fs/promises";
import path from "node:path";
import {tmpdir} from "node:os";
import {fileURLToPath} from "node:url";
import {randomBytes,createHash} from "node:crypto";
import {createServer as mockServer} from "node:http";
import {once} from "node:events";
import type {AddressInfo} from "node:net";
import WebSocket from "ws";
import {openDatabase} from "../src/db/index.js";
import {createServer,parseGatewayConfig,type ServerContext} from "../src/app.js";
import {installationCode} from "../src/routes/auth.js";
import {SecretMasker} from "../src/security/secret-masker.js";
import {getLink} from "../src/temp-access/service.js";
import {runMigrations} from "../src/db/migrations.js";
import {models,providers} from "../src/db/schema.js";

let root:string,base:string,admin:string,a:string,b:string,ta:string,tb:string;
let app:ReturnType<typeof createServer>,ctx:ServerContext;
let mock:ReturnType<typeof mockServer>;
let output:(body:Record<string,any>)=>Record<string,unknown>;
const cookieOf=(r:{headers:Record<string,unknown>})=>String(r.headers["set-cookie"]).split(";")[0];
const req=(method:"GET"|"POST"|"PATCH",url:string,cookie=admin,payload?:Record<string,unknown>)=>app.inject({method,url,headers:{cookie},payload});
const sockets=new Set<WebSocket>();
beforeAll(async()=>{
  root=await mkdtemp(path.join(tmpdir(),"cdx-guest-"));
  const data=path.join(root,"data");await mkdir(data);const db=await openDatabase(data,root);
  runMigrations(db.native);
  ctx={...db,masterKey:randomBytes(32),masker:new SecretMasker(),gatewayConfig:parseGatewayConfig()};
  mock=mockServer(async(r,s)=>{let raw="";for await(const chunk of r)raw+=chunk;s.setHeader("content-type","application/json");s.end(JSON.stringify(output(JSON.parse(raw))));});
  mock.listen(0,"127.0.0.1");await once(mock,"listening");
  const now=new Date().toISOString();
  ctx.orm.insert(providers).values({id:"p",name:"p",preset:"custom",enabled:true,headersJson:"{}",quirksJson:"{}",baseUrl:"http://127.0.0.1:"+(mock.address() as AddressInfo).port+"/v1",createdAt:now,updatedAt:now}).run();
  ctx.orm.insert(models).values({id:"m",providerId:"p",alias:"m",modelId:"m",enabled:true,fallbackModelIdsJson:"[]",protocol:"responses",costInputUsdPerMillion:10,costOutputUsdPerMillion:20,createdAt:now,updatedAt:now}).run();
  app=createServer(ctx,{workspaceRoot:root,dataDirectory:data,codexBin:fileURLToPath(new URL("../tests/fixtures/fake-app-server.mjs",import.meta.url))});
  base=await app.listen({host:"127.0.0.1",port:0});
  const setup=await req("POST","/api/auth/setup","",{password:"FixtureGuestApprovalPassword",setup_code:installationCode(db.native,ctx.masterKey)});
  expect(setup.statusCode).toBe(200);admin=cookieOf(setup);
  a=(await req("POST","/api/workspaces",admin,{name:"visible"})).json().id;
  // Guest access to an existing unrestricted workspace must still use guest permissions.
  ctx.native.prepare("UPDATE workspaces SET automation_level='unrestricted' WHERE id=?").run(a);
  b=(await req("POST","/api/workspaces",admin,{name:"other"})).json().id;
  ta=(await req("POST","/api/threads",admin,{workspace_id:a})).json().id;
  tb=(await req("POST","/api/threads",admin,{workspace_id:b})).json().id;
  expect([a,b,ta,tb].every(id=>typeof id==="string")).toBe(true);
});
afterAll(async()=>{
  for(const s of sockets)s.terminate();
  await app?.close();mock?.closeAllConnections();mock?.close();ctx?.native.close();
  if(root)await rm(root,{recursive:true,force:true});
});
async function create(options:Record<string,unknown>={}) {
  const res=await req("POST","/api/temp-access",admin,{name:"临时协作",workspace_ids:[a],permission:"readonly",expires_at:new Date(Date.now()+3600000).toISOString(),...options});
  expect(res.statusCode,res.body).toBe(201);const result=res.json();
  return {...result,route:new URL(result.url).pathname};
}
async function enter(route:string,code?:string) {
  const r=await req(code?"POST":"GET",route,"",code?{code}:undefined);
  expect(r.statusCode,r.body).toBe(303);expect(r.headers.location).toBe("/guest");
  return cookieOf(r);
}
test("scopes guest REST, preview, signed artifacts and live subscriptions; revokes every open socket",async()=>{
  const link=await create({require_code:true,bind_first_ip:true});
  expect((await req("GET",link.route,"")).body).toContain("提取码");
  expect((await req("POST",link.route,"",{code:"00"})).statusCode).toBe(403);
  const visitor=await enter(link.route,link.code);
  const exported=JSON.stringify(ctx.native.prepare("SELECT * FROM temp_access_links WHERE id=?").get(link.link.id));
  expect(exported).not.toContain(link.route.slice(7));expect(exported).not.toContain('"code":"'+link.code+'"');
  expect((await req("GET","/api/workspaces",visitor)).json().map((w:{id:string})=>w.id)).toEqual([a]);
  expect((await req("GET","/api/threads",visitor)).json().map((w:{id:string})=>w.id)).toEqual([ta]);
  for(const url of ["/api/threads/"+tb+"/history","/api/threads/"+tb+"/turns","/api/workspaces/"+b+"/files/tree","/api/threads/"+ta+"/history?debug=true",
      "/api/providers","/api/admin/runtime/tasks","/api/workspaces/local-directories","/preview/3000/","/live/"+b+"/"]){
    expect((await req("GET",url,visitor)).statusCode,url).toBe(403);
  }
  expect((await req("GET","/api/threads/"+ta+"/history",visitor)).statusCode).toBe(200);
  expect((await req("GET","/api/threads/"+ta+"/turns",visitor)).statusCode).toBe(200);
  expect((await req("POST","/api/threads/"+ta+"/warmup",visitor,{})).statusCode).toBe(403);
  ctx.native.prepare("INSERT INTO tasks(id,thread_id,workspace_id,prompt,created_at,updated_at,status) VALUES('private-turn',?,?,'','','','completed')").run(tb,b);
  expect((await req("GET","/api/turns/private-turn/steps/%24diff",visitor)).statusCode).toBe(403);
  expect((await req("POST","/api/threads/"+ta+"/messages",visitor,{prompt:"x"})).statusCode).toBe(403);
  const workspace=ctx.native.prepare("SELECT path FROM workspaces WHERE id=?").pluck().get(a) as string;
  await writeFile(path.join(workspace,"result.txt"),"allowed");
  const blob=path.join(root,"data","artifact-blobs"),digest=createHash("sha256").update("allowed").digest("hex");
  await mkdir(blob,{recursive:true});await writeFile(path.join(blob,digest),"allowed");
  for(const [id,ws] of [["art-a",a],["art-b",b]])ctx.native.prepare("INSERT INTO artifacts(id,workspace_id,name,path,change_type,created_at,content_sha256) VALUES(?,?,?,?,'added','',?)").run(id,ws,"result.txt","result.txt",digest);
  expect((await req("POST","/api/artifacts/sign",visitor,{artifact_id:"art-b"})).statusCode).toBe(403);
  const signed=(await req("POST","/api/artifacts/sign",visitor,{artifact_id:"art-a"})).json().download_url;
  expect((await req("GET",signed,visitor)).body).toBe("allowed");expect((await req("GET",signed,"")).statusCode).toBe(403);
  const remote=await app.inject({url:"/api/guest/session",headers:{cookie:visitor},remoteAddress:"127.0.0.2"});expect(remote.statusCode).toBe(403);
  const opened=async()=>{
    const s=new WebSocket(base.replace("http:","ws:")+"/ws/events?thread_id="+ta,{headers:{cookie:visitor}});
    sockets.add(s);await once(s,"open");return s;
  };
  const old=await opened();const closed=once(old,"close");
  old.send(JSON.stringify({type:"subscribe",thread_id:tb,last_seq_id:0}));expect((await closed)[0]).toBe(1008);
  const first=await opened(),second=await opened();const closedBoth=[once(first,"close"),once(second,"close")];
  expect((await req("GET","/api/temp-access/live")).json().some((s:{workspace_id:string})=>s.workspace_id===a)).toBe(true);
  await req("POST","/api/temp-access/"+link.link.id+"/revoke");expect((await Promise.all(closedBoth)).map(x=>x[0])).toEqual([1008,1008]);
  expect((await req("GET",signed,visitor)).statusCode).toBe(403);
  expect((await req("PATCH","/api/temp-access/"+link.link.id+"/extend",admin,{hours:1})).statusCode).toBe(409);
});
test("a guest turn uses the local gateway, bills actual usage, denies another turn and reopens on extension",async()=>{
  const invite=await create({permission:"collab_restricted",max_turns:1,max_tokens:2500,max_cost:.02000});
  const visitor=await enter(invite.route),seen:string[][]=[];
  output=p=>{expect(p.max_output_tokens).toBeGreaterThan(0);expect(p.max_output_tokens).toBeLessThan(1000);seen.push(p.tools.map((t:{name:string})=>t.name));return {status:"completed",usage:{input_tokens:7,output_tokens:3},
    output:[{type:"message",content:[{type:"output_text",text:"Workspace answer"}]}]};};
  const submit=()=>req("POST","/api/threads/"+ta+"/messages",visitor,{prompt:"Describe the workspace"});
  const res=await submit();expect(res.statusCode,res.body).toBe(202);
  await expect.poll(()=>getLink(ctx,invite.link.id).used_turns,{timeout:8000}).toBe(1);
  const link=getLink(ctx,invite.link.id);expect(link).toMatchObject({status:"exhausted",used_tokens:10});expect(link.used_cost).toBeCloseTo(.00013,9);
  expect(seen).toEqual([["read_file"]]);expect((await submit()).statusCode).toBe(403);
  expect(ctx.native.prepare("SELECT answer_markdown FROM tasks WHERE id=?").pluck().get(res.json().task_id)).toBe("Workspace answer");
  const extended=await req("PATCH","/api/temp-access/"+link.id+"/extend",admin,{turns:2,tokens:20,cost:0.001,hours:1});
  expect(extended.json()).toMatchObject({status:"active",max_turns:3,max_tokens:2520});expect((await req("GET","/api/guest/session",visitor)).statusCode).toBe(200);
});
test("an unrestricted project still requires administrator approval for a full visitor's exact workspace write",async()=>{
  const inv=await create({permission:"full_with_approval"}),v=await enter(inv.route);
  output=p=>p.input.some((x:{type:string})=>x.type==="function_call_output")?{output:[{type:"message",content:[{type:"output_text",text:"done"}]}],usage:{input_tokens:2,output_tokens:1}}:
    {output:[{type:"function_call",name:"write_file",call_id:"write",arguments:JSON.stringify({path:"reviewed.txt",revision:"missing",content:"reviewed"})}],usage:{input_tokens:1,output_tokens:1}};
  const answer=await req("POST","/api/threads/"+ta+"/messages",v,{prompt:"write file"});expect(answer.statusCode).toBe(202);
  const pending=()=>ctx.native.prepare("SELECT id FROM approvals WHERE status='pending' AND thread_id=?").pluck().get(ta);
  await expect.poll(pending,{timeout:6000}).toBeTypeOf("string");
  const decision="/api/approvals/"+pending()+"/decision";
  expect((await req("POST",decision,v,{decision:"approve"})).statusCode).toBe(403);
  expect((await req("POST",decision,admin,{decision:"approve"})).statusCode).toBe(204);
  await expect.poll(()=>getLink(ctx,inv.link.id).used_turns).toBe(1);
  const workspace=ctx.native.prepare("SELECT path FROM workspaces WHERE id=?").pluck().get(a) as string;
  expect(await readFile(path.join(workspace,"reviewed.txt"),"utf8")).toBe("reviewed");
});

test("workspace-scoped Open API tasks on an unrestricted project use the standard executor and require approval",async()=>{
  const key=await req("POST","/api/api-keys",admin,{name:"review fixture",workspace_ids:[a],scopes:["tasks:write"]});
  expect(key.statusCode).toBe(201);
  const {id,api_key}=key.json();
  const headers={authorization:"Bearer "+api_key};
  const submission=await app.inject({method:"POST",url:"/api/v1/tasks",headers,
    payload:{workspace_id:a,thread_id:ta,prompt:"approve:printf reviewed"}});
  expect(submission.statusCode).toBe(202);
  const taskId=submission.json().task_id;
  expect(ctx.native.prepare("SELECT api_key_id FROM tasks WHERE id=?").pluck().get(taskId)).toBe(id);
  const pending=()=>ctx.native.prepare(`SELECT a.id FROM approvals a JOIN thread_events e ON a.id=json_extract(e.payload_json,'$.id')
    WHERE e.task_id=? AND e.type='approval_req' AND a.action='item/commandExecution/requestApproval' AND a.status='pending'`).pluck().get(taskId);
  await expect.poll(pending,{timeout:6000}).toBeTypeOf("string");
  expect(ctx.native.prepare("SELECT executor_mode FROM threads WHERE id=?").pluck().get(ta)).toBe("standard");
  const url="/api/approvals/"+pending()+"/decision";
  expect((await app.inject({method:"POST",url,headers,payload:{decision:"approve"}})).statusCode).toBe(401);
  expect((await req("POST",url,admin,{decision:"deny_guide"})).statusCode).toBe(204);
  await expect.poll(()=>ctx.native.prepare("SELECT json_extract(payload_json,'$.decision') FROM thread_events WHERE task_id=? AND type='fixture/approval'").pluck().get(taskId)).toBe("decline");
  await expect.poll(()=>ctx.native.prepare("SELECT status FROM tasks WHERE id=?").pluck().get(taskId)).toBe("completed");
});

test("expiry, admission reserves and missing upstream usage can be repaired on the same invitation",async()=>{
  const grant=await create({permission:"collab_restricted",max_tokens:1}),id=grant.link.id;
  const v=await enter(grant.route);let requests=0;
  output=()=>{requests++;return {status:"completed",output:[{type:"message",content:[{type:"output_text",text:"ok"}]}]};};
  const submit=()=>req("POST","/api/threads/"+ta+"/messages",v,{prompt:"test"});
  expect((await submit()).statusCode).toBe(202);
  await expect.poll(()=>getLink(ctx,id).used_turns).toBe(1);expect(requests).toBe(0);
  expect((await req("PATCH","/api/temp-access/"+id+"/extend",admin,{tokens:12000})).statusCode).toBe(200);
  expect((await submit()).statusCode).toBe(202);await expect.poll(()=>getLink(ctx,id).used_turns).toBe(2);
  expect(requests).toBe(1);expect(getLink(ctx,id)).toMatchObject({status:"exhausted",usage_unconfirmed:true});
  expect((await req("PATCH","/api/temp-access/"+id+"/extend",admin,{tokens:1})).json()).toMatchObject({status:"active",usage_unconfirmed:false});
  ctx.native.prepare("UPDATE temp_access_links SET expires_at=? WHERE id=?").run(new Date(Date.now()-1000).toISOString(),id);
  expect((await req("GET","/api/guest/session",v)).statusCode).toBe(403);
  expect((await req("PATCH","/api/temp-access/"+id+"/extend",admin,{hours:1})).json()).toMatchObject({status:"active"});
  expect((await req("GET","/api/guest/session",v)).statusCode).toBe(200);
});
