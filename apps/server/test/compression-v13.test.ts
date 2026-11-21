import { randomBytes } from "node:crypto";
import { get } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { expect, test } from "vitest";
import { createServer,parseGatewayConfig } from "../src/app.js";
import { openDatabase, resolveDataDirectory } from "../src/db/index.js";
import { installationCode } from "../src/routes/auth.js";
import { SecretMasker } from "../src/security/secret-masker.js";

test("negotiates Brotli, gzip and identity on the wire for model lists and paginated turns",async()=>{
  const root=await mkdtemp(path.join(tmpdir(),"deck-compression-"));
  const data=await resolveDataDirectory("data",root),database=await openDatabase(data,root);
  const ctx={...database,masterKey:randomBytes(32),gatewayConfig:parseGatewayConfig(),masker:new SecretMasker()};
  const app=createServer(ctx,{dataDirectory:data,workspaceRoot:root});
  try {
    const base=await app.listen({host:"127.0.0.1",port:0});
    const setup=await app.inject({method:"POST",url:"/api/auth/setup",payload:{password:"fixture-compression-password",setup_code:installationCode(ctx.native,ctx.masterKey)}});
    expect(setup.statusCode).toBe(200);
    const cookie=String(setup.headers["set-cookie"]).split(";")[0];
    const db=ctx.native;
    db.exec(`INSERT INTO workspaces(id,name,path,created_at,updated_at) VALUES('w','w','w','','');
      INSERT INTO threads(id,workspace_id,title,status,created_at,updated_at) VALUES('t','w','thread','idle','','');
      INSERT INTO providers(id,name,preset,base_url,headers_json,quirks_json,created_at,updated_at)
      VALUES('p','provider','custom','https://example.invalid','{}','{}','','')`);
    db.prepare("INSERT INTO tasks(id,thread_id,workspace_id,prompt,status,answer_markdown,created_at,updated_at) VALUES('task','t','w','q','completed',?,'','')")
      .run("## 合同验收明细\n".repeat(1024));
    const model=db.prepare("INSERT INTO models(id,provider_id,alias,model_id,protocol,created_at,updated_at) VALUES(?,'p',?,?,'responses','','')");
    for(let n=0;n<16;n++)model.run("m"+n,"alias"+n,"model"+n);
    for(const route of ["/api/threads/t/turns","/api/models"]) {
      let plain:Buffer|undefined;
      for(const encoding of ["identity","gzip","br"] as const) {
        const response=await new Promise<import("node:http").IncomingMessage>((resolve,reject)=>{
          get(base+route,{headers:{cookie,"accept-encoding":encoding}},resolve).once("error",reject);
        });
        const chunks:Buffer[]=[];
        for await(const chunk of response) chunks.push(chunk);
        const wire=Buffer.concat(chunks);
        expect(response.statusCode).toBe(200);
        expect(response.headers["content-encoding"],route+" "+encoding).toBe(encoding==="identity"?undefined:encoding);
        if(encoding==="identity"){expect(wire.length).toBeGreaterThan(1024);plain=wire;continue;}
        expect(response.headers.vary).toMatch(/accept-encoding/i);
        expect(wire.length).toBeLessThan(plain!.length);
        expect((encoding==="br"?brotliDecompressSync:gunzipSync)(wire)).toEqual(plain);
      }
    }
  } finally {await app.close();database.native.close();await rm(root,{recursive:true,force:true});}
});
