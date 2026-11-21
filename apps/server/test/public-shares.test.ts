import {afterAll,beforeAll,expect,test} from "vitest";
import {mkdir,mkdtemp,rm,writeFile,rename} from "node:fs/promises";
import path from "node:path";
import {tmpdir} from "node:os";
import {randomBytes} from "node:crypto";
import {createServer,parseGatewayConfig,type ServerContext} from "../src/app.js";
import {openDatabase} from "../src/db/index.js";
import {SecretMasker} from "../src/security/secret-masker.js";
import {installationCode} from "../src/routes/auth.js";
import {WorkspaceFiles} from "../src/files/workspace-files.js";
import {readSecurityConfig} from "../src/security/config.js";
import type {PublicShare} from "@codexdeck/shared";

let root:string,ctx:ServerContext,app:ReturnType<typeof createServer>,admin:string,artifact:string,workspacePath:string;
const source="<h1>Release snapshot</h1><script>document.title='preview'</script>";
const cookie=(res:{headers:Record<string,unknown>})=>String(res.headers["set-cookie"]).split(";")[0];
const request=(method:"GET"|"POST"|"PATCH"|"DELETE",url:string,session="",payload?:Record<string,unknown>)=>
  app.inject({method,url,headers:{cookie:session},payload});
const verify=(slug:string,code?:string,session="")=>request("POST","/api/public/shares/"+slug+"/verify",session,code?{passcode:code}:{});
const read=(slug:string,session:string,mode="content")=>request("GET","/api/public/shares/"+slug+"/"+mode,session);
async function publish(options:Record<string,unknown>={}) {
  const res=await request("POST","/api/shares",admin,{artifact_id:artifact,...options});
  expect(res.statusCode,res.payload).toBe(201);
  return res.json<PublicShare>();
}
beforeAll(async()=>{
  root=await mkdtemp(path.join(tmpdir(),"deck-public-share-"));
  const data=path.join(root,"data"),web=path.join(root,"web");
  await mkdir(data);await mkdir(path.join(web,".vite"),{recursive:true});await mkdir(path.join(web,"assets"));
  await writeFile(path.join(web,"share.html"),"<main>share-only</main>");
  await writeFile(path.join(web,"index.html"),"<main>control plane</main>");
  await writeFile(path.join(web,"assets/share-build.js"),"window.share=true");
  await writeFile(path.join(web,"assets/admin-build.js"),"window.admin=true");
  await writeFile(path.join(web,".vite/manifest.json"),JSON.stringify({"share.html":{file:"assets/share-build.js"},"index.html":{file:"assets/admin-build.js"}}));
  const db=await openDatabase(data,root);
  ctx={...db,masterKey:randomBytes(32),masker:new SecretMasker(),gatewayConfig:parseGatewayConfig()};
  app=createServer(ctx,{dataDirectory:data,workspaceRoot:root,webRoot:web});
  const setup=await request("POST","/api/auth/setup","",{password:"LocalFixtureSharePassword",setup_code:installationCode(db.native,ctx.masterKey)});
  expect(setup.statusCode,setup.payload).toBe(200);admin=cookie(setup);
  const files=new WorkspaceFiles(ctx,data,()=>{});
  const ws=await files.create("Share snapshot","conservative");
  workspacePath=ws.path;
  await writeFile(path.join(ws.path,"readme.html"),source);
  artifact=(await files.registerArtifact(ws.id,null,null,"readme.html","added")).id;
});
afterAll(async()=>{await app?.close();ctx?.native.close();if(root)await rm(root,{recursive:true,force:true});});

test("admins publish immutable, expiring snapshots with download disabled by default",async()=>{
  expect((await request("GET","/api/shares")).statusCode).toBe(401);
  const s=await publish();
  expect(s.allow_download).toBe(false);expect(s.requires_passcode).toBe(false);
  expect((Date.parse(s.expires_at)-Date.parse(s.created_at))/86400000).toBeCloseTo(7,4);
  await rename(path.join(workspacePath,"readme.html"),path.join(workspacePath,"renamed.html"));
  await writeFile(path.join(workspacePath,"readme.html"),"updated");
  expect((await read(s.slug,"")).statusCode).toBe(401);
  const permit=await verify(s.slug);expect(permit.json().state).toBe("ready");
  const visitor=cookie(permit);
  const r=await read(s.slug,visitor);expect(r.payload).toBe(source);
  expect(r.headers["content-security-policy"]).toContain("sandbox allow-scripts;");
  expect(r.headers["content-security-policy"]).not.toMatch(/allow-same-origin/);
  expect(r.headers["cache-control"]).toContain("no-store");
  expect(r.headers["content-type"]).toContain("text/plain");
  ctx.masker.register("Release snapshot");
  expect((await read(s.slug,visitor)).payload).not.toContain("Release snapshot");
  expect((await read(s.slug,visitor,"download")).statusCode).toBe(403);
  expect((await request("PATCH","/api/shares/"+s.id,admin,{allow_download:true})).statusCode).toBe(200);
  const download=await read(s.slug,visitor,"download");expect(download.payload).not.toContain("Release snapshot");expect(download.payload).toContain("<h1>");expect(download.headers["content-disposition"]).toContain("attachment");
  expect((await request("GET","/api/shares",admin)).json<PublicShare[]>().find(row=>row.id===s.id)?.view_count).toBe(1);
  const other=await publish();expect((await read(other.slug,visitor)).statusCode).toBe(401);
});
test("concurrent readers compete for the final slot; an admitted reader may refresh; extension and revocation take effect immediately",async()=>{
  const s=await publish({max_views:1,passcode:"sample-pass"});
  expect((await verify(s.slug)).json()).toEqual({state:"locked"});
  expect((await request("GET","/api/shares",admin)).payload).not.toMatch(/sample-pass|scrypt\$/);
  const readers=await Promise.all([verify(s.slug,"sample-pass"),verify(s.slug,"sample-pass")]);
  const results=await Promise.all(readers.map(r=>read(s.slug,cookie(r))));
  expect(results.map(r=>r.statusCode).sort()).toEqual([200,410]);
  const winner=cookie(readers[results.findIndex(r=>r.statusCode===200)]);
  expect((await verify(s.slug,undefined,winner)).json().state).toBe("ready");
  expect((await read(s.slug,winner)).statusCode).toBe(200);
  expect((await verify(s.slug)).json().state).toBe("unavailable");
  ctx.native.prepare("UPDATE public_shares SET expires_at=? WHERE id=?").run(new Date(0).toISOString(),s.id);
  expect((await read(s.slug,winner)).statusCode).toBe(410);
  expect((await request("PATCH","/api/shares/"+s.id,admin,{expires_at:new Date(Date.now()+86400000).toISOString(),max_views:2})).statusCode).toBe(200);
  expect((await read(s.slug,winner)).statusCode).toBe(200);
  expect((await request("DELETE","/api/shares/"+s.id,admin)).statusCode).toBe(204);
  expect((await read(s.slug,winner)).statusCode).toBe(410);
  expect((await verify(s.slug,undefined,winner)).json()).toEqual({state:"unavailable"});
  expect((await request("PATCH","/api/shares/"+s.id,admin,{allow_download:true})).statusCode).toBe(410);
});
test("public exceptions require verified HTTPS and only expose the share shell, viewer assets and exact reader methods",async()=>{
  const s=await publish(),previous=readSecurityConfig(ctx.native),trust=process.env.CODEXDECK_TRUSTED_PROXIES;
  const update=(cfg:typeof previous)=>ctx.native.prepare("UPDATE settings SET value=? WHERE key='security.config'").run(JSON.stringify(cfg));
  process.env.CODEXDECK_TRUSTED_PROXIES="127.0.0.1";
  const ext=(url:string,method:"GET"|"POST"="GET",scheme="https")=>app.inject({url,method,remoteAddress:"127.0.0.1",headers:{host:"public.example","x-forwarded-for":"203.0.113.10","x-forwarded-proto":scheme},payload:method==="POST"?{}:undefined});
  try{
    update({...previous,public_enabled:false});
    expect((await ext("/s/"+s.slug)).payload).not.toContain("share-only");
    update({...previous,public_enabled:true,entry_enabled:true,basic_enabled:true,ip_mode:"allow",ip_ranges:["127.0.0.1"]});
    expect((await ext("/s/"+s.slug)).payload).toContain("share-only");
    expect((await ext("/assets/share-build.js")).payload).toContain("window.share");
    expect((await ext("/assets/admin-build.js")).payload).not.toContain("window.admin");
    expect((await ext("/s/"+s.slug,"GET","http")).payload).not.toContain("share-only");
    expect((await ext("/api/shares")).statusCode).not.toBe(200);
    expect((await ext("/api/public/shares/"+s.slug+"/verify","POST")).json().state).toBe("ready");
    expect((await ext("/api/public/shares/"+s.slug+"/verify")).statusCode).not.toBe(200);
  }finally{update(previous);if(trust===undefined)delete process.env.CODEXDECK_TRUSTED_PROXIES;else process.env.CODEXDECK_TRUSTED_PROXIES=trust;}
});
test("incorrect passcodes have an IP-wide limit across shares",async()=>{
  const s=await publish({passcode:"actual-passcode"}),other=await publish({passcode:"other-passcode"});
  for(let i=0;i<5;i++)expect((await verify(s.slug,"wrong")).statusCode).toBe(403);
  const blocked=await verify(other.slug,"other-passcode");
  expect(blocked.statusCode).toBe(429);expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
});
