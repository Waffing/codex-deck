import {randomBytes,randomUUID} from "node:crypto";
import {createServer as http} from "node:http";
import {once} from "node:events";
import {execFile} from "node:child_process";
import {mkdtemp,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import type {AddressInfo} from "node:net";
import {promisify} from "node:util";
import Database from "better-sqlite3";
import {expect,it} from "vitest";
import {parseDiffLines} from "@codexdeck/shared";
import {createServer,parseGatewayConfig} from "../src/app.js";
import {openDatabase} from "../src/db/index.js";
import {migrations,runMigrations} from "../src/db/migrations.js";
import {SecretMasker} from "../src/security/secret-masker.js";
import {installationCode} from "../src/routes/auth.js";

it("upgrades a populated v9 store twice and enforces workspace and retry constraints",()=>{
  const db=new Database(":memory:");
  try {
    db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL)");
    for(const m of migrations.filter(m=>m.version<=9)) {
      db.exec(m.sql);db.prepare("INSERT INTO schema_migrations VALUES(?,'old')").run(m.version);
    }
    db.exec("INSERT INTO workspaces(id,name,path,created_at,updated_at) VALUES('w','project','fixture','','')");
    db.exec("INSERT INTO threads(id,workspace_id,title,status,created_at,updated_at) VALUES('t','w','old title','idle','','')");
    runMigrations(db);runMigrations(db);
    expect(db.prepare("SELECT auto_verify_enabled,max_self_heal_retries,verify_commands_json FROM workspaces").get()).toEqual({auto_verify_enabled:0,max_self_heal_retries:2,verify_commands_json:"[]"});
    expect(db.prepare("SELECT title,execution_mode,handoff_doc,parent_thread_id FROM threads").get()).toEqual({title:"old title",execution_mode:"execute",handoff_doc:null,parent_thread_id:null});
    expect(()=>db.exec("UPDATE workspaces SET max_self_heal_retries=6")).toThrow();
    expect(db.pragma("foreign_key_check")).toEqual([]);
  }finally{db.close();}
});

it("reviews a real patch through the billed model, validates scoped annotations and hands off atomically",async()=>{
  const data=await mkdtemp(path.join(tmpdir(),"codexdeck-quality-review-"));
  const masterKey=randomBytes(32);
  const ctx={...await openDatabase(data,path.dirname(data)),gatewayConfig:parseGatewayConfig(),masterKey,masker:new SecretMasker()};
  const app=createServer(ctx,{dataDirectory:data,codexBin:fileURLToPath(new URL("../tests/fixtures/fake-app-server.mjs",import.meta.url))});
  const calls:{model:string;input:string}[]=[];
  let mode:"review"|"empty"|"error"|"invalid"|"handoff"="review";
  const finding={id:"f1",severity:"warning",category:"bug",file:"a.ts",line:1,title:"Check replacement",detail:"Confirm the changed return value",fix_hint:"Update its callers"};
  const upstream=http(async(req,res)=>{
    let raw="";for await(const part of req) raw+=part;
    const body=JSON.parse(raw);calls.push(body);
    if(mode==="error"){res.writeHead(503).end();return;}
    let answer="### Handoff\nKeep the billing test.";
    if(mode==="review"||mode==="empty") answer="Review:\n"+JSON.stringify({summary:"Reviewed two files",findings:mode==="review"?[finding]:[]})+"\nEnd of report";
    if(mode==="invalid") answer="not a report";
    res.writeHead(200,{"Content-Type":"application/json"}).end(JSON.stringify({status:"completed",output:[{type:"message",content:[{type:"output_text",text:answer}]}],usage:{input_tokens:31,output_tokens:12}}));
  });
  try {
    upstream.listen(0,"127.0.0.1");await once(upstream,"listening");
    ctx.native.prepare("INSERT INTO providers(id,name,preset,base_url,headers_json,quirks_json,enabled,created_at,updated_at) VALUES('p','p','custom',?,'{}','{}',1,'','')").run("http://127.0.0.1:"+(upstream.address() as AddressInfo).port+"/v1");
    ctx.native.exec(`INSERT INTO models(id,provider_id,alias,model_id,protocol,created_at,updated_at) VALUES
      ('m','p','writer','writer-real','responses','',''),('r','p','reviewer','review-real','responses','','');
      UPDATE models SET fallback_model_ids_json='["m"]' WHERE id='r'`);
    await app.listen({port:0,host:"127.0.0.1"});
    const login=await app.inject({method:"POST",url:"/api/auth/setup",payload:{password:randomBytes(16).toString("hex"),setup_code:installationCode(ctx.native,masterKey)}});
    const cookie=String(login.headers["set-cookie"]).split(";")[0];
    const post=(url:string,payload:Record<string,unknown>)=>app.inject({method:"POST",url,payload,headers:{cookie}});
    const get=(url:string)=>app.inject({method:"GET",url,headers:{cookie}});
    const ws=(await post("/api/workspaces",{name:"project"})).json();
    const cwd=String(ctx.native.prepare("SELECT path FROM workspaces WHERE id=?").pluck().get(ws.id));
    const git=(...args:string[])=>promisify(execFile)("git",["-c","user.name=fixture","-c","user.email=fixture@localhost","-c","core.hooksPath=/dev/null",...args],{cwd});
    await git("init","-q");
    await writeFile(path.join(cwd,"a.ts"),"old\n");await writeFile(path.join(cwd,"b.ts"),"remove\n");
    await git("add",".");await git("commit","-qm","baseline");
    const testSecret=randomBytes(18).toString("hex");ctx.masker.register(testSecret);
    await writeFile(path.join(cwd,"a.ts"),"new "+testSecret+"\n");await rm(path.join(cwd,"b.ts"));
    const thread=(await post("/api/threads",{workspace_id:ws.id,model_alias:"writer"})).json().id;
    const base="/api/threads/"+thread;
    ctx.native.prepare("UPDATE workspaces SET review_model_alias='reviewer' WHERE id=?").run(ws.id);
    const diff=(await get(base+"/review-diff")).json();
    expect(diff.patch).toContain("[REDACTED]");expect(diff.patch).not.toContain(testSecret);
    expect(parseDiffLines(diff.patch)).toContainEqual(expect.objectContaining({file:"b.ts",side:"old",line:1,text:"-remove"}));
    const turn=randomUUID();
    ctx.native.prepare(`INSERT INTO tasks(id,workspace_id,thread_id,status,prompt,summary,turn_diff_json,created_at,updated_at)
      VALUES(?,?,?,'completed','billing goal','billing implementation',?,'','')`).run(turn,ws.id,thread,JSON.stringify({files:[{path:"a.ts"}],diff:diff.patch}));
    const other=(await post("/api/threads",{workspace_id:ws.id,model_alias:"writer"})).json().id;
    expect((await get("/api/threads/"+other+"/review-diff?turn_id="+turn)).statusCode).toBe(404);
    expect((await app.inject({url:base+"/reviews"})).statusCode).toBe(401);
    expect((await post(base+"/reviews",{reviewer_model_alias:"writer"})).statusCode).toBe(409);
    const result=await post(base+"/reviews",{turn_id:turn});
    expect(result.statusCode,result.body).toBe(200);const review=result.json();
    expect(review.findings).toEqual([finding]);expect(review.reviewer_model_alias).toBe("reviewer");
    expect(calls.at(-1)?.model).toBe("review-real");expect(calls.at(-1)?.input).not.toContain(testSecret);
    expect(ctx.native.prepare("SELECT input_tokens,output_tokens,turn_id,model_id FROM usage_logs ORDER BY rowid DESC").get()).toEqual({input_tokens:31,output_tokens:12,turn_id:turn,model_id:"r"});
    mode="empty";expect((await post(base+"/reviews",{})).json().findings).toEqual([]);
    mode="error";const before=calls.length;expect((await post(base+"/reviews",{})).statusCode).toBeGreaterThanOrEqual(500);
    expect(calls.length).toBe(before+1);
    mode="invalid";expect((await post(base+"/reviews",{})).statusCode).toBeGreaterThanOrEqual(500);
    expect((await get(base+"/reviews")).json()).toHaveLength(2);
    mode="error";expect((await post(base+"/handoff",{})).statusCode).toBeGreaterThanOrEqual(500);
    expect(ctx.native.prepare("SELECT count(*) FROM threads WHERE parent_thread_id=?").pluck().get(thread)).toBe(0);
    mode="handoff";const handoff=await post(base+"/handoff",{model_alias:"reviewer",focus_note:"pricing"});
    expect(handoff.statusCode,handoff.body).toBe(201);const child=handoff.json();
    expect(calls.at(-1)?.input).toContain("pricing");expect(calls.at(-1)?.input).toContain("billing goal");
    expect(ctx.native.prepare("SELECT parent_thread_id,handoff_doc,last_context_tokens,workspace_id FROM threads WHERE id=?").get(child.thread_id)).toEqual({parent_thread_id:thread,handoff_doc:child.handoff_doc,last_context_tokens:0,workspace_id:ws.id});
    const feedback={diff_hash:diff.diff_hash,turn_id:turn,client_msg_id:randomUUID(),review_id:review.id,finding_ids:["f1"],annotations:[
      {file:"a.ts",line:1,side:"new",comment:"check this"}, {file:"b.ts",line:1,side:"old",comment:"keep the contract"}]};
    expect((await post(base+"/review-feedback",{...feedback,annotations:[{...feedback.annotations[0],line:99}]})).statusCode).toBe(422);
    expect((await post(base+"/review-feedback",{...feedback,diff_hash:"0".repeat(64)})).statusCode).toBe(409);
    const submitted=await post(base+"/review-feedback",feedback);
    expect(submitted.statusCode,submitted.body).toBe(202);
    expect((await post(base+"/review-feedback",feedback)).json().task_id).toBe(submitted.json().task_id);
    const prompt=String(ctx.native.prepare("SELECT prompt FROM tasks WHERE id=?").pluck().get(submitted.json().task_id));
    for(const part of ["-remove","+new [REDACTED]","Check replacement","keep the contract"]) expect(prompt).toContain(part);
  } finally {
    await app.close();ctx.native.close();upstream.closeAllConnections();await new Promise<void>(done=>upstream.close(()=>done()));
    await rm(data,{recursive:true,force:true,maxRetries:5,retryDelay:200});
  }
},45000);
