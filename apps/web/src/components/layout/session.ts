import {useCallback,useEffect,useRef,useState} from "react";
import {type Approval,type Thread,type Model,type Provider,type Workspace,type ServerProfile} from "@codexdeck/shared";
import {api} from "../../lib/api";
export const views=["workbench","services","providers","open-api","system","approvals","more"] as const;
export type View=typeof views[number];
export const viewName:Record<View,string>={workbench:"工作台",services:"已部署服务",providers:"第三方 API 与模型","open-api":"Open API 与用量",system:"系统与通知",approvals:"待审批",more:"更多"};
export const readView=():View=>views.find(v=>v===location.pathname.split("/").filter(Boolean).at(-1))??"workbench";
export function useTheme(){
  const [mode,set]=useState(()=>localStorage.getItem("codexdeck.theme")??"system");
  const [dark,setDark]=useState(false);
  useEffect(()=>{const media=matchMedia("(prefers-color-scheme: dark)");const update=()=>{const d=mode==="system"?media.matches:mode==="dark";setDark(d);document.documentElement.dataset.theme=d?"dark":"light";};update();media.addEventListener("change",update);return ()=>media.removeEventListener("change",update);},[mode]);
  function select(next:string){if(next==="system")localStorage.removeItem("codexdeck.theme");else localStorage.setItem("codexdeck.theme",next);set(next);}
  return {dark,mode,select,toggle:()=>select(dark?"light":"dark"),system:()=>select("system")};
}
const initial={workspaces:[] as Workspace[],threads:[] as Thread[],models:[] as Model[],providers:[] as Provider[],approvals:[] as Approval[],profile:null as ServerProfile|null};
export function useSnapshot(enabled:boolean,onError:(e:unknown)=>void){
  const [data,set]=useState(initial);const rev=useRef(0);
  const reload=useCallback(async ()=>{
    if(!enabled)return;const id=++rev.current;
    try{
      const [workspaces,threads,models,providers,approvals,profile]=await Promise.all([api<Workspace[]>("/api/workspaces"),api<Thread[]>("/api/threads"),api<Model[]>("/api/models"),api<Provider[]>("/api/providers"),api<Approval[]>("/api/approvals"),api<ServerProfile>("/api/server/profile")]);
      if(id===rev.current)set({workspaces,threads,models,providers,approvals:approvals.filter(a=>a.status==="pending"),profile});
    }catch(e){if(id===rev.current)onError(e);}
  },[enabled,onError]);
  useEffect(()=>{if(enabled)void reload();else set(initial);return ()=>{rev.current++;};},[enabled,reload]);
  return {data,reload};
}
