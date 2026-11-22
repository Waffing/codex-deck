import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";

// Runs against the production web build, authenticated Fastify server and local model fixture.
export async function gatewayJourney(page) {
  const origin=new URL(page.url()).origin,slug="test-route-"+randomUUID().slice(0,8);
  await page.goto(origin+"/console/providers");
  const tabs=page.getByRole("tablist",{name:"API 指挥中心分类"});
  await tabs.waitFor();assert.equal(await tabs.getByRole("tab").count(),5);
  await tabs.getByRole("tab",{name:"供应商"}).click();
  await page.getByRole("button",{name:"添加供应商",exact:true}).click();
  const editor=page.getByRole("dialog",{name:"添加供应商"});
  assert.ok(await editor.locator(".gw-presets button").count()>=15);
  await editor.getByRole("button",{name:"Anthropic",exact:true}).click();
  assert.match(await editor.getByLabel("接口地址").inputValue(),/anthropic/);
  await editor.getByRole("button",{name:"关闭供应商编辑"}).click();
  const providers=await (await page.request.get(origin+"/api/providers")).json();
  const models=(await (await page.request.get(origin+"/api/models")).json()).filter(m=>m.enabled&&providers.some(p=>p.id===m.provider_id&&p.enabled));
  const original=models.find(m=>m.model_id==="fixture-model")??models[0];assert.ok(original);
  const upstream=providers.find(p=>p.id===original.provider_id);assert.ok(upstream);
  await tabs.getByRole("tab",{name:"模型与路由"}).click();
  await page.getByRole("button",{name:"新建路由组",exact:true}).click();
  const form=page.locator("form").filter({has:page.getByLabel("虚拟模型别名")});
  await form.getByLabel("路由名称").fill("集成测试路由");await form.getByLabel("虚拟模型别名").fill(slug);
  await form.getByLabel("添加目标模型").selectOption(original.id);
  if(await form.getByRole("switch").getAttribute("aria-checked")!=="true")await form.getByRole("switch").click();
  const saved=page.waitForResponse(r=>r.request().method()==="POST"&&r.url().endsWith("/api/routing-profiles"));
  await form.getByRole("button",{name:"保存路由组"}).click();
  const response=await saved;assert.equal(response.status(),201);const route=await response.json();
  await tabs.getByRole("tab",{name:"供应商"}).click();
  const providerCard=page.locator(".ad-card").filter({hasText:upstream.name}).first();
  await providerCard.getByRole("button",{name:"停用供应商",exact:true}).click();
  const stopDialog=page.getByRole("dialog");await stopDialog.waitFor();
  await stopDialog.getByRole("button",{name:"取消",exact:true}).click();
  assert.equal((await (await page.request.get(origin+"/api/providers/"+upstream.id)).json()).enabled,true);
  await providerCard.getByRole("button",{name:"停用供应商",exact:true}).click();
  const disabled=page.waitForResponse(r=>r.request().method()==="PATCH"&&r.url().endsWith("/api/providers/"+upstream.id));
  await page.getByRole("dialog").getByRole("button",{name:"确认停用",exact:true}).click();
  assert.equal((await disabled).status(),200);
  assert.equal((await (await page.request.get(origin+"/api/providers/"+upstream.id)).json()).enabled,false);
  assert.equal((await (await page.request.get(origin+"/api/models/"+original.id)).json()).provider_id,upstream.id);
  const enable=page.waitForResponse(r=>r.request().method()==="PATCH"&&r.url().endsWith("/api/providers/"+upstream.id));
  await providerCard.getByRole("button",{name:"重新启用",exact:true}).click();
  assert.equal((await enable).status(),200);
  assert.equal((await (await page.request.get(origin+"/api/providers/"+upstream.id)).json()).enabled,true);
  await tabs.getByRole("tab",{name:"客户端接入"}).click();
  await page.getByRole("button",{name:"创建 API Key"}).click();
  const wizard=page.locator("form").filter({has:page.getByLabel("密钥名称")});
  await wizard.getByLabel("密钥名称").fill("QA "+slug);
  await wizard.getByRole("switch",{name:"tasks:read",exact:true}).click();
  await wizard.getByRole("switch",{name:"proxy:responses",exact:true}).click();
  await wizard.getByRole("switch",{name:"proxy:models",exact:true}).click();
  await wizard.getByRole("switch",{name:slug,exact:true}).click();
  const issue=page.waitForResponse(r=>r.request().method()==="POST" && r.url().endsWith("/api/api-keys"));
  await wizard.getByRole("button",{name:"生成密钥"}).click();
  const issued=await issue;assert.equal(issued.status(),201);const key=await issued.json();
  assert.deepEqual(key.allowed_models,[slug]);await page.getByRole("button",{name:"已保存，关闭"}).click();
  try{
    await tabs.getByRole("tab",{name:"供应商"}).click();
    const switched=page.waitForResponse(r=>r.url().endsWith("/"+route.id+"/switch"));
    await page.locator(".gw-switch").getByRole("button",{name:original.alias,exact:true}).click();
    assert.equal((await switched).status(),200);
    await tabs.getByRole("tab",{name:"请求与账本"}).click();
    const capture=page.getByRole("switch",{name:"脱敏抓包"});await capture.waitFor();
    if(await capture.getAttribute("aria-checked")!=="true"){
      const enabled=page.waitForResponse(r=>r.request().method()==="PATCH"&&r.url().endsWith("/gateway/debug"));
      await capture.click();assert.equal((await enabled).status(),200);
    }
    const generation=await page.request.post(origin+"/v1/responses",{headers:{authorization:"Bearer "+key.api_key},data:{model:slug,input:"Reply OK.",max_output_tokens:1,stream:false}});
    assert.equal(generation.status(),200);
    await page.getByRole("button",{name:"刷新",exact:true}).click();
    const row=page.locator("tr").filter({hasText:slug}).first();
    await row.getByRole("button").click();
    const details=page.getByRole("dialog",{name:"请求详情"});
    const replay=page.waitForResponse(r=>r.url().endsWith("/replay"));
    await details.getByRole("button",{name:"重放测试"}).click();
    const result=await replay;assert.equal((await result.json()).status_code,200);
    await details.getByRole("button",{name:"关闭详情"}).click();
    await tabs.getByRole("tab",{name:"客户端接入"}).click();
    await page.getByLabel("访问密钥",{exact:true}).selectOption(key.id);
    await page.getByLabel("接入模型").selectOption(slug);
    await page.getByRole("button",{name:"生成接入配置"}).click();
    await page.locator("pre").filter({hasText:"wire_api"}).waitFor();
    await page.getByLabel("客户端",{exact:true}).selectOption("claude");
    await page.locator("pre").filter({hasText:"ANTHROPIC_BASE_URL"}).waitFor();
  }finally{
    assert.ok((await page.request.patch(origin+"/api/gateway/debug",{data:{enabled:false}})).ok());
    assert.ok((await page.request.delete(origin+"/api/api-keys/"+key.id)).ok());
    assert.ok((await page.request.delete(origin+"/api/routing-profiles/"+route.id)).ok());
  }
}
