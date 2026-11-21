import {describe,it,expect,vi,afterEach} from "vitest";
import {connectEvents,clearRealtime,useRealtime,mergeEvents,lastContiguous} from "./realtime";
import type {ThreadEvent} from "@codexdeck/shared";
const frame=(n:number):ThreadEvent=>({thread_id:"t",task_id:null,type:"delta",payload:{n},created_at:"now",seq_id:n});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();clearRealtime();});
describe("WebSocket resume",()=>{
  it("sorts out of order and holds the cursor before gaps",()=>{
    const events=mergeEvents([frame(1)],[frame(4),frame(1),frame(3)],"t");
    expect(events.map(e=>e.seq_id)).toEqual([1,3,4]);expect(lastContiguous(events)).toBe(1);
    expect(lastContiguous(mergeEvents(events,[frame(2)],"t"))).toBe(4);
  });
  it("resumes from the accepted snapshot and reconnects across compacted gaps",()=>{
    vi.useFakeTimers();
    const clients:Fake[]=[];
    class Fake {onmessage?: (x:{data:string})=>void;onclose?: (x:{code:number})=>void;
      constructor(public url:URL){clients.push(this);} close(){} }
    vi.stubGlobal("WebSocket",Fake);
    const stop=connectEvents("t",()=>{},()=>{},7);
    expect(clients[0].url.searchParams.get("last_seq_id")).toBe("7");
    for(const n of [8,11,10,11])clients[0].onmessage?.({data:JSON.stringify({type:"event",event:frame(n)})});
    clients[0].onclose?.({code:1006});vi.advanceTimersByTime(350);
    expect(clients[1].url.searchParams.get("last_seq_id")).toBe("11");
    clients[1].onmessage?.({data:JSON.stringify({type:"event",event:frame(12)})});stop();
    const cleanup=connectEvents("t",()=>{},()=>{},13);
    expect(clients[2].url.searchParams.get("last_seq_id")).toBe("13");
    expect(useRealtime.getState().events.map(e=>e.seq_id)).toEqual([]);cleanup();
  });
});
