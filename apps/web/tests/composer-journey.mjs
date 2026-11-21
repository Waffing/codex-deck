import assert from "node:assert/strict";

export async function assertMobileComposerRow(page,running) {
  const controls=page.locator(".cd-compose-controls");
  const names=["上下文占用","模型与策略",...(running?["中止","中途插话"]:["发送消息"])];
  let previous;
  for(const name of names) {
    const button=controls.getByRole("button",{name,exact:true});
    const bounds=await button.evaluate(el=>{
      const {left,right,top,bottom,width,height}=el.getBoundingClientRect();
      const y=top+height/2;
      return {left,right,y,visible:left>=0 && right<=innerWidth && top>=0 && bottom<=innerHeight,
        target:el.contains(document.elementFromPoint(left+width/2,y))};
    });
    assert.ok(bounds.visible && bounds.target,`${name} must be visible and reachable`);
    if(previous) {
      assert.ok(Math.abs(bounds.y-previous.y)<=2,`${name} wrapped away from the other actions`);
      assert.ok(bounds.left>=previous.right-1,`${name} overlaps the preceding action`);
    }
    previous=bounds;
  }
}

// Starts and ends on an authenticated workbench with an idle project.
export async function composerJourney(page) {
  const box=page.getByRole("textbox",{name:"任务指令"});
  const trigger=page.getByRole("button",{name:/^工作区权限：/});
  await trigger.click();
  const sheet=page.getByRole("dialog",{name:"应如何批准 Codex 操作？"});
  assert.equal(await sheet.getByRole("radio").count(),3);
  await sheet.getByRole("button",{name:"了解更多"}).click();
  await sheet.getByText(/Plan 模式使用只读环境/).waitFor();
  const mobile=await page.evaluate(()=>matchMedia("(max-width:767px)").matches);
  if(mobile){
    const position=await sheet.boundingBox();
    assert.ok(position && position.y+position.height>=page.viewportSize().height-2);
  }
  await sheet.getByRole("radio",{name:/完全访问权限/}).click();
  const confirm=sheet.getByRole("button",{name:"确认启用"});
  if(await confirm.isVisible()){
    const updated=page.waitForResponse(r=>r.request().method()==="PATCH" && /\/api\/workspaces\/[^/]+$/.test(r.url()));
    await confirm.click();assert.equal((await updated).status(),200);
  }
  await page.getByRole("button",{name:"工作区权限：完全访问权限"}).waitFor();
  if(mobile)await assertMobileComposerRow(page,false);
  const profile=await (await page.request.get(new URL("/api/settings/executor",page.url()).href)).json();
  if(profile.available){
    await box.fill("验证当前执行工作区");await page.getByRole("button",{name:"发送消息",exact:true}).click();
    const task=page.locator("[data-turn]").filter({hasText:"验证当前执行工作区"}).last();
    await task.getByRole("button",{name:/运行完成/}).waitFor({timeout:90000});
  }
  await trigger.click();await sheet.getByRole("radio",{name:/帮我批准/}).click();
  await page.getByRole("button",{name:"工作区权限：帮我批准"}).waitFor();
  await box.fill("/");const choices=page.getByRole("listbox",{name:"快捷命令"});
  await choices.getByRole("option",{name:"/mcp",exact:true}).getByText(/\d+ 在线/).waitFor();
  await choices.getByRole("option",{name:"/compact",exact:true}).getByText(/已使用 \d+%|占用未知/).waitFor();
  assert.equal(await choices.getByRole("option",{name:"/delete",exact:true}).locator("svg").count(),1);
  await box.press("ArrowDown");
  assert.equal(await choices.getByRole("option",{name:"/review",exact:true}).getAttribute("aria-selected"),"true");
  await box.press("Escape");await choices.waitFor({state:"hidden"});await box.fill("");
  const hint=page.locator(".cd-compose-hint");
  const rect=await hint.boundingBox();assert.ok(rect && rect.y+rect.height<=page.viewportSize().height+1);
  return profile.available;
}
