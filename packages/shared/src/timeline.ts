import type { ThreadEvent } from "./phase2.js";
import {z} from "zod";

export const toolOperationSchema=z.object({id:z.string(),label:z.string(),detail:z.string(),status:z.string()});
export const timelineItemSchema=z.object({
  kind:z.enum(["reasoning_summary","tool_group","subagent_status","todo_progress","context_compacted"]),
  id:z.string(),text:z.string(),operations:z.array(toolOperationSchema).optional(),
  steps:z.array(z.object({step:z.string(),status:z.string()})).optional(),before_tokens:z.number().optional(),after_tokens:z.number().optional(),
  before_estimated:z.boolean().optional(),estimated:z.boolean().optional(),
});
const metric=z.number().nonnegative().nullable();
export const turnTelemetrySchema=z.object({
  price_recorded:z.boolean().optional(),elapsed_ms:z.number().nonnegative(),model:z.string().nullable(),tokens_per_sec:metric,cache_hit_rate:metric,
  input_tokens:metric,output_tokens:metric,cost_usd:metric,cost_cny:metric,context_tokens:metric,
  files:z.array(z.object({path:z.string(),added:metric,removed:metric})),diff:z.string(),
});
export type ToolOperation=z.infer<typeof toolOperationSchema>;
export type TimelineItem=z.infer<typeof timelineItemSchema>;
export type TurnTelemetry=z.infer<typeof turnTelemetrySchema>;
type RecordValue = Record<string,unknown>;
const object = (v:unknown):RecordValue => v && typeof v === "object" && !Array.isArray(v) ? v as RecordValue : {};
const text = (v:unknown):string => typeof v === "string" ? v : "";
const strings = (v:unknown):string[] => Array.isArray(v) ? v.filter((s):s is string=>typeof s === "string") : [];

/** Applies equally to legacy replay rows and live notifications. Debug payloads never enter normal frames. */
export function projectEvent(event:ThreadEvent, debug=false):ThreadEvent|null {
  const {type} = event, p=object(event.payload), item=object(p.item);
  if (type==="item/reasoning/textDelta" || type==="rawResponseItem/completed") return null;
  if (debug && item.type==="reasoning") event={...event,payload:{...p,item:{id:item.id,type:item.type,summary:item.summary}}};
  const sanitized=object(event.payload);
  const frame=(name:string,value:RecordValue)=>({...event,type:name,payload:debug && type.includes("/") ? {...value,protocol:{method:type,params:sanitized}} : value});
  const protocol=()=>debug ? {...event,type:"protocol_debug",payload:{method:type,params:sanitized}} : null;
  if (!type.includes("/")) return ["stderr","unsupported_request","process_started","process_resumed"].includes(type) ? protocol() : event;
  const id=text(item.id)||text(p.itemId)||String(event.seq_id);
  if (type==="item/agentMessage/delta") return frame("answer_delta",{id,text:text(p.delta)});
  if (type==="item/reasoning/summaryTextDelta") return frame("reasoning_summary",{id,text:text(p.delta),delta:true});
  if (type==="turn/plan/updated") return frame("todo_progress",{id:"plan",text:text(p.explanation),steps:Array.isArray(p.plan)?p.plan.map(s=>({step:text(object(s).step),status:text(object(s).status)})):[]});
  if (type==="item/commandExecution/outputDelta" || type==="item/fileChange/outputDelta") return frame("tool_group",{id,output:text(p.delta)});
  if (type==="thread/tokenUsage/updated") {
    const last=object(object(p.tokenUsage).last);
    const window=object(p.tokenUsage).modelContextWindow;
    return frame("context_usage",{tokens:last.totalTokens,model_alias:p.model_alias??null,model_context_window:typeof window==="number" && Number.isSafeInteger(window) && window>0?window:null,
      input_tokens:last.inputTokens??null,output_tokens:last.outputTokens??null,cached_tokens:last.cachedInputTokens??null,tokens_per_sec:p.tokens_per_sec??null});
  }
  if (type!=="item/started" && type!=="item/completed") return protocol();
  const complete=type==="item/completed";
  if (item.type==="agentMessage") return frame(item.phase==="commentary"?"reasoning_summary":"answer_item",{id,text:text(item.text),complete,phase:item.phase});
  if (item.type==="reasoning") return frame("reasoning_summary",{id,text:strings(item.summary).join("\n\n"),complete});
  if (item.type==="collabAgentToolCall" || item.type==="subAgentActivity") {
    const states=Object.entries(object(item.agentsStates)).map(([agent,s])=>`${agent} · ${text(object(s).status)}`).join("\n");
    return frame("subagent_status",{id,text:[text(item.agentPath)||text(item.tool)||text(item.kind)||"子任务",text(item.status),states].filter(Boolean).join(" · ")});
  }
  let label:string, detail:string;
  switch (item.type) {
    case "commandExecution": {
      const actions=Array.isArray(item.commandActions)?item.commandActions.map(a=>object(a).type):[];
      label=actions.includes("read")?"读取文件":actions.includes("search")?"搜索文件":actions.includes("listFiles")?"列出文件":"执行命令";
      detail=[text(item.command),text(item.aggregatedOutput)].filter(Boolean).join("\n"); break;
    }
    case "fileChange":label="修改文件";detail=Array.isArray(item.changes)?item.changes.map(c=>text(object(c).path)).join("\n"):"";break;
    case "mcpToolCall":case "dynamicToolCall":label=text(item.tool)||"调用工具";detail=[text(item.server),JSON.stringify(item.arguments??{}),item.result?JSON.stringify(item.result):""].filter(Boolean).join("\n");break;
    case "webSearch":label="检索网页";detail=text(item.query);break;
    default:return protocol();
  }
  return frame("tool_group",{id,label,detail,status:text(item.status)||(complete?"completed":"running")});
}

export function projectTurn(events:ThreadEvent[]) {
  const items:TimelineItem[]=[], debug:ThreadEvent[]=[], messages=new Map<string,string>(), commentary=new Set<string>();
  const byId=new Map<string,TimelineItem>(), operations=new Map<string,ToolOperation>();
  let telemetry:TurnTelemetry|null=null, group:TimelineItem|undefined;
  for (const incoming of events) {
    const event=projectEvent(incoming,true);
    if (!event) continue;
    const p=object(event.payload), id=text(p.id)||String(event.seq_id), value=text(p.text);
    if (/^approval_|^answer_|^reasoning_summary$|^subagent_status$|^todo_progress$|^context_compacted$/.test(event.type)) group=undefined;
    if (p.protocol) debug.push({...event,type:"protocol_debug",payload:p.protocol});
    switch (event.type) {
      case "protocol_debug":debug.push(event);break;
      case "turn_telemetry":{const parsed=turnTelemetrySchema.safeParse(event.payload);if(parsed.success)telemetry=parsed.data;break;}
      case "answer_item":case "answer_delta":
        if (commentary.has(id)) { const previous=byId.get(id); if (previous) previous.text+=value; }
        else if (event.type==="answer_delta") messages.set(id,(messages.get(id)??"")+value);
        else if (value || !messages.has(id)) messages.set(id,value);
        break;
      case "reasoning_summary":case "subagent_status":case "todo_progress":case "context_compacted": {
        const prev=byId.get(id);
        if (p.phase==="commentary" || (event.type==="reasoning_summary" && messages.has(id))) { commentary.add(id); messages.delete(id); }
        const next:TimelineItem={kind:event.type,id,text:p.delta?(prev?.text??"")+value:value||prev?.text||text(p.summary)};
        if (Array.isArray(p.steps)) next.steps=p.steps as TimelineItem["steps"];
        if (typeof p.before_tokens==="number") next.before_tokens=p.before_tokens;
        if (typeof p.after_tokens==="number") next.after_tokens=p.after_tokens;
        if (typeof p.before_estimated==="boolean") next.before_estimated=p.before_estimated;
        if (typeof p.estimated==="boolean") next.estimated=p.estimated;
        if (prev) Object.assign(prev,next); else {items.push(next);byId.set(id,next);} break;
      }
      case "tool_group": {
        const old=operations.get(id);
        if (old) {
          if (typeof p.output==="string") old.detail+=p.output;
          const finished=text(p.detail);
          if (finished && !old.detail.startsWith(finished)) old.detail=finished;
          if(p.status) old.status=text(p.status); break;
        }
        if (!p.label) break;
        const op={id,label:text(p.label),detail:text(p.detail),status:text(p.status)};operations.set(id,op);
        if (group?.text===op.label) group.operations!.push(op);
        else {group={kind:"tool_group",id,text:op.label,operations:[op]};items.push(group);}break;
      }
    }
  }
  return {answer:[...messages.values()].filter(Boolean).join("\n\n"),answerItems:[...messages].map(([id,text])=>({id,text})),items:items.filter(i=>i.text||i.steps?.length),debug,telemetry};
}
