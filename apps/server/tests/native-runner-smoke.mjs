import assert from "node:assert/strict";
import {once} from "node:events";
import {createServer} from "node:http";
import {mkdtemp,mkdir,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {openDatabase} from "../dist/db/index.js";
import {createServer as createDeck,parseGatewayConfig} from "../dist/app.js";
import {installationCode} from "../dist/routes/auth.js";
import {SecretMasker} from "../dist/security/secret-masker.js";
import {randomBytes} from "node:crypto";
import {setTimeout as delay} from "node:timers/promises";

// Run as a regular Linux user with bubblewrap and the pinned Codex CLI installed.
assert.ok(process.getuid()>0);
process.env.CODEXDECK_INSTALL_MODE="native";
const fixture=await mkdtemp(path.join(tmpdir(),"cdx-native-"));
const project=path.join(fixture,"project"),data=path.join(fixture,"data");

process.env.CODEXDECK_MASTER_KEY="native-smoke-sentinel";
let calls=0;
const model=createServer(async(req,res)=>{
  if(req.url!=="/v1/responses") {res.writeHead(403).end();return;}
  const parts=[];
  for await(const part of req)parts.push(part);
  const body=JSON.parse(Buffer.concat(parts));
  const tools=(body.tools??[]).flatMap(t=>t.type==="namespace"?t.tools.map(child=>({...child,ns:t.name})):t);
  const tool=calls++===0 && tools.find(t=>["exec_command","shell_command","shell"].includes(t.name));
  const command='test "$(id -u)" != 0 && test -z "$CODEXDECK_MASTER_KEY" && test ! -e /run/docker.sock && test ! -e '+data+' && printf verified > /workspace/isolation.txt';
  const item=tool?{id:"fc_1",type:"function_call",name:tool.name,namespace:tool.ns,call_id:"call_1",status:"completed",
    arguments:JSON.stringify(tool.name==="exec_command"?{cmd:command}:tool.name==="shell_command"?{command}:{command:["sh","-c",command]})}:
    {id:"msg_2",type:"message",role:"assistant",status:"completed",content:[{type:"output_text",text:"Complete.",annotations:[]}]};
  const response={id:"resp_"+calls,object:"response",status:"completed",model:"fixture",created_at:1,output:[item],usage:{input_tokens:3,output_tokens:2,total_tokens:5}};
  const frames=[{type:"response.created",response:{...response,status:"in_progress",output:[]}},
    {type:"response.output_item.added",output_index:0,item:{...item,status:"in_progress",...(tool?{arguments:""}:{content:[]})}},
    ...(tool?[{type:"response.function_call_arguments.delta",output_index:0,item_id:item.id,delta:item.arguments}]:
      [{type:"response.content_part.added",output_index:0,content_index:0,item_id:item.id,part:{type:"output_text",text:"",annotations:[]}},
       {type:"response.output_text.delta",output_index:0,content_index:0,item_id:item.id,delta:"Complete."}]),
    {type:"response.output_item.done",output_index:0,item},{type:"response.completed",response}];
  res.writeHead(200,{"content-type":"text/event-stream"}).end(frames.map((frame,i)=>"event: "+frame.type+"\ndata: "+JSON.stringify({...frame,sequence_number:i})+"\n\n").join(""));
});
let app,db;
try {
  await mkdir(project);await mkdir(data,{recursive:true});
  model.listen(0,"127.0.0.1");await once(model,"listening");
  db=await openDatabase(data,fixture);
  const ctx={...db,masterKey:randomBytes(32),masker:new SecretMasker(),gatewayConfig:parseGatewayConfig()};
  app=createDeck(ctx,{dataDirectory:data,managedWorkspaceDirectory:project,workspaceRoot:fixture});
  await app.listen({host:"127.0.0.1",port:0});
  const setup=await app.inject({method:"POST",url:"/api/auth/setup",payload:{password:randomBytes(24).toString("hex"),setup_code:installationCode(db.native,ctx.masterKey)}});
  assert.equal(setup.statusCode,200,setup.body);
  const cookie=setup.headers["set-cookie"].split(";")[0];
  const api=async(method,url,payload)=>{
    const response=await app.inject({method,url,headers:{cookie},payload});
    assert.ok(response.statusCode<300,url+" "+response.body);
    return response.body?response.json():null;
  };
  db.native.prepare("INSERT INTO providers(id,name,preset,base_url,headers_json,quirks_json,enabled,created_at,updated_at) VALUES('p','fixture','custom',?,'{}','{}',1,'','')").run("http://127.0.0.1:"+model.address().port+"/v1");
  db.native.exec("INSERT INTO models(id,provider_id,alias,model_id,protocol,created_at,updated_at) VALUES('m','p','fixture','fixture','responses','','')");
  assert.equal((await api("POST","/api/settings/executor/detect",{})).strategy,"native");
  const workspace=await api("POST","/api/workspaces",{name:"native-runner"});
  await api("PATCH","/api/workspaces/"+workspace.id,{automation_level:"unrestricted"});
  const thread=await api("POST","/api/threads",{workspace_id:workspace.id});
  const task=await api("POST","/api/threads/"+thread.id+"/messages",{prompt:"Verify this isolated workspace."});
  const deadline=Date.now()+90000;
  for (;;) {
    const row=db.native.prepare("SELECT status,summary FROM tasks WHERE id=?").get(task.task_id);
    assert.notEqual(row.status,"failed",row.summary);
    if(row.status==="completed") break;
    assert.ok(Date.now()<deadline,"Timed out");
    await delay(100);
  }
  assert.equal(db.native.prepare("SELECT COUNT(*) FROM approvals").pluck().get(),0);
  assert.equal(await readFile(path.join(workspace.path,"isolation.txt"),"utf8"),"verified");
  assert.ok(calls>=2);
  console.log("Linux HTTP acceptance passed. Full-access setting, scoped model relay, approval-free Codex shell and isolated checkpoints verified.");
} finally {
  await app?.close();db?.native.close();
  model.close();model.closeAllConnections();
  await rm(fixture,{recursive:true,force:true});
}
