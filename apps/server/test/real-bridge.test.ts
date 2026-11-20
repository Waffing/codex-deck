import { it, expect } from "vitest";
import { createServer as http } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { createServer, parseGatewayConfig } from "../src/app.js";
import { openDatabase } from "../src/db/index.js";
import { SecretMasker } from "../src/security/secret-masker.js";
import { installationCode } from "../src/routes/auth.js";

it.runIf(process.env.CODEXDECK_REAL_CODEX==="1")("runs the actual Codex stdio process against a local Responses model and approves an MCP action",async()=>{
  const data=await mkdtemp(path.join(os.tmpdir(),"codexdeck-real-cli-"));
  const ctx={...await openDatabase(data,path.dirname(data)),gatewayConfig:parseGatewayConfig({internal_token_ttl_seconds:1}),
    masterKey:randomBytes(32),masker:new SecretMasker()};
  const app=createServer(ctx,{dataDirectory:data});
  let calls=0, inventory:string[]=[];
  const model=http(async (req,res)=>{
    if (req.method!=="POST" || req.url!=="/v1/responses") { res.writeHead(404).end(); return; }
    const parts:Buffer[]=[]; for await(const part of req) parts.push(part);
    const request=JSON.parse(Buffer.concat(parts).toString()) as {tools:Array<{name?:string;type?:string;tools?:Array<{type?:string;name?:string}>}>};
    const tool=request.tools.find(t=>t.name?.endsWith("port_allocate"));
    inventory=request.tools.map(t=>[t.type,t.name,t.tools?.map(v=>`${v.type}/${v.name}`).join("|")].filter(Boolean).join("/"));
    calls++;
    const first=calls===1;
    const item=first ? {id:"fc_1",type:"function_call",name:tool?.name ?? "port_allocate",...(!tool && {namespace:"mcp__codexdeck_ops"}),
      call_id:"call_1",arguments:"{}",status:"completed"} : {id:"msg_2",type:"message",role:"assistant",status:"completed",
      content:[{type:"output_text",text:"Local bridge completed.",annotations:[]}]};
    const response={id:"resp_"+calls,object:"response",model:"fixture",status:"completed",created_at:Math.floor(Date.now()/1000),
      output:[item],usage:{input_tokens:20,output_tokens:5,total_tokens:25}};
    const frames=[
      {type:"response.created",response:{...response,status:"in_progress",output:[]}},
      {type:"response.output_item.added",output_index:0,item:{...item,status:"in_progress",...(first?{arguments:""}:{content:[]})}},
      ...(first? [{type:"response.function_call_arguments.delta",output_index:0,item_id:item.id,delta:"{}"}] :
        [{type:"response.content_part.added",output_index:0,content_index:0,item_id:item.id,part:{type:"output_text",text:"",annotations:[]}},
         {type:"response.output_text.delta",output_index:0,content_index:0,item_id:item.id,delta:"Local bridge completed."}]),
      {type:"response.output_item.done",output_index:0,item},
      {type:"response.completed",response}];
    res.writeHead(200,{"content-type":"text/event-stream"});
    res.end(frames.map((frame,sequence_number)=>`event: ${frame.type}\ndata: ${JSON.stringify({...frame,sequence_number})}\n\n`).join(""));
  });
  try {
    model.listen(0,"127.0.0.1"); await once(model,"listening");
    await app.listen({host:"127.0.0.1",port:0});
    ctx.native.prepare(`INSERT INTO providers(id,name,preset,base_url,headers_json,quirks_json,enabled,created_at,updated_at)
      VALUES('p','fixture','custom',?,'{}','{}',1,'','')`).run("http://127.0.0.1:"+(model.address() as AddressInfo).port+"/v1");
    ctx.native.exec("INSERT INTO models(id,provider_id,alias,model_id,protocol,created_at,updated_at) VALUES('m','p','fixture','fixture','responses','','')");
    const setup=await app.inject({method:"POST",url:"/api/auth/setup",payload:{password:randomBytes(20).toString("hex"),setup_code:installationCode(ctx.native,ctx.masterKey)}});
    const cookie=String(setup.headers["set-cookie"]).split(";")[0];
    const post=async(url:string,payload:Record<string,unknown>)=>{
      const r=await app.inject({method:"POST",url,payload,headers:{cookie}});
      expect(r.statusCode,r.body).toBeLessThan(300); return r.body ? r.json() : null;
    };
    const workspace=await post("/api/workspaces",{name:"offline-cli"});
    const thread=await post("/api/threads",{workspace_id:workspace.id});
    const task=await post(`/api/threads/${thread.id}/messages`,{prompt:"Allocate a staging port and report completion."});
    const diagnostic=()=>ctx.native.prepare("SELECT type,payload_json FROM thread_events WHERE thread_id=? AND type IN ('stderr','error','task_failed','ops_requested','unsupported_request','approval_req','item/completed') ORDER BY sequence DESC LIMIT 10")
      .all(thread.id).map(row=>{const r=row as {type:string;payload_json:string};return r.type+" "+r.payload_json.slice(0,350);}).join("\n");
    await expect.poll(()=>ctx.native.prepare("SELECT status FROM approvals WHERE thread_id=? ORDER BY rowid DESC LIMIT 1").pluck().get(thread.id),
      {timeout:20000,interval:200}).toBe("pending").catch(e=>{throw new Error(String(e)+"\n"+inventory.join(", ")+"\n"+diagnostic());});
    const approval=ctx.native.prepare("SELECT id FROM approvals WHERE thread_id=? AND status='pending'").pluck().get(thread.id);
    // Deliberately let the one-second lease expire while a real model turn awaits approval.
    await new Promise(resolve=>setTimeout(resolve,1250));
    await post("/api/approvals/"+approval+"/decision",{decision:"approve"});
    await expect.poll(async()=>{
      const next=ctx.native.prepare("SELECT id FROM approvals WHERE thread_id=? AND status='pending'").pluck().get(thread.id);
      if (next) await post("/api/approvals/"+next+"/decision",{decision:"approve"});
      return ctx.native.prepare("SELECT status FROM tasks WHERE id=?").pluck().get(task.task_id);
    },
      {timeout:20000,interval:200}).toBe("completed").catch(e=>{throw new Error(String(e)+"\n"+diagnostic());});
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(ctx.native.prepare("SELECT count(*) FROM thread_events WHERE thread_id=? AND type='ops_completed'").pluck().get(thread.id),
      inventory.join(", ")+"\n"+diagnostic()).toBe(1);
    expect(ctx.native.prepare("SELECT summary FROM tasks WHERE id=?").pluck().get(task.task_id)).toContain("Local bridge completed.");
  } finally {
    await app.close(); model.closeAllConnections(); await new Promise<void>(resolve=>model.close(()=>resolve()));
    ctx.native.close(); await rm(data,{recursive:true,force:true,maxRetries:3});
  }
},85000);
