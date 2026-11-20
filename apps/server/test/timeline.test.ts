import {describe,expect,it} from "vitest";
import {projectEvent,projectTurn,type ThreadEvent} from "@codexdeck/shared";

describe("user timeline projection",()=>{
  it("keeps tool output when a final command item lacks output and starts a new group at an approval boundary",()=>{
    const rows:ThreadEvent[]=[];
    function emit(type:string,payload:unknown) {rows.push({type,payload,seq_id:rows.length+1,thread_id:"t",task_id:"j",created_at:""});}
    emit("item/started",{item:{type:"commandExecution",id:"a",command:"git status"}});
    emit("item/commandExecution/outputDelta",{itemId:"a",delta:"\nclean"});
    emit("approval_req",{id:"approval"});
    emit("item/completed",{item:{type:"commandExecution",id:"a",command:"git status"}});
    emit("item/started",{item:{type:"commandExecution",id:"b",command:"git diff"}});
    const turn=projectTurn(rows);
    expect(turn.items.map(i=>i.operations?.[0].id)).toEqual(["a","b"]);
    expect(turn.items[0].operations?.[0].detail).toContain("clean");
  });
  it("reconciles deltas and final items once, groups adjacent tools, retains plans, hides raw frames and separates commentary",()=>{
    const log:ThreadEvent[]=[];
    function emit(type:string,payload:unknown) {log.push({type,payload,seq_id:log.length+1,thread_id:"thread",task_id:"turn",created_at:""});}
    emit("thread/status/changed",{});emit("turn/started",{});
    emit("item/reasoning/summaryTextDelta",{itemId:"r",delta:"Checking files."});
    for(const id of ["a","b"]) for(const status of ["started","completed"]) emit(`item/${status}`,{item:{id,type:"commandExecution",command:"cat file",commandActions:[{type:"read"}],aggregatedOutput:status==="completed"?"OK":""}});
    emit("turn/plan/updated",{plan:[{step:"Read",status:"completed"}]});
    emit("item/started",{item:{type:"agentMessage",id:"c",phase:"commentary",text:""}});
    emit("item/agentMessage/delta",{itemId:"c",delta:"Progress"});
    emit("item/completed",{item:{type:"agentMessage",id:"c",phase:"commentary",text:"Progress"}});
    const markdown="**Complete**\n"+"x".repeat(11000);
    emit("item/agentMessage/delta",{itemId:"m",delta:markdown});emit("item/completed",{item:{id:"m",type:"agentMessage",text:markdown}});
    const visible=log.map(e=>projectEvent(e)).filter(e=>e!==null);
    expect(visible.some(e=>e.type.includes("/")||e.type==="protocol_debug")).toBe(false);
    const turn=projectTurn(visible);expect(turn.answer).toBe(markdown);expect(turn.debug).toEqual([]);
    expect(turn.items.map(i=>i.kind)).toEqual(["reasoning_summary","tool_group","todo_progress","reasoning_summary"]);
    expect(turn.items[1].operations?.map(op=>op.detail)).toEqual(["cat file\nOK","cat file\nOK"]);
    expect(turn.items[2].steps).toEqual([{step:"Read",status:"completed"}]);expect(turn.items[3].text).toBe("Progress");
    expect(projectTurn(log).debug.some(e=>(e.payload as {method:string}).method==="turn/started")).toBe(true);
  });
});
