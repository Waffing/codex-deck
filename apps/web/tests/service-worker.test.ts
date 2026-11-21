// @vitest-environment node
import {readFileSync} from "node:fs";
import vm from "node:vm";
import path from "node:path";
import {expect,it,vi} from "vitest";

it("only handles named build assets and cleans only stale CodexDeck caches",async()=>{
  const events=new Map<string,(event:unknown)=>void>();
  const removed:string[]=[];
  const worker=readFileSync(path.resolve("service-worker.js"),"utf8")
    .replace('"__BUILD__"','"current"').replace('"__STATIC_URLS__"','["/assets/bundle.js"]');
  const self={location:{origin:"https://deck.test"},clients:{claim:vi.fn()},addEventListener:events.set.bind(events)};
  vm.runInNewContext(worker,{URL,self,caches:{keys:()=>["codexdeck-static-old","other","codexdeck-static-current"],
    delete:(key:string)=>removed.push(key)}});
  let work:Promise<unknown>|undefined;
  events.get("activate")!({waitUntil:(p:Promise<unknown>)=>{work=p;}});
  await work;
  expect(removed).toEqual(["codexdeck-static-old"]);
  for(const path of ["/","/ws/events","/api/health","/s/slug","/dl/token","/preview/3001","/internal/v1/responses",
    "/live/site/","/assets/bundle.js?token=x","/assets/private.js","/console/system"]){
    const respondWith=vi.fn();
    events.get("fetch")!({request:new Request("https://deck.test"+path),respondWith});
    expect(respondWith,path).not.toHaveBeenCalled();
  }
});
