import { installationCode } from "../../server/dist/routes/auth.js";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer as httpServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import {harnessResponse,qualityJourney} from "./quality-harness.mjs";
import {performanceJourney} from "./performance.mjs";
import {securityCenterJourney} from "./security-center.mjs";
import {modelLedgerJourney} from "./model-ledger.mjs";
import { createServer, parseGatewayConfig } from "../../server/dist/app.js";
import { openDatabase } from "../../server/dist/db/index.js";
import { SecretMasker } from "../../server/dist/security/secret-masker.js";
import { chatExperienceJourney, mobileExperienceJourney } from "./chat-experience.mjs";

process.env.NODE_ENV = "production";
// The browser fixture starts an approved local static preview in its temporary workspace.
process.env.CODEXDECK_ALLOW_LOCAL_DEPLOYMENTS = "true";
const root = await mkdtemp(path.join(tmpdir(),"codexdeck-console-"));
const dataDirectory = path.join(root,"data");
const output = fileURLToPath(new URL("../test-results/",import.meta.url));
const codexBin = fileURLToPath(new URL("../../server/tests/fixtures/fake-app-server.mjs",import.meta.url));
const probePaths = new Set();
const mock = httpServer(async (req,res) => {
  probePaths.add(req.url);
  if(req.url === "/v1/models") return res.writeHead(200,{"Content-Type":"application/json"}).end(JSON.stringify({data:[{id:"fixture-model"},{id:"lab/library",context_length:200000}]}));
  if(req.url === "/balance") return res.writeHead(200,{"Content-Type":"application/json"}).end(JSON.stringify({data:{balance:24.5,currency:"USD"}}));
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  const native = req.url === "/v1/responses";
  const harness=harnessResponse(native?body.instructions:body.messages?.find(m=>m.role==="system")?.content);
  if(harness){
    const usage={input_tokens:17,output_tokens:12};
    const result=native?{id:"resp_harness",status:"completed",output:[{type:"message",content:[{type:"output_text",text:harness}]}],usage}:{choices:[{message:{content:harness}}],usage:{prompt_tokens:17,completion_tokens:12}};
    return res.writeHead(200,{"Content-Type":"application/json"}).end(JSON.stringify(result));
  }
  if (native && body.instructions?.includes("structured handoff")) {
    return res.writeHead(200,{"Content-Type":"application/json"}).end(JSON.stringify({
      id:"resp_compact",status:"completed",model:body.model,output:[{type:"message",content:[{type:"output_text",text:"已核对说明与测试，下一步复查部署。"}]}],
      usage:{input_tokens:540,output_tokens:18},
    }));
  }
  if(body.stream && body.model==="lab/library" && native) {
    const sample=body.max_output_tokens;
    res.writeHead(200,{"content-type":"text/event-stream"});
    const send=event=>res.write(`data: ${JSON.stringify(event)}\n\n`);
    send({type:"response.output_text.delta",delta:"1"});
    if(sample>1) {await new Promise(resolve=>setTimeout(resolve,45));send({type:"response.output_text.delta",delta:" 2 3"});}
    send({type:"response.completed",response:{usage:{input_tokens:8,output_tokens:sample>1?3:1,input_tokens_details:{cached_tokens:2}}}});
    return res.end();
  }
  if(body.stream) {
    const delta = native ? {type:"response.output_text.delta",delta:"OK"} : {choices:[{delta:{content:"OK"}}]};
    return res.writeHead(200,{"Content-Type":"text/event-stream"}).end("data: "+JSON.stringify(delta)+"\n\n");
  }
  const result = native ? {output:body.tools ? [{type:"function_call",name:"ping",arguments:"{}"}] : [{content:[{text:"red"}]}]} : {choices:[{message:{content:"red"}}]};
  res.writeHead(200,{"Content-Type":"application/json"}).end(JSON.stringify(result));
});

const failures = {pageErrors:[],consoleErrors:[],http5xx:[]};
const wsCursors = [];
function instrument(page){
  page.setDefaultTimeout(15000);
  page.on("pageerror",e=>failures.pageErrors.push(e.name+" "+e.message));
  page.on("console",msg=>{if(msg.type()==="error")failures.consoleErrors.push(msg.text().split("?")[0]);});
  page.on("response",res=>{if(res.status()>=500)failures.http5xx.push(res.status()+" "+new URL(res.url()).pathname);});
  page.on("websocket",ws=>{const url=new URL(ws.url());if(url.pathname==="/ws/events")wsCursors.push(Number(url.searchParams.get("last_seq_id")));});
}
const shot = (page,name) => page.screenshot({path:path.join(output,name+".png"),animations:"disabled"});
async function submit(page,prompt){
  const input = page.getByRole("textbox",{name:"任务指令"});
  await input.click(); await input.fill(prompt);
  await page.getByRole("button",{name:"发送消息",exact:true}).click();
}
async function approve(card){
  const first=card.getByRole("button",{name:/^批准本次/});
  await first.click();
  const second=card.getByRole("button",{name:/^确认批准本次/});
  if(await second.isVisible()) await second.click();
  await card.waitFor({state:"hidden"});
}
async function fits(page){
  const sizes=await page.evaluate(()=>[innerWidth,document.documentElement.clientWidth,document.documentElement.scrollWidth]);
  assert.deepEqual(sizes,[390,390,390],"mobile viewport overflow");
}
let app,db,browser,desktop,mobile,step;
try {
  await Promise.all([mkdir(dataDirectory),mkdir(output,{recursive:true})]);
  mock.listen(0,"127.0.0.1"); await once(mock,"listening");
  db=await openDatabase(dataDirectory,root);
  const masterKey=randomBytes(32);
  app=createServer({...db,masterKey,masker:new SecretMasker(),gatewayConfig:parseGatewayConfig()},
    {dataDirectory,workspaceRoot:root,codexBin,portPool:[20100,20199]});
  const origin=await app.listen({port:0,host:"127.0.0.1"});
  browser=await chromium.launch({headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:900},colorScheme:"light"});
  desktop=await context.newPage();instrument(desktop);
  step="桌面首次引导";
  assert.equal((await desktop.goto(origin)).status(),200);
  const adminInput=desktop.getByLabel("管理员密码",{exact:true});
  await adminInput.waitFor();await shot(desktop,"01-onboarding-desktop");
  const testPassword=randomBytes(24).toString("hex");
  await adminInput.fill(testPassword);
  await desktop.getByLabel("安装码").fill(installationCode(db.native,masterKey));
  await desktop.getByLabel("确认密码").fill(testPassword);
  await desktop.getByRole("button",{name:"创建管理员"}).click();
  await desktop.getByLabel("供应商预设").selectOption("custom");
  await desktop.getByLabel("接口地址").fill("http://127.0.0.1:"+mock.address().port+"/v1");
  await desktop.getByLabel("API Key").fill("sk-e2e-"+randomBytes(16).toString("hex"));
  await desktop.getByLabel("模型 ID").fill("fixture-model");
  await desktop.getByRole("button",{name:"一键测通"}).click();
  await desktop.getByText("连接成功",{exact:true}).waitFor();
  assert.deepEqual([...probePaths].sort(),["/v1/chat/completions","/v1/models","/v1/responses"]);
  await desktop.getByRole("button",{name:"下一步"}).click();
  await desktop.getByLabel("工作区名称").fill("console-lab");
  await desktop.getByRole("button",{name:"进入工作台"}).click();
  await desktop.getByRole("button",{name:"关闭抽屉"}).click();

  step="流式任务、内嵌审批与文件预览";
  await submit(desktop,"检查工作区并生成验收摘要");
  await desktop.getByText("正在检查工作区。",{exact:true}).waitFor();
  const card=desktop.locator(".cd-pending-stack").getByTestId("approval-card");
  await card.waitFor();
  await desktop.waitForFunction(()=>document.querySelector('link[rel="icon"]')?.dataset.state==="approval");
  await shot(desktop,"02-approval-desktop");
  await approve(card);
  const answer="正在检查工作区。已生成验收摘要。";
  await desktop.getByText(answer,{exact:true}).waitFor();
  const toggle=desktop.getByRole("button",{name:/运行完成.*1 个工具/});
  assert.equal(await toggle.getAttribute("aria-expanded"),"false");await toggle.click();
  await desktop.getByText("执行命令 · 1 次操作").click();
  await desktop.locator(".cd-step-block pre").filter({hasText:"working tree clean"}).waitFor();
  await toggle.click();
  const files=desktop.locator(".cd-artifacts");
  await files.getByRole("button",{name:/^report\.docx/}).waitFor();
  assert.equal(await files.locator('[data-kind="word"]').count(),1);
  assert.equal(await files.getByText("Dockerfile",{exact:true}).count(),0);
  const changed=desktop.locator(".cd-turn-changes").last();
  await changed.locator("summary").click();
  await changed.getByText("Dockerfile",{exact:true}).waitFor();
  await changed.locator("summary").click();
  await desktop.waitForFunction(()=>document.querySelector('link[rel="icon"]')?.dataset.state==="idle");
  const fileMode=desktop.getByRole("radiogroup",{name:"底部文件栏"});
  await fileMode.getByRole("radio",{name:"关闭文件栏"}).click();
  await files.waitFor({state:"hidden"});
  await fileMode.getByRole("radio",{name:"全部文件"}).click();
  await files.getByText("Dockerfile",{exact:true}).waitFor();
  await desktop.getByRole("button",{name:/^result\.txt/}).click();
  await desktop.locator(".deck-drawer").getByText(/git status · 工作树干净/).waitFor();
  await changed.locator("summary").click();
  await changed.getByText("Dockerfile",{exact:true}).waitFor();
  await shot(desktop,"03-workbench-desktop");

  step="刷新续传与单端口路由";
  await desktop.reload();await desktop.getByText(answer,{exact:true}).waitFor();
  assert.equal(await desktop.getByText(answer,{exact:true}).count(),1);
  await desktop.getByText("实时连接",{exact:true}).waitFor();
  assert.ok(wsCursors.some(id=>id>0),"refresh must resume with the previous cursor");
  for(const prefix of ["api","ws","internal","preview"]){
    const r=await context.request.get(origin+"/"+prefix+"/nonexistent");
    assert.ok(r.status()>=400&&r.status()<500);assert.doesNotMatch(r.headers()["content-type"]??"",/text\/html/);
  }
  step="V1.1 双主题、文档流与上下文";
  await chatExperienceJourney(desktop,submit,shot);

  step="移动端审批、输入与预发布";
  const handheld=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,
    deviceScaleFactor:1,colorScheme:"dark",storageState:await context.storageState()});
  mobile=await handheld.newPage();instrument(mobile);
  await mobile.goto(origin);await mobile.getByText(answer,{exact:true}).waitFor();
  await fits(mobile);
  await submit(mobile,"启动预发布验收站点");
  const mobileCard=mobile.locator(".mobile-overview").getByTestId("approval-card");
  await mobileCard.waitFor();await fits(mobile);await shot(mobile,"04-approval-mobile");
  await approve(mobileCard);
  await mobile.getByText("预发布服务已就绪。",{exact:true}).waitFor();
  await mobile.getByRole("textbox",{name:"任务指令"}).click();await fits(mobile);
  await mobile.locator(".deck-bottom").getByRole("button",{name:"服务"}).click();
  await mobile.getByRole("button",{name:"预览",exact:true}).waitFor();

  step="服务卡片墙、预览与二级路由";
  await desktop.locator(".desk-nav").getByRole("button",{name:"已部署服务"}).click();
  assert.equal(new URL(desktop.url()).pathname,"/console/services");
  assert.equal((await desktop.reload()).status(),200);
  const preview=desktop.getByRole("button",{name:"预览",exact:true});
  await preview.waitFor();await shot(desktop,"05-services-desktop");
  await preview.click();
  await desktop.frameLocator("iframe").getByText("CodexDeck preview ready",{exact:true}).waitFor();
  step="多 Key、模型排行与账本";
  await modelLedgerJourney(desktop,origin,shot);
  step="移动端主题、协议抽屉、IME、压缩、测速和账本";
  await mobileExperienceJourney(mobile,shot,fits);
  for(const viewport of [{width:1440,height:900},{width:390,height:844}]){
    step="V1.4 计划、批注、复审、交接与保险箱 "+viewport.width;
    await qualityJourney({browser,context,origin,instrument,submit,shot,viewport});
  }
  step="V1.3 缓存、上滑分页、输入帧与乐观发送";
  await performanceJourney(browser,context,origin,db.native,instrument);
  step="V1.2 设置、管理员与访客双会话";
  await securityCenterJourney(desktop,browser,shot,instrument,testPassword);
  assert.deepEqual(failures,{pageErrors:[],consoleErrors:[],http5xx:[]});
  console.log("PASS desktop 1440x900, mobile 390x844, single-port SPA / API / WS / preview and replay");
  console.log("Page errors 0 | Console errors 0 | Unexpected HTTP 5xx 0");
} catch(error) {
  console.error("E2E failed during "+step,failures);
  throw error;
} finally {
  await browser?.close();await app?.close();db?.native.close();
  mock.closeAllConnections();if(mock.listening)await new Promise(resolve=>mock.close(resolve));
  await rm(root,{recursive:true,force:true,maxRetries:3});
}
