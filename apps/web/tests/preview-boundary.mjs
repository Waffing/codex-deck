import assert from "node:assert/strict";
import {createServer} from "node:http";
import {once} from "node:events";
import {writeFile} from "node:fs/promises";
import path from "node:path";

// A separate negative-control page checks deliberate CSP denials. Browser diagnostics
// from this page stay distinct from the zero-error interactive reading journeys.
export async function previewBoundary(control,origin,files,workspace) {
  let received=0;
  const destination=createServer((_req,res)=>{received++;res.end("local navigation target");});
  destination.listen(0,"127.0.0.1");await once(destination,"listening");
  const target="http://127.0.0.1:"+destination.address().port+"/target";
  const page=await control.newPage();
  const denied=[],unexpected=[];
  page.on("console",msg=>{
    if(msg.type()!=="error")return;
    if(/Content Security Policy|frame-src/i.test(msg.text()))denied.push(msg.text());
    else unexpected.push(msg.text());
  });
  page.on("pageerror",e=>unexpected.push(e.message));
  try {
    const name="navigation-check.html";
    await writeFile(path.join(workspace.path,name),'<h1>Local link fixture</h1><a href="'+target+'">Local destination</a>');
    const item=await files.registerArtifact(workspace.id,null,null,name,"added");
    const home=await page.goto(origin+"/artifacts");
    assert.match(home.headers()["content-security-policy"],/frame-src 'self'/);
    await page.getByRole("button",{name:new RegExp(name)}).filter({hasText:name}).first().click();
    const frame=page.frameLocator('iframe[title="'+name+' 隔离预览"]');
    await frame.getByText("Local link fixture").waitFor({timeout:5000});
    await frame.getByRole("link",{name:"Local destination"}).click();
    for(let i=0;i<30&&!denied.length&&!received;i++)await new Promise(resolve=>setTimeout(resolve,100));
    assert.equal(received,0,"the second origin received a request");
    assert.ok(denied.length,"Chromium should report an intentional frame-src denial");
    const direct=await page.goto(origin+"/api/artifacts/"+item.id+"/content");
    assert.match(direct.headers()["content-type"],/text\/plain/);
    assert.equal(await page.getByRole("link",{name:"Local destination"}).count(),0);
    assert.deepEqual(unexpected,[]);
    console.log("Preview boundary: local second origin received zero requests, direct HTML displayed as text.");
  } finally {await page.close();await new Promise(resolve=>destination.close(resolve));}
}
