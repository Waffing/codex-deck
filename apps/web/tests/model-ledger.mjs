import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";

export async function modelLedgerJourney(page, origin, shot) {
  const profileRoute = async (route) => {
    const response = await route.fetch();
    const profile = await response.json();
    await route.fulfill({
      response,
      json: {
        ...profile,
        os: "Linux x64",
        cpu_count: 8,
        free_memory: 8 * 1024 ** 3,
        disk_free: 120 * 1024 ** 3,
        safe_pool: [10000, 19999],
        checked_at: "2026-11-22T12:00:00.000Z",
      },
    });
  };
  await page.route("**/api/server/profile", profileRoute);
  await page.goto(origin+"/console/services");
  await page.getByRole("tab",{name:"服务总览",selected:true}).waitFor();
  await page.getByRole("region",{name:"服务器体检"}).waitFor();
  await page.getByRole("button",{name:"预览",exact:true}).first().waitFor();
  await page.getByText("服务状态正常",{exact:false}).waitFor();
  await page.evaluate(() => {
    document.querySelectorAll(".ad-kv dd").forEach((cell) => {
      if (cell.textContent === window.location.host) cell.textContent = "demo.codexdeck.dev";
    });
    document.querySelectorAll(".health-pill span").forEach((item) => {
      if (item.textContent?.startsWith("CPU ")) item.textContent = "CPU 28%";
      if (item.textContent?.startsWith("内存 ")) item.textContent = "内存 42%";
    });
  });
  await page.evaluate(()=>document.fonts.ready);
  await shot(page,"api-service-overview");
  await page.unroute("**/api/server/profile", profileRoute);
  await page.getByRole("tab",{name:"供应商"}).click();
  const card=page.locator("article.ad-card").first();
  await card.getByRole("button",{name:"编辑",exact:true}).click();
  const editor=page.locator("form").filter({hasText:"编辑供应商"});
  const key="fixture-"+randomBytes(12).toString("hex");
  await editor.getByRole("button",{name:"添加另一个 Key"}).click();
  await editor.getByLabel("附加 Key 1").fill(key);
  await editor.getByText("余额查询凭证",{exact:true}).click();
  await editor.getByLabel("余额端点").fill(new URL("/balance",await editor.getByLabel("接口地址").inputValue()).href);
  await editor.getByLabel("余额管理令牌").fill("manage-"+randomBytes(12).toString("hex"));
  await editor.getByRole("button",{name:"保存渠道"}).click();
  await editor.waitFor({state:"hidden"});
  const savedKeys=card.getByLabel("已保存密钥").locator(".ad-pill");
  await savedKeys.nth(1).waitFor();
  assert.equal(await savedKeys.count(),2);
  assert.ok(!(await page.locator("body").innerText()).includes(key));
  await card.getByRole("button",{name:"刷新余额"}).click();
  await card.getByText("24.5 USD",{exact:true}).waitFor();
  await card.getByRole("button",{name:"从上游获取模型"}).click();
  const library=page.getByRole("dialog",{name:"从上游获取模型"});
  await library.getByLabel("搜索模型").fill("library");
  await library.getByLabel("模型前缀").selectOption("lab/");
  await library.getByLabel("选择筛选结果").click();
  const batch=page.waitForResponse(r=>r.url().endsWith("/api/models/batch")&&r.status()<300);
  await library.getByRole("button",{name:/导入选中模型/}).click();
  assert.equal((await (await batch).json()).imported.length,1);
  await library.getByRole("button",{name:"关闭"}).click();
  await page.getByRole("tab",{name:"模型与路由"}).click();
  const board=page.locator(".benchmark-board");
  const modelRow=board.getByRole("row").filter({hasText:"library"});
  await modelRow.getByRole("switch").click();
  await board.getByRole("button",{name:"测速选中模型"}).click();
  await modelRow.getByText("样本不足",{exact:true}).waitFor();
  await board.getByLabel("测生成速度",{exact:false}).click();
  await board.getByRole("button",{name:"测速选中模型"}).click();
  await modelRow.getByText(/\d+(\.\d+)? tok\/s/).waitFor();
  await board.getByRole("radiogroup",{name:"测速排序"}).getByRole("radio",{name:"按生成速率"}).click();
  await modelRow.getByRole("button",{name:"设为默认"}).click();
  await modelRow.getByText("默认模型",{exact:true}).waitFor();
  await shot(page,"09-model-center");
  await page.goto(origin+"/console/open-api");
  const ledger=page.getByRole("region",{name:"用量账本"});
  await ledger.getByRole("button",{name:"按周"}).click();
  await ledger.getByLabel("账本分组").selectOption("model");
  await ledger.getByRole("cell",{name:/library/}).waitFor();
  await ledger.getByText("预算告警",{exact:true}).click();
  await ledger.getByLabel("每日 USD").fill("2.5");
  await ledger.getByRole("button",{name:"保存预算"}).click();
  await ledger.getByText("预算已保存",{exact:true}).waitFor();
  const download=page.waitForEvent("download");
  await ledger.getByRole("link",{name:"导出 CSV"}).click();
  assert.equal((await download).suggestedFilename(),"codexdeck-usage.csv");
  await shot(page,"10-usage-ledger");
}
