import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { expect, it } from "vitest";
import { createServer, parseGatewayConfig } from "../src/app.js";
import { runMigrations } from "../src/db/migrations.js";
import { schema } from "../src/db/schema.js";
import { installationCode } from "../src/routes/auth.js";
import { rotateMasterKey } from "../src/rotate-key.js";
import { decryptSecret } from "../src/security/crypto.js";
import { SecretMasker } from "../src/security/secret-masker.js";
import { registerWorkspaceSecret, workspaceSecretEnv, workspaceSecretNames } from "../src/security/workspace-secrets.js";
import { ThreadEvents } from "../src/ws/events.js";
import { OutputMasker } from "../src/codex/output-masker.js";
import { completeAnswer } from "../src/codex/timeline.js";

it("keeps repeated masking of short environment values stable",()=>{
  const masker=new SecretMasker();
  masker.register("E"); masker.register("D");
  const hidden=masker.maskString("ED");
  expect(hidden).toBe("[REDACTED][REDACTED]");
  expect(masker.maskString(hidden)).toBe(hidden);
  registerWorkspaceSecret({masker},"1");
  registerWorkspaceSecret({masker},"e");
  const meta={id:"d79eaee1-180a-4829-afad-1111f64b8391",type:"item",status:"completed",created_at:"2026-11-21T10:01:00Z"};
  expect(masker.maskObject({...meta,text:"step1!"})).toEqual({...meta,text:"st[REDACTED]p[REDACTED]!"});
  expect(masker.maskObject({data:{id:"step1!"}})).toEqual({data:{id:"st[REDACTED]p[REDACTED]!"}});
});

it("isolates encrypted workspace secrets across scopes, imports atomically, and restores masking after key rotation",async()=>{
  const native=new Database(":memory:");
  runMigrations(native);
  native.exec("INSERT INTO workspaces(id,name,path,created_at,updated_at) VALUES('alpha','Alpha','alpha','',''),('beta','Beta','beta','','')");
  const ctx={native,orm:drizzle(native,{schema}),masterKey:randomBytes(32),masker:new SecretMasker(),gatewayConfig:parseGatewayConfig()};
  const app=createServer(ctx);
  const base="/api/workspaces/alpha/secrets";
  const other="/api/workspaces/beta/secrets";
  const value=randomBytes(28).toString("base64url");
  const second=randomBytes(26).toString("hex");
  try {
    const login=await app.inject({method:"POST",url:"/api/auth/setup",
      payload:{setup_code:installationCode(native,ctx.masterKey),password:"fixture-passphrase-123"}});
    expect(login.statusCode).toBe(200);
    const headers={cookie:String(login.headers["set-cookie"]).split(";")[0]};
    expect((await app.inject(base)).statusCode).toBe(401);
    const first=await app.inject({method:"POST",url:base,headers,payload:{key_name:"DB_CREDENTIAL",value,description:"app",inject_on_deploy:true}});
    expect(first.statusCode).toBe(201);
    expect(first.body).not.toContain(value);
    expect(first.json()).toMatchObject({key_name:"DB_CREDENTIAL",masked_value:"••••"+value.slice(-4),inject_on_verify:false});
    const itemId=first.json().id;
    const envelope=()=>native.prepare("SELECT value_enc FROM workspace_secrets WHERE id=?").pluck().get(itemId) as string;
    const old=envelope();
    expect(old).not.toContain(value);
    expect(decryptSecret(old,ctx.masterKey)).toBe(value);
    expect(ctx.masker.maskObject({log:[value]})).toEqual({log:["[REDACTED]"]});
    native.exec("INSERT INTO threads(id,workspace_id,title,status,created_at,updated_at) VALUES('chat','alpha','Chat','idle','','')");
    native.exec("INSERT INTO tasks(id,workspace_id,thread_id,prompt,status,created_at,updated_at) VALUES('turn','alpha','chat','check','running','','')");
    const events=new ThreadEvents(ctx);
    const live:string[]=[];
    const off=events.subscribe(event=>live.push(JSON.stringify(event.payload)));
    const stream=new OutputMasker(ctx.masker,(type,payload)=>{events.append("chat",type,payload,"turn");});
    stream.push("item/agentMessage/delta",{itemId:"reply",delta:"API returned "+value.slice(0,10)});
    stream.push("item/agentMessage/delta",{itemId:"reply",delta:value.slice(10)+"."});
    stream.flush();off();
    expect(completeAnswer(native,"chat","turn",ctx.masker)).toBe("API returned [REDACTED].");
    const recorded=native.prepare("SELECT payload_json FROM thread_events ORDER BY sequence").pluck().all();
    expect(live).toEqual(recorded);
    expect(live.join("")).not.toContain(value.slice(0,10));
    expect((await app.inject({method:"PATCH",url:other+"/"+itemId,headers,payload:{description:"wrong"}})).statusCode).toBe(404);
    expect((await app.inject({method:"DELETE",url:other+"/"+itemId,headers})).statusCode).toBe(404);
    expect((await app.inject({method:"PATCH",url:base+"/"+itemId,headers,payload:{description:"edited "+second}})).statusCode).toBe(200);
    const storedDescription=()=>native.prepare("SELECT description FROM workspace_secrets WHERE id=?").pluck().get(itemId) as string;
    expect(storedDescription()).not.toContain(second);
    expect(envelope()).toBe(old);
    expect((await app.inject({method:"POST",url:base+"/import",headers,payload:{text:"WORKS=abc\nNODE_OPTIONS=forbidden"}})).statusCode).toBe(400);
    expect(workspaceSecretNames(ctx,"alpha")).toEqual(["DB_CREDENTIAL"]);
    const imported=await app.inject({method:"POST",url:base+"/import",headers,payload:{
      text:`# Comment\nexport VERIFY_CREDENTIAL="${second}\n#literal$TEXT"\nSHORT=xyz\nEMPTY= # no value`,inject_on_verify:true,
    }});
    expect(imported.json()).toEqual({imported:3});
    expect(decryptSecret(storedDescription(),ctx.masterKey)).toBe("edited [REDACTED]");
    expect(workspaceSecretEnv(ctx,"alpha","deploy")).toEqual({DB_CREDENTIAL:value});
    expect(workspaceSecretEnv(ctx,"alpha","verify")).toEqual({VERIFY_CREDENTIAL:second+"\n#literal$TEXT",SHORT:"xyz",EMPTY:""});
    expect(workspaceSecretEnv(ctx,"beta","verify")).toEqual({});
    const list=await app.inject({url:base,headers});
    expect(list.body).not.toContain(value);
    expect(list.body).not.toContain(second);
    expect(list.json().find((s:{key_name:string})=>s.key_name==="SHORT").masked_value).toBe("••••");
    expect(ctx.masker.maskString(second)).toBe("[REDACTED]");
    expect((await app.inject({method:"POST",url:base+"/import",headers,payload:{text:"DB_CREDENTIAL="+second}})).json()).toEqual({imported:1});
    expect(workspaceSecretEnv(ctx,"alpha","deploy")).toEqual({DB_CREDENTIAL:second});
    expect(ctx.masker.maskString(value)).toBe("[REDACTED]");
    const short=list.json().find((s:{key_name:string})=>s.key_name==="SHORT");
    expect((await app.inject({method:"DELETE",url:base+"/"+short.id,headers})).statusCode).toBe(204);
    const rotated={...ctx,masterKey:randomBytes(32),masker:new SecretMasker()};
    rotateMasterKey(native,ctx.masterKey,rotated.masterKey);
    expect(()=>decryptSecret(envelope(),ctx.masterKey)).toThrow();
    expect(decryptSecret(storedDescription(),rotated.masterKey)).toBe("edited [REDACTED]");
    const restarted=createServer(rotated);
    try {
      expect(workspaceSecretEnv(rotated,"alpha","deploy")).toEqual({DB_CREDENTIAL:second});
      expect(rotated.masker.maskString(second)).toBe("[REDACTED]");
    } finally {await restarted.close();}
  } finally {await app.close();native.close();}
});
