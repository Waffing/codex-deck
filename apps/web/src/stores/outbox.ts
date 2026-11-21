import {create} from "zustand";
import type {Thread} from "@codexdeck/shared";
import {api,json} from "../lib/api";

export type Outgoing = {id:string; workspace:string; thread:string|null; prompt:string; imageIds:string[]; mode?:"execute"|"plan";
  state:"sending"|"sent"|"failed"; taskId?:string; error?:string};
export const useOutbox=create<{messages:Outgoing[]}>(()=>({messages:[]}));
const update=(id:string,patch:Partial<Outgoing>)=>useOutbox.setState(s=>({messages:s.messages.map(m=>m.id===id?{...m,...patch}:m)}));
export function clearOutbox(){useOutbox.setState({messages:[]});}
export function discard(ids:Set<string>){
  if(useOutbox.getState().messages.some(m=>ids.has(m.id)))useOutbox.setState(s=>({messages:s.messages.filter(m=>!ids.has(m.id))}));
}
export function queueMessage(workspace:string,thread:string|null,prompt:string,imageIds:string[],mode?:"execute"|"plan"){
  const message:Outgoing={id:crypto.randomUUID(),workspace,thread,prompt,imageIds,mode,state:"sending"};
  useOutbox.setState(s=>({messages:[...s.messages,message]}));
  return message;
}
export async function deliver(message:Outgoing,create:()=>Promise<Thread>,onRefresh:()=>void) {
  update(message.id,{state:"sending",error:undefined});
  try{
    const thread=message.thread??(await create()).id;
    if(!useOutbox.getState().messages.some(m=>m.id===message.id))return;
    update(message.id,{thread});
    const result=await api<{task_id:string}>("/api/threads/"+thread+"/messages",json("POST",{
      prompt:message.prompt,image_ids:message.imageIds,mode:message.mode,client_msg_id:message.id
    }));
    update(message.id,{taskId:result.task_id,state:"sent"});
    onRefresh();
  }catch(e){
    update(message.id,{state:"failed",error:(e as Error).message});
    if((e as {code?:string}).code==="EXECUTOR_UNAVAILABLE")return (e as Error).message;
  }
}
