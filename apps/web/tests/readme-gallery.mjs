import assert from "node:assert/strict";
import {randomBytes,randomUUID} from "node:crypto";
import {mkdir,mkdtemp,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {chromium} from "playwright-core";
import {utils,write} from "xlsx";
import {createServer,parseGatewayConfig} from "../../server/dist/app.js";
import {openDatabase} from "../../server/dist/db/index.js";
import {WorkspaceFiles} from "../../server/dist/files/workspace-files.js";
import {installationCode} from "../../server/dist/routes/auth.js";
import {SecretMasker} from "../../server/dist/security/secret-masker.js";

process.env.NODE_ENV="production";
const root=await mkdtemp(path.join(tmpdir(),"deck-readme-"));
const data=path.join(root,"data");
const output=fileURLToPath(new URL("../test-results/",import.meta.url));
const errors=[];
let db,server,browser;
async function capture(page,name){
  await page.evaluate(()=>document.fonts.ready);
  await page.screenshot({path:path.join(output,name+".png"),animations:"disabled",caret:"hide"});
}
function observe(page){
  page.on("pageerror",error=>errors.push(error.message));
  page.on("console",message=>{if(message.type()==="error")errors.push(message.text());});
}
try {
  await Promise.all([mkdir(data),mkdir(output,{recursive:true})]);
  db=await openDatabase(data,root);
  const ctx={...db,masterKey:randomBytes(32),masker:new SecretMasker(),gatewayConfig:parseGatewayConfig()};
  server=createServer(ctx,{dataDirectory:data,workspaceRoot:root});
  const origin=await server.listen({host:"127.0.0.1",port:0});
  browser=await chromium.launch();
  const control=await browser.newContext({viewport:{width:1440,height:900},locale:"zh-CN",colorScheme:"light"});
  const r=await control.request.post(origin+"/api/auth/setup",{data:{password:randomBytes(24).toString("hex"),setup_code:installationCode(db.native,ctx.masterKey)}});
  assert.equal(r.status(),200);
  db.native.prepare("INSERT OR REPLACE INTO settings(key,value,updated_at) VALUES('onboarding_completed','1',?)").run(new Date().toISOString());
  const files=new WorkspaceFiles(ctx,data,()=>{});
  const workspace=await files.create("版本发布工作室","conservative");
  const threads=[];
  for(const [title,prompt,answer] of [
    ["版本验收与发布","整理版本验收清单，记录各模块的测试结果。","验收清单已更新。文档预览、搜索与分享均已完成回归。"],
    ["设计评审与交付","汇总设计评审成果，准备公开交付件。","交付目录包含发布简报、界面配色和阅读流程图。"],
    ["运行手册","整理交付手册，补充分享的验收标准。","已记录匿名阅读、下载权限与分享吊销的验收步骤。"],
  ]){
    const id=randomUUID(),time=new Date().toISOString(),turn=randomUUID();
    db.native.prepare("INSERT INTO threads(id,workspace_id,title,status,created_at,updated_at) VALUES(?,?,?,'ready',?,?)").run(id,workspace.id,title,time,time);
    db.native.prepare("INSERT INTO tasks(id,thread_id,workspace_id,prompt,status,answer_markdown,created_at,updated_at) VALUES(?,?,?,?,'completed',?,?,?)")
      .run(turn,id,workspace.id,prompt,answer,time,time);
    threads.push({id,turn});
  }
  const workbook=utils.book_new();
  utils.book_append_sheet(workbook,utils.aoa_to_sheet([
    ["功能模块","验收内容","平台","结果"],["成品资产箱","分类与批量下载","桌面","通过"],
    ["文档预览","多工作表切换","桌面","通过"],["全局检索","定位历史轮次","桌面 / 手机","通过"],
    ["公开分享","阅读与吊销","手机","通过"],["PWA","静态壳缓存","桌面 / 手机","通过"],
  ]),"发布验收");
  utils.book_append_sheet(workbook,utils.aoa_to_sheet([["平台","视口"],["桌面","1440 × 900"],["手机","390 × 844"]]),"浏览器矩阵");
  const notes=["# 交付范围","","本期演示项目整理了从生成成品、审核内容到公开阅读的完整流程。","",
    "## 发布验收","","| 检查项 | 验收结果 |","| --- | --- |","| 多格式直览 | 已通过 |","| 中文检索定位 | 已通过 |",
    "| 分享次数控制 | 已通过 |","","## 交付文件","","- 跨端验收清单（XLSX）","- 阅读流程图（Mermaid）","- 设计色板（SVG）"].join("\n");
  const items=[
    ["阅读流程图.mmd","flowchart LR\nA[生成] --> B[审核]\nB --> C[分享]",1],
    ["浏览器测试矩阵.csv","系统,浏览器,场景\nLinux,Chromium,桌面\niOS,Safari,主屏幕引导",0],
    ["设计色板.svg",'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 80"><rect width="80" height="80" fill="#176756"/><rect x="80" width="80" height="80" fill="#D29A48"/><rect x="160" width="80" height="80" fill="#586C83"/></svg>',1],
    ["运行手册.md","# 运行手册\n\n每次发布前核对交付目录和工作表。",2],
    ["产品介绍.html",'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>产品介绍</title><h1>版本发布工作室</h1><p>集中核查交付件和验收结果。</p></html>',1],
    ["发布简报.md",notes,1],["跨端验收清单.xlsx",write(workbook,{bookType:"xlsx",type:"buffer"}),0],
  ];
  const artifacts={};
  for(const [name,contents,thread] of items){
    await writeFile(path.join(workspace.path,name),contents);
    artifacts[name]=await files.registerArtifact(workspace.id,threads[thread].id,threads[thread].turn,name,"added");
  }
  const page=await control.newPage();observe(page);
  await page.goto(origin+"/console/artifacts");
  await page.getByRole("button",{name:"来源会话"}).first().waitFor();
  assert.equal(await page.locator(".hub-file").count(),items.length);
  await page.getByLabel("选择 跨端验收清单.xlsx").check();
  await page.getByLabel("选择 发布简报.md").check();
  await capture(page,"artifact-hub");
  await page.getByRole("button",{name:"清空",exact:true}).click();
  await page.locator("button.hub-file").filter({hasText:"跨端验收清单.xlsx"}).click();
  await page.getByRole("cell",{name:"定位历史轮次"}).waitFor();
  await capture(page,"document-viewer");
  await page.getByLabel("关闭抽屉").click();
  await page.getByLabel("切换主题").click();
  await page.waitForFunction(()=>document.documentElement.dataset.theme==="dark");
  await page.keyboard.press("Control+k");
  await page.getByRole("textbox",{name:"搜索命令"}).fill("验收");
  await page.getByRole("heading",{name:"对话消息"}).waitFor();
  await page.getByRole("heading",{name:"成品文件"}).waitFor();
  await capture(page,"global-search");
  const share=await control.request.post(origin+"/api/shares",{data:{artifact_id:artifacts["发布简报.md"].id,title:"版本发布简报"}});
  assert.equal(share.status(),201);
  const guest=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,locale:"zh-CN",colorScheme:"light"});
  const reader=await guest.newPage();observe(reader);
  await reader.goto(origin+(await share.json()).url);
  await reader.getByRole("heading",{name:"发布验收"}).waitFor();
  await capture(reader,"public-share");
  assert.deepEqual(errors,[]);
  console.log("Captured the artifact hub, spreadsheet drawer, global search and mobile public share from synthetic local documents.");
} finally {
  await browser?.close();
  await server?.close();
  db?.native.close();
  await rm(root,{recursive:true,force:true,maxRetries:3});
}
