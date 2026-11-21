import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

export async function hubPwaJourney({page,origin,workspaceId}){
  const http=page.context().request;
  const start=await http.get(origin+"/manifest.webmanifest");
  assert.equal(start.status(),200);
  const manifest=await start.json();
  assert.equal(manifest.display,"standalone");
  for(const size of [192,512,180]){
    const icon=await http.get(origin+(size===180?"/icons/apple-touch-icon.png":manifest.icons.find(entry=>entry.sizes===size+"x"+size).src));
    const bytes=await icon.body();
    assert.equal(bytes.readUInt32BE(16),size);assert.equal(bytes.readUInt32BE(20),size);
  }
  const suffix=page.viewportSize().width+"-asset.csv";
  const upload=await http.post(origin+"/api/workspaces/"+workspaceId+"/files/upload",{multipart:{file:{name:suffix,mimeType:"text/csv",buffer:Buffer.from("列名\n资产样本")}}});
  assert.equal(upload.status(),201);
  const {artifact}=await upload.json();
  await page.goto(origin+"/console/artifacts");
  await page.getByRole("heading",{name:"成品资产箱"}).waitFor();
  await page.getByLabel("显示全部文件").check();
  await page.getByLabel("资产工作区").selectOption(workspaceId);
  await page.getByLabel("资产类别").getByRole("button",{name:"表格"}).click();
  await page.getByLabel("搜索文件名").fill(suffix);
  await page.getByLabel("列表视图").click();
  const file=page.locator(".hub-items.list article").filter({hasText:artifact.name});
  await file.getByRole("checkbox").check();
  const started=page.waitForEvent("download");
  await page.getByRole("button",{name:"下载 ZIP"}).click();
  const dl=await started;
  assert.equal(dl.suggestedFilename(),"artifacts.zip");
  const bytes=await readFile(await dl.path());
  assert.equal(bytes.readUInt32LE(0),0x04034b50);
  await file.locator(".hub-file").click();
  await page.getByLabel("文档预览").getByText("资产样本",{exact:true}).waitFor();
  await page.getByRole("button",{name:"关闭抽屉"}).click();
  await page.getByLabel("卡片视图").click();
  assert.equal(await page.locator(".hub-items.grid article").count(),1);
  await page.evaluate(()=>navigator.serviceWorker.ready.then(()=>true));
  await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
  const keys=await page.evaluate(async(id)=>{
    for(const url of ["/api/health","/api/artifacts/"+id+"/content","/icons/icon-192.png","/icons/icon-192.png?signed=fixture"]){
      const response=await fetch(url);if(!response.ok)throw new Error("PWA fixture HTTP "+response.status);
      await response.arrayBuffer();
    }
    const owned=(await caches.keys()).filter(key=>key.startsWith("codexdeck-static-"));
    const urls=await Promise.all(owned.map(async key=>(await(await caches.open(key)).keys()).map(r=>r.url)));
    return urls.flat().map(url=>new URL(url).pathname+new URL(url).search);
  },artifact.id);
  assert.ok(keys.includes("/icons/icon-192.png"),"worker wrote static icon to Cache Storage");
  assert.ok(keys.every(p=>/^\/(?:assets|icons)\/[\w.-]+$/.test(p)),"unexpected cached URL "+keys);
  await page.goto(origin+"/console/system");
  await page.getByRole("heading",{name:"安装 CodexDeck"}).waitFor();
  const theme=await page.evaluate(()=>[document.querySelector('meta[name="theme-color"]').content,getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()]);
  assert.equal(theme[0],theme[1]);
  await page.evaluate(()=>{
    const event=new Event("beforeinstallprompt",{cancelable:true});
    event.prompt=async()=>{window.__installPrompted=true;};
    event.userChoice=Promise.resolve({outcome:"accepted"});
    window.dispatchEvent(event);
  });
  await page.getByRole("button",{name:"安装为桌面或手机应用"}).click();
  assert.equal(await page.evaluate(()=>window.__installPrompted),true);
  await page.evaluate(()=>window.dispatchEvent(new Event("appinstalled")));
  await page.getByText("已在独立应用窗口中打开。").waitFor();
  console.log("PASS artifact filters, list/grid, signed ZIP, drawer, PWA manifest/icons and static-only Cache Storage at "+page.viewportSize().width);
}
