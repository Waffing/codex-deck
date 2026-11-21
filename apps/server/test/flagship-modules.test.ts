import {randomBytes,randomUUID} from "node:crypto";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {expect,it} from "vitest";
import {createServer,parseGatewayConfig} from "../src/app.js";
import {openDatabase} from "../src/db/index.js";
import {SecretMasker} from "../src/security/secret-masker.js";
import {installationCode} from "../src/routes/auth.js";
import {generateCodexConfig} from "../src/codex/config-gen.js";
import {readFile} from "node:fs/promises";

it("persists admin modules, probes the real bundled MCP, and isolates disabled and external tools",async()=>{
  const data=await mkdtemp(path.join(tmpdir(),"deck-modules-")),masterKey=randomBytes(32);
  const ctx={...await openDatabase(data),masterKey,masker:new SecretMasker(),gatewayConfig:parseGatewayConfig()};
  const app=createServer(ctx,{dataDirectory:data});
  try {
    expect((await app.inject("/api/mcp")).statusCode).toBe(401);
    const login=await app.inject({method:"POST",url:"/api/auth/setup",payload:{setup_code:installationCode(ctx.native,masterKey),password:randomBytes(16).toString("hex")}});
    const headers={cookie:String(login.headers["set-cookie"]).split(";")[0]};
    const req=(method:"GET"|"POST"|"PATCH"|"PUT"|"DELETE",url:string,payload?:Record<string,unknown>,etag?:string)=>
      app.inject({method,url,headers:{...headers,...(etag?{"if-match":etag}:{})},payload});
    const template=(await req("POST","/api/prompts",{name:"Review",content:"Review this change"})).json();
    expect(template.id).toBeTypeOf("string");
    expect((await req("PATCH","/api/prompts/"+template.id,{name:"Review patch"})).json().name).toBe("Review patch");
    expect((await req("GET","/api/prompts")).json()).toHaveLength(1);
    expect((await req("DELETE","/api/prompts/"+template.id)).statusCode).toBe(204);
    expect((await req("POST","/api/mcp/codexdeck_ops/probe",{})).json().status).toBe("online");
    expect((await req("POST","/api/mcp",{name:"bad",url:"https://user:secret@tools.invalid/mcp"})).statusCode).toBe(400);
    const custom=(await req("POST","/api/mcp",{name:"Docs",url:"https://tools.invalid/mcp"})).json();
    await req("PATCH","/api/mcp/codexdeck_ops",{enabled:false});
    ctx.native.exec(`INSERT INTO providers(id,name,preset,base_url,headers_json,quirks_json,created_at,updated_at) VALUES('p','p','custom','https://example.test','{}','{}','','');
      INSERT INTO models(id,provider_id,alias,model_id,created_at,updated_at) VALUES('m','p','writer','writer','','');`);
    const ws=(await req("POST","/api/workspaces",{name:"demo"})).json();
    const config=async(external:boolean)=>{
      const {codexHome}=await generateCodexConfig({dataDirectory:data,native:ctx.native,port:3210,masterKey,thread:{id:randomUUID(),globalInstructions:"",opsEntry:"fixture",external}});
      return readFile(path.join(codexHome,"config.toml"),"utf8");
    };
    expect(await config(false)).toContain(custom.url);expect(await config(true)).not.toContain(custom.url);
    expect(await config(false)).not.toContain("[mcp_servers.codexdeck_ops]");
    expect((await req("PATCH","/api/plugins/global_search",{enabled:false})).json().enabled).toBe(false);
    expect((await req("GET","/api/search?q=demo")).json().messages).toEqual([]);
    expect((await req("GET","/api/plugins")).json()).toHaveLength(5);
    const skill="/api/workspaces/"+ws.id+"/skills/check-style?scope=project";
    const saved=await req("PUT",skill,{content:"# Style"});expect(saved.statusCode).toBe(200);
    expect((await req("GET",skill)).json().content).toBe("# Style");
    expect((await req("GET","/api/workspaces/"+ws.id+"/skills")).json()).toEqual(["check-style"]);
    expect((await req("PUT",skill,{content:"new"},"stale")).statusCode).toBe(409);
    expect((await req("DELETE",skill,undefined,saved.json().revision)).statusCode).toBe(204);
    const source=(await req("POST","/api/threads",{workspace_id:ws.id,model_alias:"writer"})).json();
    const branch=(await req("POST","/api/threads/"+source.id+"/fork",{})).json();
    expect(branch.parent_thread_id).toBe(source.id);
    expect((await req("POST","/api/threads/archive",{ids:[source.id,branch.id],archived:true})).json().count).toBe(2);
    expect((await req("GET","/api/threads")).json()).toHaveLength(0);
    expect((await req("GET","/api/threads/archived")).json()).toHaveLength(2);
    expect((await req("POST","/api/threads/"+source.id+"/messages",{prompt:"archived"})).statusCode).toBe(409);
    await req("POST","/api/threads/archive",{ids:[source.id],archived:false});
    expect((await req("GET","/api/threads")).json()[0].id).toBe(source.id);
    expect((await req("GET","/api/usage/today")).json()).toMatchObject({tokens:0,requests:0,cost_usd:0,cost_cny:0});
  }finally{await app.close();ctx.native.close();await rm(data,{recursive:true,force:true});}
});
