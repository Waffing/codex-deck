import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";

// Resolve the production memoized Turn by its mounted props, even when its name is minified.
function findTurnRender(){
  const article=document.querySelector("article[data-turn]");
  const key=Object.getOwnPropertyNames(article).find(k=>k.startsWith("__reactFiber$"));
  for(let fiber=article[key];fiber;fiber=fiber.return){
    if(fiber.memoizedProps?.turn?.task?.id===article.dataset.turn && typeof fiber.type==="function")return fiber.type;
  }
}

export async function performanceJourney(browser,context,origin,db,instrument){
  const c=await browser.newContext({viewport:{width:1440,height:900},storageState:await context.storageState()});
  const page=await c.newPage();instrument(page);
  try{
    const workspace=db.prepare("SELECT id FROM workspaces LIMIT 1").pluck().get();
    const thread=await c.request.post(origin+"/api/threads",{data:{workspace_id:workspace,title:"分页验收"}});
    assert.equal(thread.status(),201);
    const id=(await thread.json()).id;
    const put=db.prepare("INSERT INTO tasks(id,thread_id,workspace_id,prompt,status,answer_markdown,created_at,updated_at) VALUES(?,?,?,?,'completed',?,?,?)");
    db.transaction(()=>{
      for(let i=1;i<=120;i++){const now=new Date(Date.now()-200000+i*1000).toISOString();
        put.run(randomUUID(),id,workspace,"历史样本 "+i,"### 记录 "+i+"\n\n"+("稳定正文 ".repeat(40)),now,now);}
    })();
    await page.addInitScript(({workspace,id})=>{localStorage.setItem("deck.workspace",workspace);localStorage.setItem("deck.thread",id);},{workspace,id});
    await page.goto(origin);
    await page.getByRole("heading",{name:"记录 120",exact:true}).waitFor();
    assert.equal(await page.locator("[data-turn]").count(),12);
    await page.getByRole("button",{name:"加载更早的记录"}).click();
    await page.getByText("历史样本 97",{exact:true}).waitFor();
    assert.equal(await page.locator("[data-turn]").count(),24);
    await page.waitForFunction(async tid=>{
      const db=await new Promise(resolve=>{const r=indexedDB.open("codexdeck-workbench",1);r.onsuccess=()=>resolve(r.result);});
      try{return await new Promise(resolve=>{const q=db.transaction("entries").objectStore("entries").get("thread:"+tid);q.onsuccess=()=>resolve(q.result?.value.turns.length===12);});}
      finally{db.close();}
    },id);
    await page.addInitScript(tid=>{
      const original=window.fetch.bind(window);
      const holds=new Set(["/api/threads/"+tid+"/turns","/api/workspaces","/api/threads","/api/providers","/api/models","/api/server/profile"]);
      const waiting=new Promise(resolve=>{window.__releaseReads=resolve;});
      window.__heldReads=0;
      window.fetch=async(input,options)=>{
        const url=new URL(typeof input==="string"?input:input.url,location.origin);
        if(holds.has(url.pathname)){window.__heldReads++;await waiting;}
        return original(input,options);
      };
    },id);
    await page.reload({waitUntil:"domcontentloaded"});
    try{
      await page.getByRole("heading",{name:"记录 120",exact:true}).waitFor();
      assert.equal(await page.locator("[data-turn]").count(),12);
      assert.ok(await page.evaluate(()=>window.__heldReads)>0);
    }finally{await page.evaluate(()=>window.__releaseReads());}
    const debuggerSession=await c.newCDPSession(page);
    await debuggerSession.send("Debugger.enable");
    const {result}=await debuggerSession.send("Runtime.evaluate",{expression:"("+findTurnRender.toString()+")()"});
    assert.equal(result.type,"function","The probe must resolve the mounted React Turn component");
    await page.evaluate(()=>{window.__historyTurnCalls=0;});
    await debuggerSession.send("Debugger.setBreakpointOnFunctionCall",{objectId:result.objectId,
      condition:"(window.__historyTurnCalls++, false)"});
    // Scrolling to the button can itself load a page. Wait for the mounted history
    // to grow after each upward gesture, including on the last page.
    const history=page.locator("article[data-turn]");
    await page.locator(".cd-chat-scroll").hover();
    for(let count=await history.count();count<120;count=await history.count()) {
      await page.mouse.wheel(0,-100000);
      await page.waitForFunction(previous=>document.querySelectorAll("article[data-turn]").length>previous,count);
    }
    await page.getByText("历史样本 1",{exact:true}).waitFor();
    assert.equal(await page.locator("article[data-turn]").count(),120);
    // Positive control: all 108 newly mounted history items must have called the component.
    assert.ok(await page.evaluate(()=>window.__historyTurnCalls)>=108,"React render counter missed mounted history");
    await page.evaluate(()=>{window.__historyTurnCalls=0;});
    const input=page.getByRole("textbox",{name:"任务指令"});
    // Give the real UI keystrokes and sample the first animation callback after each input event.
    const responseTimes=await input.evaluate(async input=>{
      const observations=[];
      for(let i=0;i<40;i++)await new Promise(resolve=>requestAnimationFrame(()=>{
        const start=performance.now();
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(input,"输入测试 "+i);
        input.dispatchEvent(new InputEvent("input",{bubbles:true,data:String(i)}));
        requestAnimationFrame(()=>{observations.push(performance.now()-start);resolve();});
      }));
      return observations.sort((a,b)=>a-b);
    });
    const p95=responseTimes[Math.ceil(responseTimes.length*.95)-1];
    const renders=await page.evaluate(()=>window.__historyTurnCalls);
    await debuggerSession.detach();
    console.log("Typing 120 turns · 40 input-to-next-frame samples · p50="+responseTimes[19].toFixed(1)+"ms p95="+p95.toFixed(1)+"ms · completed Turn renders="+renders);
    assert.equal(renders,0,"Typing re-rendered completed React Turn components");
    assert.ok(Number.isFinite(p95)&&p95<100,"typing blocked for more than 100 ms");
    await page.evaluate(()=>{
      const previous=window.fetch.bind(window);
      window.__pendingClientIds=[];
      window.fetch=async(input,options)=>{
        if(typeof input==="string"&&input.endsWith("/messages")&&options?.method==="POST"){
          window.__pendingClientIds.push(JSON.parse(options.body).client_msg_id);
          if(window.__pendingClientIds.length===1){
            await new Promise(resolve=>window.__rejectSend=resolve);throw new TypeError("测试断线");
          }
        }
        return previous(input,options);
      };
    });
    await input.fill("可重试消息");
    await input.evaluate(field=>{
      field.addEventListener("keydown",()=>{
        const start=performance.now();
        const bubble=()=>document.querySelector("[data-client-message] .cd-prompt");
        const observer=new MutationObserver(()=>{
          if(!bubble() || field.value)return;
          window.__sendDomMs=performance.now()-start;
          observer.disconnect();
        });
        observer.observe(document.querySelector(".cd-chat-pane"),{subtree:true,childList:true});
        const sampleFrame=()=>{
          const prompt=bubble(),rect=prompt?.getBoundingClientRect();
          if(rect && prompt.contains(document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2))) {
            window.__sendFrameMs=performance.now()-start;
          }else if(performance.now()-start<5000)requestAnimationFrame(sampleFrame);
        };
        requestAnimationFrame(sampleFrame);
      },{capture:true,once:true});
    });
    await input.press("Enter");
    await page.locator("[data-client-message] .cd-prompt").filter({hasText:"可重试消息"}).waitFor();
    await page.waitForFunction(()=>Number.isFinite(window.__sendDomMs)&&Number.isFinite(window.__sendFrameMs));
    const send=await page.evaluate(()=>({dom:window.__sendDomMs,frame:window.__sendFrameMs}));
    console.log("Optimistic Enter · POST held · bubble DOM + cleared input="+send.dom.toFixed(1)+"ms · first visible animation frame="+send.frame.toFixed(1)+"ms (n=1)");
    assert.equal(await input.inputValue(),"");
    assert.equal(await page.getByText("任务已提交",{exact:true}).count(),0);
    await page.evaluate(()=>window.__rejectSend());
    await page.getByRole("button",{name:"发送失败 · 点击重试"}).click();
    await page.getByText("first complete",{exact:true}).waitFor();
    assert.equal(await page.getByText("可重试消息",{exact:true}).count(),1);
    const ids=await page.evaluate(()=>window.__pendingClientIds);
    assert.equal(ids.length,2);assert.equal(ids[0],ids[1]);
    await page.locator(".desk-nav").getByRole("button",{name:/系统|设置/}).click();
    await page.getByRole("button",{name:"一键清空本地缓存"}).click();
    await page.getByText("本地缓存已清空").waitFor();
    await page.getByText(/0 个会话 · /).waitFor();
    console.log("PASS 12-turn IDB stale display before all held network replies, 120-turn paging, optimistic retry and cache clear");
  }finally{await c.close();}
}
