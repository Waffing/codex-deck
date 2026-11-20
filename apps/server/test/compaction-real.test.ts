import {expect,it} from "vitest";
import {createServer as http} from "node:http";
import {once} from "node:events";
import type {AddressInfo} from "node:net";
import {mkdtemp,rm} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {randomBytes} from "node:crypto";
import {createServer,parseGatewayConfig} from "../src/app.js";
import {openDatabase} from "../src/db/index.js";
import {SecretMasker} from "../src/security/secret-masker.js";
import {installationCode} from "../src/routes/auth.js";

it.runIf(process.env.CODEXDECK_REAL_CODEX==="1")("resumes a compacted thread after a server and CLI restart using only the durable handoff",async()=>{
  const data=await mkdtemp(path.join(os.tmpdir(),"codexdeck-real-compact-"));
  const masterKey=randomBytes(32);
  const context=async()=>({...await openDatabase(data,path.dirname(data)),gatewayConfig:parseGatewayConfig(),masterKey,masker:new SecretMasker()});
  let ctx=await context(),app=createServer(ctx,{dataDirectory:data});
  const inputs:string[]=[];
  let failSummary=true;
  const upstream=http(async(req,res)=>{
    let body="";for await(const chunk of req) body+=chunk;
    const input=JSON.parse(body);
    if(input.stream===false) {
      if(failSummary) {res.writeHead(500).end();return;}
      res.writeHead(200,{"content-type":"application/json"}).end(JSON.stringify({status:"completed",output:[{type:"message",content:[{type:"output_text",text:"Preserve marker HANDOFF-4712"}]}]}));return;
    }
    inputs.push(JSON.stringify(input.input));
    const message={id:"msg_"+inputs.length,type:"message",role:"assistant",status:"completed",content:[{type:"output_text",text:"Verified.",annotations:[]}]};
    const response={id:"resp_"+inputs.length,status:"completed",object:"response",model:"fixture",created_at:Math.floor(Date.now()/1000),output:[message],usage:{input_tokens:12,output_tokens:2,total_tokens:14}};
    const frames=[{type:"response.created",response:{...response,status:"in_progress",output:[]}},
      {type:"response.output_item.added",output_index:0,item:{...message,status:"in_progress",content:[]}},
      {type:"response.output_text.delta",item_id:message.id,output_index:0,content_index:0,delta:"Verified."},
      {type:"response.output_item.done",output_index:0,item:message},{type:"response.completed",response}];
    res.writeHead(200,{"content-type":"text/event-stream"});res.end(frames.map((f,sequence_number)=>`event: ${f.type}\ndata: ${JSON.stringify({...f,sequence_number})}\n\n`).join(""));
  });
  try {
    upstream.listen(0,"127.0.0.1");await once(upstream,"listening");
    ctx.native.prepare("INSERT INTO providers(id,name,preset,base_url,headers_json,quirks_json,enabled,created_at,updated_at) VALUES('p','fixture','custom',?,'{}','{}',1,'','')").run(`http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`);
    ctx.native.exec("INSERT INTO models(id,provider_id,alias,model_id,protocol,created_at,updated_at) VALUES('m','p','fixture','fixture','responses','','')");
    await app.listen({port:0,host:"127.0.0.1"});
    const password=randomBytes(20).toString("hex");
    const setup=await app.inject({method:"POST",url:"/api/auth/setup",payload:{password,setup_code:installationCode(ctx.native,masterKey)}});
    const cookie=String(setup.headers["set-cookie"]).split(";")[0];
    const post=(url:string,payload:Record<string,unknown>)=>app.inject({method:"POST",url,payload,headers:{cookie}});
    const workspace=(await post("/api/workspaces",{name:"fresh"})).json();
    const thread=(await post("/api/threads",{workspace_id:workspace.id})).json().id;
    const ask=async(prompt:string)=>{
      const reply=await post(`/api/threads/${thread}/messages`,{prompt});expect(reply.statusCode,reply.body).toBe(202);
      await expect.poll(()=>ctx.native.prepare("SELECT status FROM tasks WHERE id=?").pluck().get(reply.json().task_id),{timeout:25000}).toBe("completed");
    };
    await ask("Original unique marker OLD-CONTEXT-9876");
    const remote=()=>ctx.native.prepare("SELECT remote_thread_id FROM threads WHERE id=?").pluck().get(thread);
    const before=remote();const fail=await post(`/api/threads/${thread}/compact`,{});
    expect(fail.statusCode).toBeGreaterThanOrEqual(500);expect(remote()).toBe(before);
    failSummary=false;
    const compact=await post(`/api/threads/${thread}/compact`,{});
    expect(compact.statusCode,compact.body).toBe(200);expect(remote()).not.toBe(before);
    await app.close();ctx.native.close();ctx=await context();app=createServer(ctx,{dataDirectory:data});await app.listen({port:0,host:"127.0.0.1"});
    await ask("Continue after restart.");
    expect(inputs.at(-1)).toContain("HANDOFF-4712");expect(inputs.at(-1)).toContain("Continue after restart.");expect(inputs.at(-1)).not.toContain("OLD-CONTEXT-9876");
  } finally {await app.close();ctx.native.close();upstream.closeAllConnections();await new Promise<void>(r=>upstream.close(()=>r()));await rm(data,{recursive:true,force:true,maxRetries:3});}
},90000);
