import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {randomBytes} from "node:crypto";
import {writeFile} from "node:fs/promises";
import path from "node:path";

export function harnessResponse(instructions){
  if(instructions?.startsWith("Review the supplied Git patch"))return JSON.stringify({
    summary:"检查两处配置变更。",findings:[{id:"fixture-finding",severity:"warning",category:"maintainability",file:"alpha.txt",line:1,title:"记录变更目的",detail:"更新前请说明取值来源。",fix_hint:"添加说明。"}]
  });
  if(instructions?.includes("Format the architecture handoff in Markdown"))return "## 架构目标\n维护工作区配置。\n\n## 待办\n复查改动。";
}
export async function qualityJourney({browser,context,origin,instrument,submit,shot,viewport}){
  const session=await browser.newContext({storageState:await context.storageState(),viewport,isMobile:viewport.width<768,hasTouch:viewport.width<768});
  const page=await session.newPage();instrument(page);
  const request=session.request;
  async function post(route,data){
    const response=await request.post(origin+route,{data});assert.ok(response.ok(),route+" HTTP "+response.status());return response.json();
  }
  async function checkFeedback(click){
    const sent=page.waitForResponse(r=>r.url().endsWith("/review-feedback")&&r.request().method()==="POST");
    await click();const response=await sent;
    assert.ok(response.ok(),"feedback HTTP "+response.status());
    await page.waitForFunction(async id=>{
      const res=await fetch("/api/threads/"+id+"/turns");const state=await res.json();return !state.active_turn&&state.turns.at(-1)?.status==="completed";
    },thread.id);
    return response.request().postDataJSON();
  }
  const workspace=await post("/api/workspaces",{name:"quality-"+viewport.width,automation_level:"semi"});
  const models=await (await request.get(origin+"/api/models")).json();
  const thread=await post("/api/threads",{workspace_id:workspace.id,title:"质量回归",model_alias:models[0].alias});
  try{
    const git=(...args)=>execFileSync("git",args,{cwd:workspace.path,stdio:"pipe",windowsHide:true});
    git("init","-q");git("config","user.name","Fixture");git("config","user.email","fixture@example.test");
    for(const file of ["alpha.txt","beta.txt"])await writeFile(path.join(workspace.path,file),"previous\n");
    await writeFile(path.join(workspace.path,"package.json"),JSON.stringify({scripts:{test:"node --test"}}));
    git("add","--","alpha.txt","beta.txt","package.json");git("commit","-qm","Fixture baseline");
    await page.goto(origin);
    await page.evaluate(({workspace,thread})=>{localStorage.setItem("deck.workspace",workspace);localStorage.setItem("deck.thread",thread);},{workspace:workspace.id,thread:thread.id});
    await page.reload();
    await page.locator(".workspace-switch").getByText(workspace.name).waitFor();
    await page.locator(".workspace-switch").click();
    await page.getByRole("button",{name:"工作区配置",exact:true}).click();
    const drawer=page.getByRole("complementary",{name:"检查器"});
    await drawer.getByRole("button",{name:"自动识别命令"}).click();
    await drawer.getByText("已识别命令，请检查后保存。",{exact:true}).waitFor();
    const reviewer=models.find(m=>m.alias!==thread.active_model_alias).alias;
    await drawer.getByLabel("默认复审模型").selectOption(reviewer);
    await drawer.getByRole("button",{name:"保存质检设置"}).click();
    await drawer.getByText("质检设置已保存",{exact:true}).waitFor();
    await drawer.getByRole("button",{name:"环境变量保险箱"}).click();
    const value="e2e-"+randomBytes(16).toString("hex");
    await drawer.getByRole("button",{name:"导入 .env"}).click();
    await drawer.getByLabel(".env 内容").fill("QUALITY_CHECK="+value+"\nWORKSPACE_LABEL=fixture-vault-"+viewport.width);
    await drawer.getByRole("switch",{name:"质检注入"}).click();
    await drawer.getByRole("button",{name:"导入密钥"}).click();
    await drawer.getByText("已导入 2 项密钥",{exact:true}).waitFor();
    await drawer.getByText("QUALITY_CHECK",{exact:true}).waitFor();
    assert.equal(await page.getByLabel(".env 内容").count(),0);
    assert.equal((await page.content()).includes(value),false);
    await drawer.getByRole("button",{name:"编辑 QUALITY_CHECK"}).click();
    assert.equal(await drawer.getByLabel("替换密钥值（留空保留）").inputValue(),"");
    await drawer.getByRole("button",{name:"取消",exact:true}).click();
    await shot(page,"14-vault-"+viewport.width);
    await drawer.getByRole("button",{name:"关闭抽屉"}).click();

    const plan=page.getByRole("button",{name:"Plan 模式"});
    await plan.click();await page.waitForFunction(()=>document.querySelector(".plan-switch")?.getAttribute("aria-pressed")==="true");
    await submit(page,"规划 alpha 和 beta 配置调整");
    const card=page.getByRole("article",{name:"计划确认"});
    await card.getByRole("button",{name:"提修改意见重拟"}).click();
    await card.getByLabel("计划修改意见").fill("补充回归测试步骤");
    await card.getByRole("button",{name:"提交修改意见"}).click();
    await page.waitForFunction(()=>document.querySelectorAll("article[data-turn]").length>=2);
    await card.getByRole("button",{name:"批准并开始编码"}).click();
    await page.getByText("first complete",{exact:true}).waitFor();
    await card.waitFor({state:"hidden"});

    for(const file of ["alpha.txt","beta.txt"])await writeFile(path.join(workspace.path,file),"updated\n");
    await page.getByRole("button",{name:"Git Diff",exact:true}).click();
    for(const [file,side] of [["alpha.txt","new"],["beta.txt","old"]]){
      await drawer.getByRole("button",{name:"批注 "+file+":1 "+side}).click();
      await drawer.getByLabel("行级批注").fill("核对 "+file);
      await drawer.getByRole("button",{name:"保存批注"}).click();
    }
    await drawer.getByText("已标注 2 处批注",{exact:true}).waitFor();
    const payload=await checkFeedback(()=>drawer.getByRole("button",{name:"汇总发给 Codex 修改"}).click());
    assert.deepEqual(payload.annotations.map(a=>[a.file,a.line,a.side]),[["alpha.txt",1,"new"],["beta.txt",1,"old"]]);
    await drawer.getByLabel("复审模型").selectOption(reviewer);
    await drawer.getByRole("button",{name:"AI 跨模型复审"}).click();
    const finding=drawer.getByRole("checkbox",{name:/记录变更目的/});
    await finding.check();
    await drawer.getByRole("button",{name:"alpha.txt:1",exact:true}).click();
    await shot(page,"14-review-"+viewport.width);
    const findings=await checkFeedback(()=>drawer.getByRole("button",{name:"将选中问题发回 Codex 修复"}).click());
    assert.equal(findings.finding_ids.length,1);
    await drawer.getByRole("button",{name:"关闭抽屉"}).click();
    if(viewport.width<768)await page.getByRole("button",{name:"上下文占用"}).click();
    else await page.getByRole("button",{name:"会话操作"}).click();
    const created=page.waitForResponse(r=>r.url().endsWith("/handoff")&&r.status()===201);
    await page.getByRole("button",{name:"生成交接单并开新会话",exact:true}).click();
    const child=await (await created).json();
    await page.getByText("架构交接单",{exact:true}).click();
    await page.getByRole("heading",{name:"架构目标"}).waitFor();
    assert.equal(await page.evaluate(()=>localStorage.getItem("deck.thread")),child.thread_id);
    assert.equal(await page.locator("article[data-turn]").count(),0);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),viewport.width);
    await page.getByRole("button",{name:"打开来源会话"}).click();
    await page.waitForFunction(id=>localStorage.getItem("deck.thread")===id,thread.id);
  }finally{await session.close();}
}
