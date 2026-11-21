import assert from "node:assert/strict";
import {composerJourney} from "./composer-journey.mjs";
import {gatewayJourney} from "./gateway-center.mjs";

export async function flagshipJourney(page,origin,shot){
  const mobile=page.viewportSize().width<768;
  async function nav(label){
    if(mobile){await page.locator(".deck-bottom").getByRole("button",{name:"更多",exact:true}).click();await page.locator(".standalone-page").getByRole("button",{name:label,exact:true}).click();}
    else await page.locator(".desk-nav").getByRole("button",{name:label,exact:true}).click();
  }
  async function home(){await page.locator(mobile?".deck-bottom":".desk-nav").getByRole("button",{name:"工作台",exact:true}).click();}
  await page.goto(origin);await page.getByLabel("任务指令").waitFor();
  if (!mobile) {
    const nav = page.getByRole("navigation", {name:"模块导航"});
    const rows = await nav.locator("button").evaluateAll(buttons => buttons.map(button => {
      const label = button.querySelector("span");
      const text = label.getBoundingClientRect();
      const icon = button.querySelector("svg").getBoundingClientRect();
      return {name:label.textContent, x:icon.left, inset:icon.left-button.getBoundingClientRect().left,
        labelX:text.left, gap:text.left-icon.right, fullLabel:label.clientWidth >= label.scrollWidth && text.width > 1};
    }));
    assert.deepEqual(rows.map(row=>row.name), ["工作台","API 指挥中心","MCP","Skills","插件","提示词","会话","授权中心","用量统计","应用","设置"]);
    for (const row of rows) {
      assert.ok(row.fullLabel && row.inset <= 12 && row.gap >= 6 && row.gap <= 12, row.name);
      if (row.name !== "设置") {
        assert.equal(row.x, rows[0].x, row.name);
        assert.equal(row.labelX, rows[0].labelX, row.name);
      }
    }
    await page.getByRole("button",{name:"折叠导航栏"}).click();
    const mcp = nav.getByRole("button",{name:"MCP",exact:true});
    await mcp.locator("span").waitFor({state:"hidden"});
    await mcp.hover();
    const tip = mcp.locator(".nav-tooltip");
    await tip.waitFor();
    const bounds = await tip.boundingBox();
    const rail = await page.locator(".deck-sidebar").boundingBox();
    assert.ok(bounds && rail && bounds.x >= rail.x + rail.width && bounds.x+bounds.width < page.viewportSize().width);
    await page.getByRole("button",{name:"展开导航栏"}).click();
    await mcp.locator("span").waitFor();
  }
  await composerJourney(page);
  for(const [skin,label] of [["white","极简纯白"],["paper","暖纸阅读"],["obsidian","曜石琥珀"],["pine","午夜松林"]]){
    await nav("设置");await page.getByRole("button",{name:label,exact:true}).click();
    await page.waitForFunction(s=>document.documentElement.dataset.skin===s,skin);
    await home();await page.getByLabel("任务指令").waitFor();
    const style=await page.evaluate(()=>({
      width:document.documentElement.scrollWidth,screen:innerWidth,
      canvas:getComputedStyle(document.querySelector(".desk-main")).backgroundImage,
      sidebar:getComputedStyle(document.querySelector(".deck-sidebar")).backdropFilter,
      shadow:getComputedStyle(document.querySelector(".cd-composer")).boxShadow,
      bar:getComputedStyle(document.querySelector(".cd-chat-scroll"),"::-webkit-scrollbar").width,
      hint:document.querySelector(".cd-compose-hint").getBoundingClientRect().bottom,height:innerHeight,
    }));
    assert.equal(style.width,style.screen);assert.match(style.canvas,/radial-gradient/);assert.match(style.sidebar,/blur/);
    assert.notEqual(style.shadow,"none");assert.equal(style.bar,"5px");assert.ok(style.hint<=style.height+1);
    await shot(page,"flagship-"+skin+(mobile?"-mobile":"-desktop"));
    if (!mobile && skin === "pine") await shot(page.locator(".desk-nav"), "flagship-nav-expanded");
  }
  for(const [label,heading] of [["MCP","MCP 服务"],["Skills","Skills 与项目规范"],["插件","插件"],["提示词","提示词库"],["会话","会话"],["用量统计","用量统计"]]){
    await nav(label);await page.getByRole("heading",{name:heading,exact:true}).first().waitFor();
  }
  await nav("授权中心");const auth=page.getByRole("navigation",{name:"授权类型"});await auth.getByRole("button",{name:"公开分享"}).click();
  await nav("应用");await page.getByRole("navigation",{name:"应用分类"}).getByRole("button",{name:"成品资产箱"}).click();
  await page.getByRole("heading",{name:"成品资产箱"}).waitFor();
  if(!mobile)await page.locator(".nav-usage").getByText(/今日/).waitFor();
  await gatewayJourney(page);
  console.log("PASS flagship navigation, permission sheet, command palette, four skins, gateway workflow at "+page.viewportSize().width);
}
