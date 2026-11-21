import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { expect, test } from "vitest";
import { turnPageSchema, type ThreadEvent } from "@codexdeck/shared";
import { parseGatewayConfig } from "../src/app.js";
import { migrations, runMigrations } from "../src/db/migrations.js";
import { schema } from "../src/db/schema.js";
import { SecretMasker } from "../src/security/secret-masker.js";
import { ThreadEvents } from "../src/ws/events.js";
import { stepDetail, turnPage } from "../src/codex/turns.js";

test("upgrades v7 lazily by page, keeps an exact SSE cursor inside a compacted answer, fetches logs on demand",async()=>{
  const sql:string[]=[];
  const db=new Database(":memory:",{verbose:stmt=>sql.push(String(stmt))});
  try {
    db.pragma("foreign_keys=on");
    db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL)");
    for(const m of migrations.filter(m=>m.version<=7)){
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations VALUES(?,'old')").run(m.version);
    }
    db.exec(`INSERT INTO workspaces(id,name,path,created_at,updated_at) VALUES('w','w','w','','');
      INSERT INTO threads(id,workspace_id,title,status,created_at,updated_at) VALUES('t','w','thread','idle','','')`);
    const add=db.prepare("INSERT INTO tasks(id,thread_id,workspace_id,prompt,status,summary,created_at,updated_at) VALUES(?,'t','w',?,'completed','legacy','','')");
    for(let i=1;i<=40;i++) add.run("j"+i,"ask "+i);
    runMigrations(db); runMigrations(db);
    const masker=new SecretMasker();
    masker.register("legacy-split-secret");
    const ctx={native:db,orm:drizzle(db,{schema}),masterKey:randomBytes(32),masker,gatewayConfig:parseGatewayConfig()};
    const source=new ThreadEvents(ctx);
    const item="j40";
    const expected:ThreadEvent[]=[];
    const emit=(type:string,payload:unknown)=>expected.push(source.append("t",type,payload,item));
    const hugeLog="command-output ".repeat(8192);
    emit("item/started",{item:{id:"cmd",type:"commandExecution",command:"test",status:"running"}});
    for(let i=0;i<141;i++) {
      const secretChunk=i===1||i===2;
      emit("item/agentMessage/delta",{itemId:secretChunk?"legacy":"a",delta:i===1?"legacy-split-":i===2?"secret":"."});
    }
    emit("item/completed",{item:{id:"cmd",type:"commandExecution",command:"test",aggregatedOutput:hugeLog,status:"completed"}});
    emit("turn/diff/updated",{diff:"full patch"});
    emit("task_completed",{task_id:item,status:"completed"});
    expect(db.prepare("SELECT COUNT(*) FROM thread_events WHERE type='item/agentMessage/delta'").pluck().get()).toBe(0);
    const page=turnPageSchema.parse(turnPage(db,"t",12,Number.MAX_SAFE_INTEGER,masker));
    expect(page.has_more).toBe(true);
    expect(page.turns.map(t=>t.turn_index)).toEqual(Array.from({length:12},(_,i)=>29+i));
    expect(page.latest_seq_id).toEqual(expected.at(-1)?.seq_id);
    expect(page.turns.at(-1)?.assistant_markdown).toContain("[REDACTED]");
    expect(page.turns[0].summary_only).toBe(true);
    expect(JSON.stringify(page)).not.toContain("command-output");
    expect(stepDetail(db,item,"cmd",masker)?.detail).toContain(hugeLog);
    expect(stepDetail(db,item,"$diff",masker)?.detail).toBe("full patch");
    expect(stepDetail(db,"j1","cmd",masker)).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) FROM thread_turns WHERE timeline_summary_json IS NOT NULL").pluck().get()).toBe(12);
    sql.length=0;
    expect(turnPage(db,"t",12,Number.MAX_SAFE_INTEGER,masker)).toEqual(page);
    expect(sql.some(q=>q.includes("payload_json") || q.includes("turn_answer_replay"))).toBe(false);
    add.run("new","new");
    const prev=turnPage(db,"t",12,page.turns[0].turn_index,masker);
    expect(prev.turns.map(t=>t.turn_index)).toEqual(Array.from({length:12},(_,i)=>17+i));
    const after=expected[7].seq_id;
    const received:ThreadEvent[]=[];
    await new Promise<void>(resolve=>{
      const stop=source.follow("t",after,e=>received.push(e),item,()=>{stop();resolve();});
    });
    expect(received).toEqual(expected.filter(frame=>frame.seq_id>after));
    expect(db.pragma("foreign_key_check")).toEqual([]);
  } finally {db.close();}
});
