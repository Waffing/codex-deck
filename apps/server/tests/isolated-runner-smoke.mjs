import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";

// The model fixture chooses tools deterministically. Codex, Docker, the gateway,
// the approval engine and the deployer below are the production implementations.
async function exercise() {
  const {default:assert}=await import("node:assert/strict");
  const {createServer:http}=await import("node:http");
  const {randomBytes}=await import("node:crypto");
  const {once}=await import("node:events");
  const fs=await import("node:fs/promises");
  const {setTimeout:delay}=await import("node:timers/promises");
  const {openDatabase}=await import("./dist/db/index.js");
  const {createServer,parseGatewayConfig}=await import("./dist/app.js");
  const {installationCode}=await import("./dist/routes/auth.js");
  const {SecretMasker}=await import("./dist/security/secret-masker.js");
  const fixture=await fs.mkdtemp("/data/runner-ci-");
  const ctx={...await openDatabase(fixture),masterKey:randomBytes(32),masker:new SecretMasker(),gatewayConfig:parseGatewayConfig()};
  const app=createServer(ctx,{dataDirectory:fixture,managedWorkspaceDirectory:"/workspaces",portPool:[27500,27800]});
  let step=0,calls=0,inventory=[],fixtureFailure,thread;
  const releases=()=>ctx.native.prepare("SELECT id,status FROM deployments ORDER BY rowid").all();
  const sequence=["shell","app_deploy_staging","app_promote_live","shell","app_deploy_staging","app_promote_live","app_rollback"];
  const model=http(async(req,res)=>{
    try {
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const body=JSON.parse(Buffer.concat(chunks));
      const all=(body.tools??[]).flatMap(t=>t.type==="namespace" ? t.tools.map(sub=>({...sub,ns:t.name})) : [t]);
      inventory=all.map(t=>t.name||t.type);
      const name=sequence[step];
      const tool=name==="shell" ? all.find(t=>["exec_command","shell_command","shell"].includes(t.name)) :
        all.find(t=>name && (t.name===name || t.name?.endsWith("__"+name)));
      const n=++calls;
      let item;
      if(tool){
        let args={};
        if(name==="shell"){
          const marker=step===0?"alpha":"beta";
          const script="test \"$(id -u)\" != 0 && test -z \"$CODEXDECK_MASTER_KEY\" && test ! -S /var/run/docker.sock && test ! -f /data/codexdeck.sqlite && npm test && mkdir -p public && printf "+marker+" > public/index.html";
          args=tool.name==="exec_command"?{cmd:script}:tool.name==="shell_command"?{command:script}:{command:["sh","-c",script]};
        }else if(name==="app_deploy_staging")args={mode:"docker",public_dir:"public"};
        else if(name==="app_promote_live")args={deployment_id:releases().at(-1)?.id,expected_content:step===2?"alpha":"beta"};
        else if(name==="app_rollback")args={deployment_id:releases().at(-1)?.id};
        item={id:"fc_"+n,type:"function_call",call_id:"call_"+n,name:tool.name,...(tool.ns?{namespace:tool.ns}:{}),arguments:JSON.stringify(args),status:"completed"};
        step++;
      }else item={id:"msg_"+n,type:"message",role:"assistant",status:"completed",content:[{type:"output_text",text:"Fixture turn complete.",annotations:[]}]};
      const response={id:"resp_"+n,object:"response",status:"completed",model:"fixture",created_at:Math.floor(Date.now()/1000),output:[item],usage:{input_tokens:4,output_tokens:2,total_tokens:6}};
      const frames=[{type:"response.created",response:{...response,status:"in_progress",output:[]}},
        {type:"response.output_item.added",output_index:0,item:{...item,status:"in_progress",...(tool?{arguments:""}:{content:[]})}},
        ...(tool?[{type:"response.function_call_arguments.delta",output_index:0,item_id:item.id,delta:item.arguments}]:
          [{type:"response.content_part.added",output_index:0,content_index:0,item_id:item.id,part:{type:"output_text",text:"",annotations:[]}},
           {type:"response.output_text.delta",output_index:0,content_index:0,item_id:item.id,delta:item.content[0].text}]),
        {type:"response.output_item.done",output_index:0,item},{type:"response.completed",response}];
      res.writeHead(200,{"content-type":"text/event-stream"}).end(frames.map((v,sequence_number)=>"event: "+v.type+"\ndata: "+JSON.stringify({...v,sequence_number})+"\n\n").join(""));
    }catch(e){fixtureFailure=e;res.writeHead(500).end();}
  });
  try{
    model.listen(0,"127.0.0.1"); await once(model,"listening");
    await app.listen({port:0,host:"127.0.0.1"});
    ctx.native.prepare("INSERT INTO providers(id,name,preset,base_url,headers_json,quirks_json,enabled,created_at,updated_at) VALUES('p','fixture','custom',?,'{}','{}',1,'','')").run("http://127.0.0.1:"+model.address().port+"/v1");
    ctx.native.exec("INSERT INTO models(id,provider_id,alias,model_id,protocol,created_at,updated_at) VALUES('m','p','fixture','fixture','responses','','')");
    const setup=await app.inject({method:"POST",url:"/api/auth/setup",payload:{password:randomBytes(24).toString("hex"),setup_code:installationCode(ctx.native,ctx.masterKey)}});
    assert.equal(setup.statusCode,200,setup.body);
    const cookie=setup.headers["set-cookie"].split(";")[0];
    const api=async(method,url,payload)=>{
      const r=await app.inject({method,url,headers:{cookie},payload});assert.ok(r.statusCode<300,url+" "+r.body);return r.body?r.json():null;
    };
    assert.equal((await api("GET","/api/runtime/capabilities")).isolated_executor,true);
    const ws=await api("POST","/api/workspaces",{name:"isolated-runner-CI",automation_level:"unrestricted"});
    await fs.writeFile(ws.path+"/package.json",JSON.stringify({scripts:{test:"node -e \"process.exit(0)\""}}));
    thread=await api("POST","/api/threads",{workspace_id:ws.id});
    await api("POST","/api/threads/"+thread.id+"/warmup",{});
    assert.equal(calls,0);
    const ask=()=>api("POST","/api/threads/"+thread.id+"/messages",{prompt:"Verify this fixture."});
    let task=await ask();
    const deadline=Date.now()+150000;
    let ok=false;
    while(Date.now()<deadline){
      if(fixtureFailure)throw fixtureFailure;
      assert.equal(ctx.native.prepare("SELECT count(*) FROM approvals WHERE status='pending'").pluck().get(),0);
      const row=ctx.native.prepare("SELECT status,summary FROM tasks WHERE id=?").get(task.task_id);
      if(row.status==="failed")throw new Error(row.summary);
      if(row.status==="completed"){
        if(step===sequence.length){ok=true;break;}
        if(calls>30)break;
        await delay(300);task=await ask();
      }
      await delay(100);
    }
    assert.ok(ok,"tool progress "+step+"; inventory "+inventory.join(","));
    assert.equal(await fs.readFile(ws.path+"/public/index.html","utf8"),"beta");
    assert.deepEqual(releases().map(r=>r.status),["live","rolled_back"]);
    assert.equal(ctx.native.prepare("SELECT count(*) FROM approvals WHERE action LIKE 'ops/%' AND status='approved_auto'").pluck().get(),5);
    for(const r of releases())await api("POST","/api/deployments/"+r.id+"/action",{action:"stop"});
    console.log("PASS real isolated Codex: npm test, workspace write, two releases, promotion and rollback, zero prompts.");
  }catch(error){
    const rows=ctx.native.prepare("SELECT type,payload_json FROM thread_events WHERE type IN ('stderr','task_failed','ops_failed','unsupported_request','error') ORDER BY rowid DESC LIMIT 8").all();
    console.error("Fixture diagnostic",ctx.masker.maskObject(rows.map(r=>[r.type,r.payload_json.slice(0,400)])));
    throw error;
  }finally{
    await app.close();model.closeAllConnections();model.close();ctx.native.close();await fs.rm(fixture,{recursive:true});
  }
}
const container=process.env.CODEXDECK_SMOKE_CONTAINER;
assert.match(container??"",/^[a-f0-9]{12,64}$/);
const child=spawnSync("docker",["exec","-i","--workdir","/app/apps/server",container,"sh","-ec",'exec gosu "$PUID:$PGID" node --input-type=module'],
  {input:"await ("+exercise.toString()+")();",stdio:["pipe","inherit","inherit"],timeout:240000});
if(child.error)throw child.error;
process.exitCode=child.status??1;
