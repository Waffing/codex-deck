import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createServer as tlsServer, request as tlsRequest } from "node:https";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach,beforeEach,expect,it,vi } from "vitest";
import { createServer,parseGatewayConfig,type ServerContext } from "../src/app.js";
import { migrations,runMigrations } from "../src/db/migrations.js";
import { schema } from "../src/db/schema.js";
import { installationCode } from "../src/routes/auth.js";
import { SecretMasker } from "../src/security/secret-masker.js";
import { readSecurityConfig,getSetting } from "../src/security/config.js";
import { createInternalToken,decryptSecret } from "../src/security/crypto.js";
import { totp } from "../src/security/totp.js";
import { rotateMasterKey } from "../src/rotate-key.js";

let ctx:ServerContext,app:ReturnType<typeof createServer>;
const password="security-test-password";
const cookie=(value:unknown)=>String(value).split(";")[0];
const forwarded={host:"panel.example","x-forwarded-proto":"https","x-forwarded-for":"203.0.113.5"};
function post(url:string,payload:object,headers:Record<string,string>={}) {return app.inject({url,method:"POST",payload,headers});}
async function setup() {
  const response=await post("/api/auth/setup",{password,setup_code:installationCode(ctx.native,ctx.masterKey)});
  expect(response.statusCode).toBe(200);
  return {cookie:cookie(response.headers["set-cookie"])};
}
async function update(headers:Record<string,string>,payload:object) {
  return app.inject({url:"/api/security/config",method:"PATCH",headers,payload});
}
beforeEach(()=>{
  const native=new Database(":memory:");
  runMigrations(native);
  ctx={native,orm:drizzle(native,{schema}),masterKey:randomBytes(32),masker:new SecretMasker(),gatewayConfig:parseGatewayConfig()};
  app=createServer(ctx);
});
afterEach(async()=>{await app.close();ctx.native.close();vi.unstubAllEnvs();});

it("keeps V1.1 hashed sessions usable across idempotent upgrades",async()=>{
  const db=new Database(":memory:"),token=randomBytes(32).toString("base64url"),hash=createHash("sha256").update(token).digest("hex");
  try {
    db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL)");
    for(const m of migrations.filter(m=>m.version<6)){db.exec(m.sql);db.prepare("INSERT INTO schema_migrations VALUES(?,'old')").run(m.version);}
    db.prepare("INSERT INTO settings VALUES(?,?,?)").run("session:"+hash,new Date(Date.now()+60_000).toISOString(),new Date().toISOString());
    runMigrations(db);runMigrations(db);
    expect(db.prepare("SELECT count(*) FROM user_sessions WHERE token_hash=? AND revoked=0").pluck().get(hash)).toBe(1);
    expect(db.prepare("SELECT count(*) FROM settings WHERE key LIKE 'session:%'").pluck().get()).toBe(0);
  }finally{db.close();}
});
it("conceals pages, grants expiring IP-bound entrance cookies and closes setup and internal ingress",async()=>{
  const admin=await setup();
  vi.stubEnv("CODEXDECK_TRUSTED_PROXIES","127.0.0.1/32,192.0.2.10/32");
  expect((await app.inject({url:"/api/auth/status",headers:forwarded})).statusCode).toBe(404);
  const configured=await update(admin,{public_enabled:true,entry_path:"/abcdefgh"});
  expect(configured.json()).toMatchObject({public_enabled:true,entry_enabled:true});
  for (const [disguise,status] of [["nginx_404",404],["blank_200",200],["forbidden_403",403]] as const) {
    await update(admin,{disguise});
    const unknown=await app.inject({url:"/console/system",headers:forwarded});
    expect(unknown.statusCode).toBe(status);
    expect(JSON.stringify(unknown.headers)+unknown.body).not.toMatch(/codexdeck/i);
    if(disguise==="blank_200")expect(unknown.body).toBe("");
  }
  await update(admin,{disguise:"nginx_404"});
  const grant=await app.inject({url:"/abcdefgh",headers:forwarded});
  expect(grant.statusCode).toBe(302);expect(grant.headers["set-cookie"]).toMatch(/HttpOnly; SameSite=Strict;.*Secure/);
  const admitted={...forwarded,cookie:cookie(grant.headers["set-cookie"])};
  expect((await app.inject({url:"/api/auth/status",headers:admitted})).statusCode).toBe(200);
  expect((await app.inject({url:"/api/auth/status",headers:{...admitted,"x-forwarded-for":"203.0.113.9"}})).statusCode).toBe(404);
  expect((await post("/api/auth/setup",{password},admitted)).statusCode).toBe(404);
  const internal={authorization:"Bearer "+createInternalToken(ctx.masterKey),host:"localhost"};
  expect((await post("/internal/v1/responses",{}, {...admitted,...internal})).statusCode).toBe(404);
  vi.stubEnv("CODEXDECK_LOCAL_PEER","172.18.0.1");
  expect((await app.inject({method:"POST",url:"/internal/v1/responses",headers:internal,remoteAddress:"172.18.0.1",payload:{}})).statusCode).toBe(404);
  expect((await app.inject({url:"/api/security/my-ip",headers:{...admin,...forwarded,"x-forwarded-for":"198.51.100.123, 203.0.113.5, 192.0.2.10"}})).json()).toEqual({ip:"203.0.113.5"});
  expect((await update({...admin,...forwarded},{ip_mode:"allow",ip_ranges:["192.0.2.0/24"]})).statusCode).toBe(400);
  expect((await update({...admin,...forwarded},{ip_mode:"allow",ip_ranges:["203.0.113.0/24"]})).statusCode).toBe(200);
  expect((await app.inject({url:"/api/auth/status",headers:{...admitted,"x-forwarded-for":"198.51.100.1"}})).statusCode).toBe(404);
});

it("trusts only the authenticated private managed proxy and its single overwritten client address",async()=>{
  const admin=await setup(),token=randomBytes(32).toString("hex");
  vi.stubEnv("CODEXDECK_MANAGED_PROXY_TOKEN",token);
  await update(admin,{public_enabled:true});
  const probe=(address:string,source:string,proof:string)=>app.inject({url:"/api/security/my-ip",remoteAddress:address,
    headers:{...admin,host:"panel.example","x-codexdeck-proxy":proof,"x-forwarded-proto":"https","x-forwarded-for":source}});
  expect((await probe("172.18.0.10","203.0.113.4",token)).json()).toEqual({ip:"203.0.113.4"});
  expect((await probe("172.18.0.10","198.51.100.4,203.0.113.4",token)).statusCode).toBe(404);
  expect((await probe("198.51.100.8","203.0.113.4",token)).statusCode).toBe(404);
  expect((await probe("172.18.0.10","203.0.113.4",randomBytes(32).toString("hex"))).statusCode).toBe(404);
});
it("keeps loopback-only operations closed on an actual HTTPS socket",async()=>{
  const admin=await setup();
  await update(admin,{public_enabled:true,entry_enabled:false});
  const dir=await mkdtemp(path.join(os.tmpdir(),"cdx-ingress-"));
  let tls:ReturnType<typeof tlsServer>|undefined;
  try {
    const args=["req","-x509","-newkey","rsa:2048","-nodes","-subj","/CN=localhost","-days","1","-keyout","key.pem","-out","cert.pem"];
    try{execFileSync("openssl",args,{cwd:dir,stdio:"ignore"});}catch(error){
      if(process.platform!=="win32" || (error as NodeJS.ErrnoException).code!=="ENOENT") throw error;
      execFileSync("C:/Program Files/Git/usr/bin/openssl.exe",args,{cwd:dir,stdio:"ignore"});
    }
    const cert=await readFile(path.join(dir,"cert.pem")),key=await readFile(path.join(dir,"key.pem"));
    tls=tlsServer({key,cert},app.routing);tls.listen(0,"127.0.0.1");await once(tls,"listening");
    const port=(tls.address() as AddressInfo).port;
    const probe=(url:string,method:string)=>new Promise<number>((resolve,reject)=>{
      const req=tlsRequest({hostname:"127.0.0.1",servername:"localhost",port,path:url,ca:cert,method,headers:{
        host:"localhost",authorization:"Bearer "+createInternalToken(ctx.masterKey)
      }},res=>{res.resume();resolve(res.statusCode??0);});
      req.on("error",reject);req.end();
    });
    expect(await probe("/api/health","GET")).toBe(200);
    expect(await probe("/api/auth/setup","POST")).toBe(404);
    expect(await probe("/internal/v1/responses","POST")).toBe(404);
  }finally{if(tls){tls.closeAllConnections();await new Promise<void>(resolve=>tls!.close(()=>resolve()));}await rm(dir,{recursive:true,force:true});}
});
it("persists bans, validates SVG challenges, restricts Basic access and rejects cross-site writes",async()=>{
  const admin=await setup(),alert=vi.fn(async()=>{});
  ctx.notifySecurity=alert;
  await update(admin,{max_failures:2,alerts:["login_ban","new_device"],captcha_enabled:true});
  expect((await app.inject("/api/auth/captcha")).json()).toMatchObject({id:expect.any(String),svg:expect.stringContaining("<svg")});
  for(let i=0;i<2;i++) expect((await post("/api/auth/login",{password})).statusCode).toBe(401);
  expect((await post("/api/auth/login",{password})).statusCode).toBe(429);
  const bans=(await app.inject({url:"/api/security/bans",headers:admin})).json();
  expect(bans[0]).toMatchObject({ip:"127.0.0.1",failures:2});
  expect(alert.mock.calls).toHaveLength(1);
  await app.inject({method:"DELETE",url:"/api/security/bans/127.0.0.1",headers:admin});
  const basicPassword=randomBytes(16).toString("hex");
  expect((await update(admin,{captcha_enabled:false,basic_enabled:true,basic_password:basicPassword})).body).not.toContain(basicPassword);
  expect((await app.inject({url:"/api/security/config",headers:admin})).statusCode).toBe(401);
  const auth={...admin,authorization:"Basic "+Buffer.from("admin:"+basicPassword).toString("base64")};
  expect((await app.inject({url:"/api/security/config",headers:auth})).statusCode).toBe(200);
  expect((await update({...auth,origin:"https://other.example"},{basic_enabled:false})).statusCode).toBe(403);
  expect((await post("/guest/"+"x".repeat(43),{code:"0000"},{...auth,"sec-fetch-site":"cross-site"})).statusCode).toBe(403);
  expect((await post("/api/security/reset",{},auth)).json()).toMatchObject({basic_enabled:false,public_enabled:false});
});
it("verifies TOTP enrollment, protects recovery at rest, prevents replay, and revokes old sessions",async()=>{
  expect(totp(Buffer.from("12345678901234567890"),1)).toBe("287082");
  const admin=await setup(),second=await post("/api/auth/login",{password});
  const enrollment=(await post("/api/security/totp/enroll",{},admin)).json();
  expect(enrollment.otpauth_uri).toContain(enrollment.manual_key);
  const pending=JSON.parse(decryptSecret(getSetting(ctx.native,"security.totp_pending")!,ctx.masterKey));
  const otp=totp(Buffer.from(pending.key,"base64"),Math.floor(Date.now()/30000));
  expect((await post("/api/security/totp/activate",{otp},{cookie:cookie(second.headers["set-cookie"])})).statusCode).toBe(400);
  const activated=await post("/api/security/totp/activate",{otp},admin);
  const codes=activated.json().recovery_codes as string[];
  expect(codes).toHaveLength(8);
  expect((await app.inject({url:"/api/models",headers:{cookie:cookie(second.headers["set-cookie"])}})).statusCode).toBe(401);
  expect((await post("/api/auth/login",{password,otp})).statusCode).toBe(401);
  expect((await post("/api/auth/login",{password,otp:codes[0]})).statusCode).toBe(200);
  expect((await post("/api/auth/login",{password,otp:codes[0]})).statusCode).toBe(401);
  const stored=JSON.stringify(ctx.native.prepare("SELECT * FROM settings UNION ALL SELECT event,details_json,created_at FROM audit_logs").all());
  expect(stored).not.toContain(pending.key);expect(stored).not.toContain(codes[1]);
  const next=randomBytes(32);rotateMasterKey(ctx.native,ctx.masterKey,next);ctx.masterKey=next;
  expect((await post("/api/auth/login",{password,otp:codes[1]})).statusCode).toBe(200);
  expect((await app.inject({url:"/api/models",headers:admin})).statusCode).toBe(401);
  const latest={cookie:cookie((await post("/api/auth/login",{password,otp:codes[2]})).headers["set-cookie"])};
  expect((await post("/api/security/totp/disable",{otp:codes[3]},latest)).statusCode).toBe(200);
  await update(latest,{single_session:true,session_hours:2});
  const login=await post("/api/auth/login",{password});expect(login.headers["set-cookie"]).toContain("Max-Age=7200");
  expect((await app.inject({url:"/api/security/config",headers:latest})).statusCode).toBe(401);
  const active={cookie:cookie(login.headers["set-cookie"])};
  const devices=(await app.inject({url:"/api/security/sessions",headers:active})).json();
  expect(devices).toHaveLength(1);expect(devices[0].current).toBe(true);
  expect((await app.inject({url:"/api/security/sessions/"+devices[0].session_id,method:"DELETE",headers:active})).statusCode).toBe(204);
  expect((await app.inject({url:"/api/security/config",headers:active})).statusCode).toBe(401);
  expect(readSecurityConfig(ctx.native).totp_enabled).toBe(false);
});
