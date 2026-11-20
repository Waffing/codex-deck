import { installationCode } from "../src/routes/auth.js";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createServer, parseGatewayConfig } from "../src/app.js";
import { openDatabase } from "../src/db/index.js";
import { SecretMasker } from "../src/security/secret-masker.js";
import { threadHistorySchema } from "@codexdeck/shared";

let root:string, data:string, web:string, cookie:string;
let db:Awaited<ReturnType<typeof openDatabase>>, app:ReturnType<typeof createServer>;
const get=(url:string)=>app.inject({url,headers:{cookie}});
const post=(url:string,payload:object={})=>app.inject({method:"POST",url,headers:{cookie},payload});

beforeAll(async()=>{
  root=await mkdtemp(path.join(tmpdir(),"deck-console-"));
  data=path.join(root,"data"); web=path.join(root,"web");
  await mkdir(data);
  await mkdir(path.join(web,"assets"),{recursive:true});
  await writeFile(path.join(web,"index.html"),"<!doctype html><title>CodexDeck</title>");
  await writeFile(path.join(web,"assets","app.js"),"export const ready=true");
  db=await openDatabase(data,root);
  const ctx={...db,masterKey:randomBytes(32),masker:new SecretMasker(),gatewayConfig:parseGatewayConfig()};
  app=createServer(ctx,{workspaceRoot:root,dataDirectory:data,webRoot:web});
  await app.ready();
  expect((await app.inject("/api/onboarding/status")).json()).toMatchObject({setup_required:true,authenticated:false});
  const setup=await app.inject({method:"POST",url:"/api/auth/setup",payload:{ setup_code: installationCode(ctx.native,ctx.masterKey),password:"FixtureConsolePassword"}});
  cookie=String(setup.headers["set-cookie"]).split(";")[0];
});
afterAll(async()=>{await app?.close(); db?.native.close(); if(root) await rm(root,{recursive:true,force:true});});

test("serves real assets and SPA navigation while preserving control-plane routes and filesystem boundaries",async()=>{
  for(const url of ["/","/workspaces/example/threads"]) {
    const res=await get(url);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("<title>CodexDeck</title>");
  }
  expect((await get("/assets/app.js")).body).toBe("export const ready=true");
  const head=await app.inject({method:"HEAD",url:"/assets/app.js"});
  expect(head.body).toBe(""); expect(head.headers["content-type"]).toMatch(/javascript/);
  expect(Number(head.headers["content-length"])).toBe(Buffer.byteLength("export const ready=true"));
  for(const url of ["/api/unknown","/ws/unknown","/preview/unknown","/internal/unknown","/assets/missing.js","/.env"]) {
    const res=await get(url);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.body).not.toContain("<title>");
  }
  const privateDir=path.join(data,"private");
  await mkdir(privateDir);
  await writeFile(path.join(privateDir,"secret.txt"),"hidden content");
  await symlink(privateDir,path.join(web,"link"),process.platform==="win32"?"junction":"dir");
  await link(path.join(privateDir,"secret.txt"),path.join(web,"hardlink.txt"));
  for(const url of ["/link/secret.txt","/hardlink.txt"]) {
    const res=await get(url);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.body).not.toContain("hidden content");
  }
});

test("requires an enabled model and ready workspace, imports registered local directories once, and aggregates both currencies",async()=>{
  expect((await app.inject("/api/usage")).statusCode).toBe(401);
  expect((await post("/api/onboarding/complete")).statusCode).toBe(409);
  const provider=(await post("/api/providers",{preset:"custom",name:"Vendor",base_url:"http://127.0.0.1:15321/v1"})).json();
  const model=(await post("/api/models",{alias:"local-model",provider_id:provider.id,model_id:"mock",pricing_currency:"CNY",cost_input_cny_per_million:8,cost_output_cny_per_million:24})).json();
  expect(model).toMatchObject({pricing_currency:"CNY",cost_input_cny_per_million:8,cost_output_cny_per_million:24});
  expect((await get("/api/onboarding/status")).json()).toMatchObject({has_provider:true,has_model:true,has_workspace:false});
  await mkdir(path.join(data,"workspaces","existing-project"),{recursive:true});
  expect((await get("/api/workspaces/local-directories")).json().directories).toContain("existing-project");
  expect((await post("/api/workspaces/import",{directory:"../outside"})).statusCode).toBe(400);
  expect((await post("/api/workspaces/import",{directory:"absent"})).statusCode).toBe(404);
  const imported=await post("/api/workspaces/import",{directory:"existing-project"});
  expect(imported.statusCode).toBe(201);
  const workspace=imported.json().id;
  expect((await post("/api/workspaces/import",{directory:"existing-project"})).statusCode).toBe(409);
  expect((await get("/api/workspaces/local-directories")).json().directories).toEqual([]);
  expect((await post("/api/onboarding/complete")).json()).toEqual({completed:true});
  expect((await get("/api/onboarding/status")).json()).toMatchObject({setup_required:false,authenticated:true,completed:true});
  expect((await app.inject("/api/onboarding/status")).json()).toMatchObject({authenticated:false,has_workspace:false,has_model:false});

  const insert=db.native.prepare("INSERT INTO usage_logs(id,provider_id,model_id,requested_alias,input_tokens,output_tokens,cost_usd,cost_cny,created_at) VALUES(?,?,?,'local-model',10,5,?,?,?)");
  insert.run("usd",provider.id,model.id,0.75,0,"2026-01-02T00:00:00Z");
  insert.run("cny",provider.id,model.id,0,1.5,"2026-01-01T23:00:00Z");
  const totals={requests:2,unknown_usage:2,input_tokens:20,output_tokens:10,cost_usd:.75,cost_cny:1.5};
  for(const [group,label] of [["provider","Vendor"],["model","local-model"]])
    expect((await get("/api/usage?group_by="+group)).json()).toEqual({rows:[{label,...totals}],totals});
  expect((await get("/api/usage?group_by=day")).json().rows.map((row:{label:string})=>row.label)).toEqual(["2026-01-02","2026-01-01"]);
  expect((await get("/api/usage?group_by=unknown")).statusCode).toBe(400);

  const thread=(await post("/api/threads",{workspace_id:workspace,model_alias:"local-model"})).json().id;
  db.native.prepare("INSERT INTO tasks(id,workspace_id,thread_id,prompt,status,summary,created_at,updated_at) VALUES('turn',?,?,'Hello','completed','Done','','')").run(workspace,thread);
  db.native.prepare("INSERT INTO checkpoints VALUES('turn',?,?,'checkpoint1','')").run(workspace,thread);
  db.native.prepare("INSERT INTO artifacts(id,thread_id,workspace_id,turn_id,name,path,created_at) VALUES('item',?,?,'turn','output','output.txt','')").run(thread,workspace);
  const history=threadHistorySchema.parse((await get("/api/threads/"+thread+"/history")).json());
  expect(history.tasks[0]).toMatchObject({id:"turn",checkpoint_ref:"checkpoint1",summary:"Done"});
  expect(history.artifacts[0]).toMatchObject({id:"item",turn_id:"turn"});
  for(const status of ["queued","running","failed"]) {
    db.native.prepare("UPDATE tasks SET status=? WHERE id='turn'").run(status);
    expect((await get("/api/threads?workspace_id="+workspace)).json()[0].status).toBe(status);
  }
});

test("sends a test notification to the selected channel and reports an unsuccessful delivery",async()=>{
  const paths:string[]=[];
  const http=createHttpServer((req,res)=>{paths.push(req.url!);res.writeHead(req.url==="/ok"?204:400).end();});
  try {
    http.listen(0,"127.0.0.1"); await once(http,"listening");
    const origin="http://127.0.0.1:"+(http.address() as AddressInfo).port;
    for(const name of ["ok","fail"]) {
      const created=await post("/api/notification-channels",{name,type:"webhook",config:{url:origin+"/"+name}});
      expect(created.statusCode).toBe(201);
      const result=await post("/api/notification-channels/"+created.json().id+"/test");
      expect(result.statusCode).toBe(name==="ok"?200:502);
    }
    expect(paths).toEqual(["/ok","/fail"]);
  } finally {
    http.closeAllConnections();
    if(http.listening) await new Promise<void>(resolve=>http.close(()=>resolve()));
  }
});

test("aggregates UTC periods, excludes unknown cache denominators, exports safe CSV and alerts once per budget",async()=>{
  expect((await app.inject("/api/usage/export.csv")).statusCode).toBe(401);
  const now=new Date().toISOString();
  const insert=db.native.prepare(`INSERT INTO usage_logs(id,requested_alias,input_tokens,output_tokens,
    cost_usd,cost_cny,cached_input_tokens,tokens_per_sec,ttft_ms,usage_known,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
  insert.run("analytics1","=formula",120,8,1.25,0,60,20,125,1,now);
  insert.run("analytics2","=formula",500,12,0,2,null,null,null,1,now);
  const data=(await get("/api/usage/analytics?period=week&group_by=model")).json();
  const row=data.rows.find((r:{label:string})=>r.label==="=formula");
  expect(row).toMatchObject({input_tokens:620,output_tokens:20,cached_input_tokens:60,cache_hit_rate:.5,
    ttft_ms:125,tokens_per_sec:20,cost_usd:1.25,cost_cny:2});
  expect(data.trend.every((v:{label:string})=>new Date(v.label+"T00:00:00Z").getUTCDay()===1)).toBe(true);
  const csv=await get("/api/usage/export.csv?group_by=model");
  expect(csv.headers["content-type"]).toContain("text/csv");
  expect(csv.body).toContain(`"'=formula"`);expect(csv.body).toContain("cached_input_tokens");
  const budget={daily_usd:1,monthly_usd:null,daily_cny:null,monthly_cny:1.5};
  const save=()=>app.inject({method:"PUT",url:"/api/usage/budget",headers:{cookie},payload:budget});
  expect((await save()).json()).toEqual(budget);
  const first=(await get("/api/usage/budget")).json().alerts;
  expect(first.map((alert:{kind:string})=>alert.kind).sort()).toEqual(["daily_usd","monthly_cny"]);
  await save();
  expect((await get("/api/usage/budget")).json().alerts).toEqual(first);
  expect((await get("/api/usage/analytics?period=fortnight")).statusCode).toBe(400);
});
