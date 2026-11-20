import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { readPlaybooks } from "./Playbooks";

type Choice = {label:string; value:string};
const builtins:Choice[] = [
  {label:"/compact",value:"/compact"},
  {label:"/test",value:"检查项目测试脚本，运行相关测试并汇总结果。"},
  {label:"/deploy",value:"检查当前工作区的部署配置，按工作区审批策略执行预发布和验收。"},
  {label:"/review",value:"审查当前工作区改动，列出问题、文件位置和测试缺口。"},
];
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
  const options=kind==="@"?(files?.key===key?files.values:[]).map(value=>({value,label:value})):
    [...builtins,...(open?readPlaybooks(workspaceId).map(p=>({label:"/"+p.title,value:p.prompt})):[])]
    .filter(c=>c.label.toLowerCase().includes(query.toLowerCase()));
  return {open,kind,options,index:Math.min(index,Math.max(0,options.length-1)),setIndex,start,
    close:()=>setDismissed(key),hint:kind==="@" && files?.key!==key?"正在搜索…":files?.key===key&&files.error?files.error:"没有匹配项"};
}
