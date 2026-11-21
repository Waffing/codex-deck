import { createInterface } from "node:readline";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const config = await readFile(join(process.env.CODEX_HOME,"config.toml"),"utf8");
const base = /^base_url = "(.*?)"/m.exec(config)[1];
const alias = /^model = "(.*?)"/m.exec(config)[1];
let threadId, turnId;
let approvalId;
let consoleItem;
const emit = frame => process.stdout.write(JSON.stringify(frame) + "\n");
const notify = (method,params={}) => emit({method,params:{threadId,...params}});
const delta = text => notify("item/agentMessage/delta",{turnId,itemId:"agent",delta:text});
const end = (status = "completed") => notify("turn/completed",{turn:{id:turnId,status,items:[]}});

async function receive(msg) {
  const {method,params = {},id} = msg;
  const reply = result => emit({id,result});
  if (method === "initialize") { reply({userAgent:"fake-codex-app-server"}); return; }
  if (method === "initialized") return;
  if (method === "thread/inject_items") {
    if (params.threadId!==threadId || !Array.isArray(params.items)) {emit({id,error:{code:-32602,message:"Invalid thread items"}});return;}
    await writeFile(join(process.env.CODEX_HOME,"fixture-context-"+threadId),JSON.stringify(params.items));
    reply({});return;
  }
  if (method === "thread/start" || method === "thread/resume") {
    threadId = params.threadId ?? randomUUID();
    reply({thread:{id:threadId}});
    notify("fixture/process",{pid:process.pid,method});
    return;
  }
  if (method === "turn/start") {
    turnId = randomUUID();
    reply({turn:{id:turnId,status:"inProgress",items:[]}});
    notify("turn/started",{turn:{id:turnId,status:"inProgress"}});
    const prompt = params.input[0].text;
    if(prompt==="test effective window") {
      notify("thread/tokenUsage/updated",{turnId,tokenUsage:{modelContextWindow:64000,last:{totalTokens:16000}}});
      delta("Window confirmed.");end();return;
    }
    if(prompt==="check handoff") {
      const history=await readFile(join(process.env.CODEX_HOME,"fixture-context-"+threadId),"utf8");
      delta(history);end();return;
    }
    if (prompt === "核验工作台 V1.1") {
      notify("thread/status/changed",{status:{type:"active"}});
      notify("item/reasoning/summaryTextDelta",{turnId,itemId:"summary",delta:"先核对文件说明，再比对测试输出。"});
      for(const file of ["README.md","result.txt"]) {
        const item={id:randomUUID(),type:"commandExecution",command:`cat ${file}`,commandActions:[{type:"read",path:file}]};
        notify("item/started",{turnId,item});notify("item/completed",{turnId,item:{...item,status:"completed",aggregatedOutput:"ok"}});
      }
      notify("turn/plan/updated",{turnId,plan:[{step:"核对说明",status:"completed"},{step:"检查输出",status:"completed"}]});
      notify("thread/tokenUsage/updated",{turnId,tokenUsage:{last:{totalTokens:113000,inputTokens:112980,cachedInputTokens:100000,outputTokens:20}}});
      delta("## 核验结果\n\n**全部通过**。文件 `result.txt` 检查成功，耗时 12ms。曾有警告，已修复。\n\n```js\nconst result = true;\n```\n");
      end();return;
    }
    if (prompt === "启动预发布验收站点") {
      await mkdir("public",{recursive:true});
      await writeFile("public/index.html","<!doctype html><meta charset=utf-8><title>Preview</title><p>CodexDeck preview ready</p>");
      const stage = await fetch(process.env.CODEXDECK_OPS_URL+"/app_deploy_staging",{
        method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+process.env.CODEXDECK_OPS_TOKEN},
        body:JSON.stringify({mode:"local"}),
      });
      delta(stage.ok?"预发布服务已就绪。":"预发布失败。");
      end(stage.ok?"completed":"failed");return;
    }
    if (prompt === "检查工作区并生成验收摘要") {
      delta("正在检查工作区。");
      consoleItem = {id:randomUUID(),type:"commandExecution",command:"git status",commandActions:[]};
      notify("item/started",{turnId,item:consoleItem});
      approvalId = "req-" + randomUUID();
      emit({id:approvalId,method:"item/commandExecution/requestApproval",params:{
        threadId,turnId,itemId:consoleItem.id,command:consoleItem.command,cwd:process.cwd(),
      }});
      return;
    }
    if (prompt === "crash") { setImmediate(() => process.exit(23)); return; }
    if (prompt.startsWith("approve:")) {
      approvalId = "req-" + randomUUID();
      emit({id:approvalId,method:"item/commandExecution/requestApproval",params:{
        threadId,turnId,itemId:randomUUID(),command:prompt.slice(8),cwd:process.cwd(),
      }});
      return;
    }
    if (prompt === "wait") { delta("started!"); return; }
    if (prompt === "gateway") {
      const response = await fetch(base + "/responses", {method:"POST",headers:{"content-type":"application/json",
        authorization:"Bearer " + process.env.CODEXDECK_INTERNAL_TOKEN},body:JSON.stringify({model:alias,input:"test"})});
      if (!response.ok) { end("failed"); return; }
      const result = await response.json();
      delta(result.model);
    } else {
      delta("first ");
      await new Promise(resolve => setTimeout(resolve,60));
      await writeFile(join(process.cwd(),"result.txt"),"CodexDeck test artifact\n");
      delta("complete");
    }
    end(); return;
  }
  if (method === "turn/steer") {
    if (params.expectedTurnId !== turnId) { emit({id,error:{code:-32001,message:"turn mismatch"}}); return; }
    delta("guidance:" + params.input[0].text); reply({}); return;
  }
  if (method === "turn/interrupt") { reply({}); end("interrupted"); return; }
  if (id === approvalId) {
    notify("fixture/approval",{decision:msg.result?.decision});
    if (consoleItem && ["accept","acceptForSession"].includes(msg.result?.decision)) {
      await writeFile(join(process.cwd(),"result.txt"),"CodexDeck test artifact\n");
      await writeFile(join(process.cwd(),"report.docx"),"Fixture for artifact metadata");
      await writeFile(join(process.cwd(),"Dockerfile"),"FROM scratch\n");
      notify("item/completed",{turnId,item:{...consoleItem,status:"completed",exitCode:0,aggregatedOutput:"working tree clean"}});
      delta("已生成验收摘要。");
    }
    consoleItem = undefined;
    if (msg.result?.decision !== "cancel") end();
    return;
  }
  if (id !== undefined) emit({id,error:{code:-32601,message:"unknown method"}});
}
createInterface({input:process.stdin,crlfDelay:Infinity}).on("line",line => {
  void receive(JSON.parse(line)).catch(() => { process.exitCode = 2; end("failed"); });
});
