import { randomBytes } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createServer, parseGatewayConfig, type ServerContext } from "../src/app.js";
import { openDatabase } from "../src/db/index.js";
import { SecretMasker } from "../src/security/secret-masker.js";
import { signAdminRequest, registerEmergencyRoute } from "../src/security/emergency.js";
import { listenPublicTls } from "../src/security/public-listener.js";
import { runAdmin } from "../src/admin-cli.js";
import { installationCode } from "../src/routes/auth.js";
import { Notifications, registerNotifications } from "../src/notifications/index.js";
import { decryptSecret } from "../src/security/crypto.js";

let root:string, data:string, ctx:ServerContext, app:ReturnType<typeof createServer>;
beforeEach(async()=>{
  root=await mkdtemp(path.join(os.tmpdir(),"cdx-admin-"));
  data=path.join(root,"data");await mkdir(data);
  ctx={...await openDatabase(data),masterKey:randomBytes(32),masker:new SecretMasker(),gatewayConfig:parseGatewayConfig()};
  app=createServer(ctx);registerEmergencyRoute(app,ctx);
});
afterEach(async()=>{
  vi.restoreAllMocks();vi.unstubAllEnvs();
  await app.close();ctx.native.close();await rm(root,{recursive:true,force:true});
});

it("binds the host credential to body, direct loopback peer, method and a single request",async()=>{
  const route="/api/admin/security/emergency",body={action:"preferences-set",input:{minimap:false}};
  const sign=()=>({"x-codexdeck-admin":signAdminRequest(ctx.masterKey,"POST",route,body)});
  const direct=sign();
  expect((await app.inject({url:route,method:"POST",remoteAddress:"127.0.0.1",headers:direct,payload:body})).statusCode).toBe(200);
  for(const headers of [direct,{...sign(),"x-forwarded-for":"198.51.100.1"}]) {
    expect((await app.inject({url:route,method:"POST",headers,payload:body})).statusCode).toBeGreaterThanOrEqual(400);
  }
  expect((await app.inject({url:route,method:"POST",headers:sign(),payload:{action:"security-reset"}})).statusCode).toBe(403);
  vi.stubEnv("CODEXDECK_DATA_DIR",data);vi.stubEnv("CODEXDECK_MASTER_KEY",ctx.masterKey.toString("hex"));
  const output=vi.spyOn(console,"log").mockImplementation(()=>{});
  await runAdmin(["--offline","preferences"]);expect(JSON.parse(output.mock.calls.at(-1)![0]).minimap).toBe(false);
  await runAdmin(["--offline","preferences-reset"]);
  const read={action:"preferences"};
  const reflected=await app.inject({url:route,method:"POST",headers:{"x-codexdeck-admin":signAdminRequest(ctx.masterKey,"POST",route,read)},payload:read});
  expect(reflected.json().minimap).toBe(true);
});

it("dispatches real HTTPS to the public security policy even from localhost",async()=>{
  const gitOpenSSL=path.join(process.env.ProgramFiles??"", "Git","usr","bin","openssl.exe");
  const ssl=process.platform==="win32" && existsSync(gitOpenSSL)?gitOpenSSL:"openssl";
  execFileSync(ssl,["req","-newkey","rsa:2048","-x509","-nodes","-days","1","-subj","/CN=localhost","-addext","subjectAltName=IP:127.0.0.1","-keyout",path.join(data,"panel-tls.key"),"-out",path.join(data,"panel-tls.crt")],{stdio:"ignore"});
  const socket=net.createServer();await new Promise<void>(r=>socket.listen(0,"127.0.0.1",r));
  const port=(socket.address() as net.AddressInfo).port;await new Promise<void>(r=>socket.close(()=>r()));
  vi.stubEnv("CODEXDECK_TLS_PORT",String(port));await app.ready();
  const server=await listenPublicTls(app,data,ctx.gatewayConfig.port,"127.0.0.1");
  try {
    const ca=await readFile(path.join(data,"panel-tls.crt"));
    const status=await new Promise<number|undefined>((ok,fail)=>{
      const req=https.request({hostname:"127.0.0.1",port,path:"/api/auth/setup",method:"POST",ca,agent:false},res=>{res.resume();ok(res.statusCode);});
      req.once("error",fail);req.end();
    });
    expect(status).toBe(404);
  } finally {await new Promise<void>(r=>server!.close(()=>r()));}
});

it("shares encrypted notification channels across Web, live host admin and offline CLI",async()=>{
  registerNotifications(app,ctx,new Notifications(ctx));
  const setup=await app.inject({method:"POST",url:"/api/auth/setup",payload:{
    password:randomBytes(24).toString("base64url"),setup_code:installationCode(ctx.native,ctx.masterKey)}});
  expect(setup.statusCode).toBe(200);
  const headers={cookie:String(setup.headers["set-cookie"]).split(";")[0]};
  const token=randomBytes(26).toString("base64url");
  const url="/api/notification-channels";
  const created=await app.inject({method:"POST",url,headers,payload:{name:"Alerts",type:"telegram",config:{chat_id:"test",token}}});
  expect(created.statusCode).toBe(201);expect(created.body).not.toContain(token);
  const id=created.json().id;
  const stored=()=>ctx.native.prepare("SELECT config_json FROM notification_channels WHERE id=?").pluck().get(id) as string;
  const initial=stored();expect(initial).not.toContain(token);
  const args=["--import",import.meta.resolve("tsx"),"src/admin-cli.ts","--offline"];
  const env={...process.env,CODEXDECK_MASTER_KEY:ctx.masterKey.toString("hex"),CODEXDECK_DATA_DIR:data};
  const edited=spawnSync(process.execPath,[...args,"channel-update",id],{env,input:JSON.stringify({enabled:false,name:"Night shift"}),encoding:"utf8"});
  expect(edited.status,edited.stderr).toBe(0);expect(edited.stdout+edited.stderr).not.toContain(token);
  expect(stored()).toBe(initial);
  const web=await app.inject({url,headers});expect(web.json()).toContainEqual(expect.objectContaining({id,enabled:false,name:"Night shift"}));
  const route="/api/admin/security/emergency";
  const host=(body:Record<string,unknown>)=>app.inject({method:"POST",url:route,
    headers:{"x-codexdeck-admin":signAdminRequest(ctx.masterKey,"POST",route,body)},payload:body});
  expect((await host({action:"channel-update",id,input:{config:{chat_id:"new"}}})).statusCode).toBe(200);
  expect(JSON.parse(decryptSecret(stored(),ctx.masterKey))).toEqual({chat_id:"new",token});
  const invalid=await app.inject({method:"PATCH",url:url+"/"+id,headers,payload:{type:"bark"}});
  expect(invalid.statusCode).toBe(400);
  const listed=await host({action:"channels"});expect(listed.body).not.toContain(token);expect(listed.body).not.toContain("config_json");
  expect((await host({action:"channel-delete",id})).statusCode).toBe(200);
  expect((await app.inject({url,headers})).json()).toEqual([]);
  expect(JSON.stringify(ctx.native.prepare("SELECT * FROM audit_logs").all())).not.toContain(token);
},30000);
