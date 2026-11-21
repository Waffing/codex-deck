import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { readPlaybooks } from "./Playbooks";

import {Archive, BookOpenText, ClipboardCheck, FileCode2, FileSearch, FolderGit2, GitFork, ListCollapse, MessageSquarePlus, Plug, Rocket, SquareTerminal, Trash2, type LucideIcon} from "lucide-react";
import type { McpEntry, PromptTemplate } from "@codexdeck/shared";

export type Choice = {label:string;value:string;description?:string;command?:string;Icon:LucideIcon;badge?:string;custom?:boolean};
const builtins:Choice[] = [
  {label:"MCP",value:"/mcp",description:"管理工具服务器",Icon:Plug},
  {label:"代码审查",value:"/review",description:"查看工作区差异并复审",Icon:ClipboardCheck},
  {label:"创建聊天分支",value:"/fork",description:"从当前会话继续",Icon:GitFork},
  {label:"初始化",value:"/init",description:"编辑项目 AGENTS.md",Icon:FileCode2},
  {label:"压缩",value:"/compact",description:"整理历史上下文",Icon:ListCollapse},
  {label:"新聊天",value:"/new",description:"在当前项目创建会话",Icon:MessageSquarePlus},
  {label:"提示词",value:"/prompts",description:"选择或管理提示词模板",Icon:BookOpenText},
  {label:"部署与测试",value:"/deploy",description:"打开部署服务与验收",Icon:Rocket},
  {label:"运行测试",value:"/test",description:"让 Codex 运行项目测试",Icon:SquareTerminal},
  {label:"归档",value:"/archive",description:"移入会话归档",Icon:Archive},
  {label:"永久删除聊天",value:"/delete",description:"删除本会话与聊天记录",Icon:Trash2},
];
function matches(choice:Choice,query:string) {
  const needle=query.toLowerCase(),source=[choice.label,choice.command,choice.description].join(" ").toLowerCase();
  if(source.includes(needle)) return true;
  let next=0;
  for(const char of source)if(char===needle[next] && ++next===needle.length)return true;
  return false;
}
export function useCompletions(workspaceId:string,draft:string,caret:number) {
  const token = /(?:^|\s)([/@])([^\s@/]*)$/.exec(draft.slice(0,caret))
    ?? /(?:^|\s)(@)([^\s@]*)$/.exec(draft.slice(0,caret));
  const kind = token?.[1], query = token?.[2] ?? "";
  const start = caret-query.length-1;
  const [dismissed,setDismissed]=useState<string|null>(null);
  const key = `${kind}:${start}:${query}`;
  const open=!!kind && key!==dismissed;
  const [files,setFiles]=useState<{key:string;values:string[];error:string}|null>(null);
  const [index,setIndex]=useState(0);
  useEffect(()=>{setIndex(0);if(!kind)setDismissed(null);},[key,kind]);
  useEffect(()=>{
    if(!open || kind!=="@")return;
    const controller=new AbortController();
    const timer=setTimeout(()=>void api<{files:string[]}>(`/api/workspaces/${workspaceId}/files/search?q=${encodeURIComponent(query)}`,{signal:controller.signal})
      .then(result=>{if(!controller.signal.aborted)setFiles({key,values:result.files,error:""});})
      .catch(e=>{if(!controller.signal.aborted)setFiles({key,values:[],error:(e as Error).message});}),120);
    return ()=>{clearTimeout(timer);controller.abort();};
  },[key,kind,open,workspaceId,query]);
  const [modules,setModules]=useState<{online?:number;prompts:PromptTemplate[]}>({prompts:[]});
  const slash=open && kind==="/";
  useEffect(()=>{
    if(!slash) return;
    const controller=new AbortController(),options={signal:controller.signal};
    void Promise.allSettled([api<McpEntry[]>("/api/mcp",options),api<PromptTemplate[]>("/api/prompts",options)] as const)
      .then(([servers,prompts])=>{
        if(!controller.signal.aborted)setModules({
          online:servers.status==="fulfilled"?servers.value.filter(m=>m.enabled && m.status==="online").length:undefined,
          prompts:prompts.status==="fulfilled"?prompts.value:[]
        });
      });
    return ()=>controller.abort();
  },[slash]);
  const options:Choice[]=kind==="@"?(files?.key===key?files.values:[]).map(value=>({value,label:value,Icon:FileSearch})):
    [...builtins.map(c=>({...c,command:c.value,badge:c.value==="/mcp" && modules.online!==undefined?modules.online+" 在线":undefined})),
     ...(slash?modules.prompts.map(p=>({label:p.name,value:p.content,command:"/"+p.name,description:"提示词模板",custom:true,Icon:BookOpenText})):[]),
     ...(slash?readPlaybooks(workspaceId).map(p=>({label:p.title,value:p.prompt,command:"/"+p.title,description:"项目指令",custom:true,Icon:FolderGit2})):[])]
     .filter(c=>matches(c,query));
  return {open,kind,options,index:Math.min(index,Math.max(0,options.length-1)),setIndex,start,
    close:()=>setDismissed(key),hint:kind==="@" && files?.key!==key?"正在搜索…":files?.key===key&&files.error?files.error:"没有匹配项"};
}
