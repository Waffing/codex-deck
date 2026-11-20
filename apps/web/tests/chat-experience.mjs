import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Read rendered colours from the page so the numeric check covers the real styles in both palettes.
async function verifyContrast(page) {
  const ratios=await page.locator(".md-document").last().evaluate(node=>{
    const luminance=css=>{
      const linear=css.match(/[\d.]+/g).slice(0,3).map(n=>Number(n)/255).map(n=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4);
      return .2126*linear[0]+.7152*linear[1]+.0722*linear[2];
    };
    const bg=luminance(getComputedStyle(document.body).backgroundColor);
    return [...node.querySelectorAll("strong,.md-success,.md-metric,.md-danger")].map(el=>{
      const fg=luminance(getComputedStyle(el).color);
      return (Math.max(bg,fg)+.05)/(Math.min(bg,fg)+.05);
    });
  });
  assert.ok(ratios.length>=4 && ratios.every(v=>v>=4.5),`semantic text contrast ${ratios.join(", ")}`);
}
export async function chatExperienceJourney(page,submit,shot) {
  await submit(page,"核验工作台 V1.1");
  const turn=page.locator("[data-turn]").filter({has:page.getByRole("heading",{name:"核验结果"})});
  await turn.locator("strong").filter({hasText:"全部通过"}).waitFor();
  assert.doesNotMatch(await turn.locator(".md-document").innerText(),/\*\*/);
  await turn.locator("pre code .hljs-keyword").filter({hasText:"const"}).waitFor();
  await turn.getByRole("button",{name:/运行完成.*2 个工具/}).click();
  await turn.getByText("先核对文件说明，再比对测试输出。").waitFor();
  await turn.getByText("读取文件 · 2 次操作").click();
  await turn.locator("pre").filter({hasText:"cat README.md"}).waitFor();
  assert.doesNotMatch(await page.locator(".cd-chat-pane").innerText(),/thread\/status\/changed|turn\/started/);
  await page.getByText("已完成 2 个任务 (共 2 个)").click();
  await page.locator(".cd-plan-capsule").getByText("核对说明",{exact:true}).waitFor();
  await page.getByText("已完成 2 个任务 (共 2 个)").click();
  await verifyContrast(page);
  await page.getByLabel("切换主题").click();
  await page.waitForFunction(()=>document.documentElement.dataset.theme==="dark");
  await verifyContrast(page);
  await page.locator(".cd-chat-scroll").evaluate(el=>{el.scrollTop=el.scrollHeight;});
  await shot(page,"06-chat-dark");
  await page.reload();
  await turn.getByRole("heading",{name:"核验结果"}).waitFor();
  assert.equal(await page.locator("html").getAttribute("data-theme"),"dark");
  const markers=page.getByRole("navigation",{name:"对话进度标尺"}).getByRole("button");
  await markers.first().click();
  await page.waitForFunction(()=>document.querySelector(".cd-minimap button")?.getAttribute("aria-current")==="step");
  await markers.last().click();
  const box=page.getByRole("textbox",{name:"任务指令"});
  await box.fill("/rev");
  await page.getByRole("option",{name:"/review",exact:true}).waitFor();
  await box.press("Enter");
  assert.match(await box.inputValue(),/审查当前工作区改动/);
  await box.fill("@res");
  await page.getByRole("option",{name:"result.txt",exact:true}).waitFor();
  await box.press("Enter");
  await page.locator(".cd-chips button").getByText("result.txt",{exact:true}).waitFor();
  await page.locator(".cd-chips button").click();
  await page.getByRole("button",{name:"上下文占用",exact:true}).hover();
  await page.locator(".cd-context aside").getByText(/113,000/).waitFor();
  await page.getByRole("button",{name:"一键压缩上下文"}).click();
  await page.locator(".cd-context-notice").getByText(/上下文已压缩/).waitFor();
  await turn.getByRole("button",{name:/运行完成.*2 个工具/}).click();
  await turn.getByText(/上下文已压缩 · /).first().waitFor();
  for(const [label,ext] of [["导出 .md","md"],["导出 PNG","png"]]){
    const [download]=await Promise.all([page.waitForEvent("download"),turn.getByRole("button",{name:label,exact:true}).click()]);
    assert.ok(download.suggestedFilename().endsWith("."+ext));
    const bytes=await readFile(await download.path());
    if(ext==="md")assert.match(bytes.toString(),/\*\*全部通过\*\*/);
    else {assert.equal(bytes.subarray(1,4).toString(),"PNG");assert.ok(bytes.readUInt32BE(16)>=800 && bytes.readUInt32BE(20)>100);}
  }
  await page.locator(".desk-nav").getByRole("button",{name:/系统|设置/}).click();
  await page.getByLabel("外观主题").selectOption("system");
  await page.emulateMedia({colorScheme:"light"});
  await page.waitForFunction(()=>document.documentElement.dataset.theme==="light");
  await page.getByLabel("开发者原始 JSON 调试").check();
  await page.locator(".desk-nav").getByRole("button",{name:"工作台"}).click();
  await page.getByRole("button",{name:/原始协议调试/}).click();
  const debug=page.getByRole("dialog",{name:"原始协议调试"});
  await debug.locator("pre").filter({hasText:"thread/status/changed"}).first().waitFor();
  await debug.getByRole("button",{name:"关闭原始协议"}).click();
  await page.locator(".desk-nav").getByRole("button",{name:/系统|设置/}).click();
  await page.getByLabel("开发者原始 JSON 调试").uncheck();
  await page.locator(".desk-nav").getByRole("button",{name:"工作台"}).click();
  await turn.getByRole("heading",{name:"核验结果"}).waitFor();
  await shot(page,"07-chat-light");
}

export async function mobileExperienceJourney(page, shot, fits) {
  const nav=page.locator(".deck-bottom");
  const openMobileView=async name=>{
    await nav.getByRole("button",{name:"更多"}).tap();
    await page.getByRole("main").getByRole("button",{name}).tap();
  };
  await nav.getByRole("button",{name:"工作台"}).tap();
  const turn=page.locator("[data-turn]").filter({has:page.getByRole("heading",{name:"核验结果"})});
  await turn.locator(".md-document strong").filter({hasText:"全部通过"}).waitFor();
  await page.getByRole("button",{name:"切换主题"}).tap();
  await page.waitForFunction(()=>document.documentElement.dataset.theme==="light");
  await page.getByRole("button",{name:"切换主题"}).tap();
  await page.waitForFunction(()=>document.documentElement.dataset.theme==="dark");
  await turn.getByRole("heading",{name:"核验结果"}).scrollIntoViewIfNeeded();
  assert.doesNotMatch(await page.locator(".cd-chat-pane").innerText(),/thread\/status\/changed|turn\/started/);
  await fits(page);
  await shot(page,"08-workbench-mobile");

  const box=page.getByRole("textbox",{name:"任务指令"});
  const posted=[];
  const track=req=>{if(req.method()==="POST" && /\/(inject|messages)$/.test(req.url()))posted.push(req.url());};
  page.on("request",track);
  const composeEnter=()=>box.evaluate(el=>{
    el.dispatchEvent(new CompositionEvent("compositionstart",{bubbles:true,data:""}));
    const key=new KeyboardEvent("keydown",{bubbles:true,cancelable:true,code:"Enter",key:"Enter",isComposing:true,keyCode:229});
    const accepted=el.dispatchEvent(key);
    el.dispatchEvent(new CompositionEvent("compositionend",{bubbles:true,data:"核"}));
    return accepted;
  });
  try {
    await box.fill("核对中文输入");
    assert.equal(await composeEnter(),true);
    assert.equal(await box.inputValue(),"核对中文输入");
    await box.fill("/审");
    const playbook=page.getByRole("option",{name:"/审查改动"});
    await playbook.waitFor();
    assert.equal(await composeEnter(),true);
    assert.equal(await box.inputValue(),"/审");
    await playbook.tap();
    assert.match(await box.inputValue(),/检查当前 Git 改动/);
    await box.fill("@res");
    await page.getByRole("option",{name:"result.txt",exact:true}).tap();
    await page.locator(".cd-chips button").getByText("result.txt",{exact:true}).waitFor();
    await page.locator(".cd-chips button").tap();
    assert.deepEqual(posted,[]);
  } finally {page.off("request",track);}
  await page.getByRole("button",{name:"上下文占用",exact:true}).tap();
  await page.getByRole("button",{name:"一键压缩上下文"}).tap();
  await page.locator(".cd-context-notice").getByText(/上下文已压缩/).waitFor();
  await fits(page);
  await openMobileView("系统与通知");
  await page.getByLabel("开发者原始 JSON 调试").check();
  await nav.getByRole("button",{name:"工作台"}).tap();
  await page.getByRole("button",{name:/原始协议调试/}).tap();
  const debug=page.getByRole("dialog",{name:"原始协议调试"});
  await debug.locator("pre").filter({hasText:"thread/status/changed"}).first().waitFor();
  await debug.getByRole("button",{name:"关闭原始协议"}).tap();
  await openMobileView("系统与通知");
  await page.getByLabel("开发者原始 JSON 调试").uncheck();

  await openMobileView("第三方 API 与模型");
  const card=page.locator("article.ad-card").first();
  await card.getByLabel("已保存密钥").locator(".ad-pill").nth(1).waitFor();
  assert.equal(await card.getByLabel("已保存密钥").locator(".ad-pill").count(),2);
  await card.getByRole("button",{name:"从上游获取模型"}).tap();
  const library=page.getByRole("dialog",{name:"从上游获取模型"});
  await library.getByLabel("搜索模型").fill("library");
  await library.getByText("lab/library",{exact:false}).first().waitFor();
  await fits(page);
  await library.getByRole("button",{name:"关闭"}).tap();
  const board=page.locator(".benchmark-board");
  await board.getByRole("checkbox",{name:/选择测速 .*library/}).check();
  const measured=page.waitForResponse(r=>r.url().endsWith("/api/models/benchmark") && r.status()===200);
  await board.getByRole("button",{name:"测速选中模型"}).tap();
  await measured;
  await board.getByRole("row").filter({hasText:"library"}).getByText("样本不足",{exact:true}).waitFor();
  await fits(page);
  await openMobileView("Open API 与用量");
  const ledger=page.getByRole("region",{name:"用量账本"});
  await ledger.getByRole("button",{name:"按月"}).tap();
  await ledger.getByLabel("账本分组").selectOption("model");
  await ledger.getByRole("cell",{name:/library/}).waitFor();
  await fits(page);
}
