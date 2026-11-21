import assert from "node:assert/strict";
import {createHmac} from "node:crypto";
import {readFile} from "node:fs/promises";

function authenticatorCode(base32) {
  const bits=[...base32].map(c=>"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(c).toString(2).padStart(5,"0")).join("");
  const key=Buffer.from(bits.match(/.{8}/g).map(v=>parseInt(v,2)));
  const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)));
  const hash=createHmac("sha1",key).update(counter).digest();
  return String((hash.readUInt32BE(hash[19]&15)&0x7fffffff)%1000000).padStart(6,"0");
}

export async function securityCenterJourney(admin,browser,shot,instrument,password) {
  await admin.locator(".desk-nav").getByRole("button",{name:"系统与通知"}).click();
  const tabs=admin.getByRole("navigation",{name:"设置分类"});
  await tabs.getByRole("button",{name:"安全中心"}).click();
  await admin.getByRole("heading",{name:"活跃设备"}).waitFor();
  await admin.getByRole("button",{name:/填入我当前 IP/}).click();
  await admin.getByLabel("IP 访问规则").selectOption("allow");
  await admin.getByRole("button",{name:"保存安全策略"}).click();
  await admin.getByText("安全策略已保存").waitFor();
  await admin.getByLabel("IP 访问规则").selectOption("off");
  await admin.getByRole("button",{name:"保存安全策略"}).click();
  await admin.getByText("安全策略已保存").waitFor();
  await admin.getByRole("heading",{name:"设置与安全中心"}).scrollIntoViewIfNeeded();
  await shot(admin,"v12-security-center");

  await tabs.getByRole("button",{name:"临时访问管理"}).click();
  await admin.getByRole("button",{name:"创建临时链接"}).click();
  await admin.getByLabel("邀请名称").fill("设计评审");
  await admin.getByLabel("console-lab").check();
  await admin.getByLabel("轮次上限").fill("2");
  await admin.getByRole("button",{name:"生成邀请"}).click();
  const [url,codeText]=(await admin.getByLabel("邀请文案").inputValue()).split("\n");
  assert.ok(url.includes("/guest/") && codeText);
  await admin.getByRole("button",{name:"收起邀请"}).click();
  const guestContext=await browser.newContext({viewport:{width:390,height:844},isMobile:true});
  try {
    const page=await guestContext.newPage();instrument(page);
    await page.goto(url);
    await page.getByLabel("提取码").fill(codeText.split(" ").at(-1));
    const [admission]=await Promise.all([page.waitForResponse(r=>r.request().method()==="POST" && new URL(r.url()).pathname.startsWith("/guest/")),page.getByRole("button",{name:"进入工作区"}).click()]);
    assert.equal(admission.status(),303,"guest redemption: HTTP "+admission.status());
    await page.getByText("临时访问模式",{exact:true}).waitFor();
    await page.getByText("只读",{exact:true}).waitFor();
    assert.equal(await page.getByRole("textbox",{name:"访客消息"}).count(),0);
    assert.equal(await page.getByText("设置与安全中心",{exact:true}).count(),0);
    await page.locator(".md-document").first().waitFor();
    const article=admin.locator("article").filter({hasText:"设计评审"});
    await article.getByRole("button",{name:"续期 / 加额"}).click();
    await admin.getByLabel("延长有效期").selectOption("6");
    await admin.getByLabel("追加轮次").fill("3");
    await admin.getByRole("button",{name:"保存增量"}).click();
    await article.getByText("轮次 0 / 5").waitFor();
    await page.locator(".guest-banner").getByText("轮次 0 / 5").waitFor();
    await shot(page,"v12-guest-mobile");
    admin.once("dialog",d=>d.accept());
    await article.getByRole("button",{name:"立即吊销"}).click();
    await page.getByRole("heading",{name:"临时访问已结束"}).waitFor();
    assert.equal(await page.locator(".md-document").count(),0);
  } finally {await guestContext.close();}
  await tabs.getByRole("button",{name:"系统与备份"}).click();
  const [backup]=await Promise.all([admin.waitForEvent("download"),admin.getByRole("link",{name:"下载 SQLite 备份"}).click()]);
  assert.equal((await readFile(await backup.path())).subarray(0,15).toString(),"SQLite format 3");

  await tabs.getByRole("button",{name:"安全中心"}).click();
  await admin.getByRole("button",{name:"设置身份验证器"}).click();
  const factor=admin.locator("section").filter({has:admin.getByRole("heading",{name:"双重验证",exact:true})}).last();
  await factor.locator("svg[role=img],svg title").first().waitFor({state:"attached"});
  const key=await factor.locator("code").innerText();
  await factor.getByLabel("动态口令或恢复码").fill(authenticatorCode(key));
  await factor.getByRole("button",{name:"校验并启用"}).click();
  const codes=(await factor.locator("pre").innerText()).split("\n");
  assert.equal(codes.length,8);
  const loginContext=await browser.newContext();
  try {
    const login=await loginContext.newPage();instrument(login);
    await login.goto(new URL("/",admin.url()).href);
    await login.getByLabel("管理员密码",{exact:true}).fill(password);
    await login.getByLabel("动态口令或恢复码").fill(codes[0]);
    await login.getByRole("button",{name:"登录",exact:true}).click();
    await login.getByRole("button",{name:"切换主题"}).waitFor();
  } finally {await loginContext.close();}
  await factor.getByLabel("动态口令或恢复码").fill(codes[1]);
  await factor.getByRole("button",{name:"验证并关闭双重验证"}).click();
  await factor.getByRole("button",{name:"设置身份验证器"}).waitFor();
}
