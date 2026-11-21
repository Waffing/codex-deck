import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { expect, test } from "vitest";
import { searchResultsSchema } from "@codexdeck/shared";
import { createServer, parseGatewayConfig } from "../src/app.js";
import { GlobalSearch } from "../src/db/global-search.js";
import { migrations, runMigrations } from "../src/db/migrations.js";
import { schema } from "../src/db/schema.js";
import { installationCode } from "../src/routes/auth.js";
import { registerSearchRoute } from "../src/routes/search.js";
import { SecretMasker } from "../src/security/secret-masker.js";

function oldDatabase(){
  const db=new Database(":memory:");
  db.pragma("foreign_keys=ON");
  db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL)");
  for(const m of migrations.filter(m=>m.version<=10)){
    db.exec(m.sql);
    db.prepare("INSERT INTO schema_migrations VALUES(?,'legacy')").run(m.version);
  }
  db.exec(`INSERT INTO workspaces(id,name,path,created_at,updated_at) VALUES('w','项目数据','workspace','','');
    INSERT INTO threads(id,workspace_id,title,status,created_at,updated_at) VALUES('t','w','conversation','idle','','')`);
  return db;
}

test("v10 backfill resumes, indexes historical events and purges newly registered literals",()=>{
  const db=oldDatabase(),masker=new SecretMasker();
  const token=randomBytes(16).toString("hex"),later=randomBytes(16).toString("hex");
  try{
    db.prepare(`INSERT INTO tasks(id,workspace_id,thread_id,prompt,summary,status,created_at,updated_at)
      VALUES('job','w','t',?,'fallback','completed','','')`).run("检查数据库 "+token);
    db.prepare(`INSERT INTO thread_events(id,thread_id,task_id,sequence,type,payload_json,created_at)
      VALUES('e','t','job',1,'item/agentMessage/delta',?,'')`).run(JSON.stringify({itemId:"a",delta:"数据备份恢复 running "+later}));
    db.exec(`INSERT INTO artifacts(id,name,path,thread_id,workspace_id,turn_id,created_at)
      VALUES('doc','数据.csv','产物/数据.csv','t','w','job','');
      INSERT INTO deployments(id,workspace_id,status,config_json,created_at,updated_at)
      VALUES('dep','w','live','{"mode":"local","start":{"public_dir":"数据","args":["hidden-value"]}}','','')`);
    runMigrations(db);runMigrations(db);
    masker.register(token);
    const initial=new GlobalSearch(db,masker);
    expect(initial.drain(1)).toBe(1);initial.close();
    const index=new GlobalSearch(db,masker);
    expect(index.drain()).toBe(2);
    const query=(q:string)=>index.search({q,scope:"all"});
    for(const word of ["数","数据"]){
      const result=searchResultsSchema.parse(query(word));
      expect(result.messages[0]).toMatchObject({entity_id:"job",thread_id:"t",turn_index:1});
      expect(result.artifacts[0].artifact?.path).toBe("产物/数据.csv");
      expect(result.deployments[0].entity_id).toBe("dep");
      expect(result.artifacts[0].snippet.some(p=>p.match&&p.text===word)).toBe(true);
    }
    expect(query("据备份").messages).toHaveLength(1);
    expect(query("RUNNING").messages).toHaveLength(1);
    expect(index.search({q:"数据",scope:"messages",workspace_id:"different"}).messages).toHaveLength(0);
    expect(index.search({q:"数据",scope:"artifacts"}).messages).toHaveLength(0);
    expect(query("hidden-value").deployments).toHaveLength(0);
    expect(query(token).messages).toHaveLength(0);
    expect(query(later).messages).toHaveLength(1);
    masker.register(later);
    expect(query(later).messages).toHaveLength(0);
    expect(JSON.stringify(db.prepare("SELECT title,content FROM global_search_fts").all())).not.toContain(later);
    expect(query('OR "quoted" *').messages).toHaveLength(0);
    db.exec("UPDATE artifacts SET name='final.csv',path='final.csv' WHERE id='doc'");
    index.drain();expect(query("数据").artifacts).toHaveLength(0);
    expect(query("final").artifacts).toHaveLength(1);
    db.exec("DELETE FROM tasks WHERE id='job'");index.drain();
    expect(query("running").messages).toHaveLength(0);
    index.close();
    const restarted=new SecretMasker();restarted.register("final.csv");
    const resumed=new GlobalSearch(db,restarted);
    expect(resumed.search({scope:"artifacts",q:"final"}).artifacts).toHaveLength(0);
    resumed.close();
  }finally{db.close();}
});

test("admin search endpoint validates its query, groups hits and forbids anonymous reads",async()=>{
  const db=oldDatabase();runMigrations(db);
  const ctx={native:db,orm:drizzle(db,{schema}),masterKey:randomBytes(32),masker:new SecretMasker(),gatewayConfig:parseGatewayConfig()};
  const app=createServer(ctx);
  registerSearchRoute(app,ctx);
  try{
    expect((await app.inject("/api/search?q=term")).statusCode).toBe(401);
    const setup=await app.inject({method:"POST",url:"/api/auth/setup",
      payload:{setup_code:installationCode(db,ctx.masterKey),password:randomBytes(24).toString("hex")}});
    const cookie=String(setup.headers["set-cookie"]).split(";")[0];
    const result=await app.inject({url:"/api/search?q=term",headers:{cookie}});
    expect(result.statusCode).toBe(200);
    expect(result.headers["cache-control"]).toContain("no-store");
    expect(searchResultsSchema.parse(result.json()).artifacts).toEqual([]);
    expect((await app.inject({url:"/api/search?q=",headers:{cookie}})).statusCode).toBe(400);
  }finally{await app.close();db.close();}
});

test("10,000 turns: hot Chinese, English and substring queries finish below 150 ms at p95",()=>{
  const db=oldDatabase();
  try{
    const insert=db.prepare(`INSERT INTO tasks(id,workspace_id,thread_id,prompt,answer_markdown,status,created_at,updated_at)
      VALUES(?,'w','t',?,?,'completed','','')`);
    db.transaction(()=>{
      for(let i=0;i<10_000;i++)insert.run("j"+i,"工程记录 "+i,"跟踪数据库迁移与部署，检查 telemetry batch-"+(i%997));
    })();
    runMigrations(db);
    const index=new GlobalSearch(db,new SecretMasker());
    while(index.drain(250)>0){ /* Complete historical queue before measuring warm reads. */ }
    const samples:number[]=[];
    const queries=["数","数据库","telemetry","batch-996","部署","missing"];
    for(let i=0;i<72;i++){
      const q=queries[i%queries.length],start=performance.now();
      const result=index.search({q,scope:"all"});
      if(i>=queries.length)samples.push(performance.now()-start);
      expect(result.messages.length>0).toBe(q!=="missing");
    }
    const p95=samples.sort((a,b)=>a-b)[Math.ceil(samples.length*.95)-1];
    console.log(`FTS5 · 10000 turns · ${samples.length} warm samples · p95=${p95.toFixed(2)}ms`);
    expect(p95).toBeLessThan(150);index.close();
  }finally{db.close();}
},60_000);
