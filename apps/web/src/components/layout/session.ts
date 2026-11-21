import {useCallback,useEffect,useRef,useState} from "react";
import {type Approval,type Thread,type Model,type Provider,type Workspace,type ServerProfile} from "@codexdeck/shared";
import {cached,cachePut,cacheTicket} from "../../lib/cache";
import {api} from "../../lib/api";
export const views=["workbench","services","providers","open-api","system","approvals","more"] as const;
export type View=typeof views[number];
export const viewName:Record<View,string>={workbench:"工作台",services:"已部署服务",providers:"第三方 API 与模型","open-api":"Open API 与用量",system:"系统与通知",approvals:"待审批",more:"更多"};
export const readView=():View=>views.find(v=>v===location.pathname.split("/").filter(Boolean).at(-1))??"workbench";
export function useTheme(mode:"system"|"dark"|"light",set:(v:"system"|"dark"|"light")=>void){
  const [dark,setDark]=useState(false);
  useEffect(()=>{const media=matchMedia("(prefers-color-scheme: dark)");const update=()=>{const d=mode==="system"?media.matches:mode==="dark";setDark(d);document.documentElement.dataset.theme=d?"dark":"light";};update();media.addEventListener("change",update);return ()=>media.removeEventListener("change",update);},[mode]);
  function select(next:"system"|"dark"|"light"){if(next==="system")localStorage.removeItem("codexdeck.theme");else localStorage.setItem("codexdeck.theme",next);set(next);}
  return {dark,mode,select,toggle:()=>select(dark?"light":"dark"),system:()=>select("system")};
}
const initial={workspaces:[] as Workspace[],threads:[] as Thread[],models:[] as Model[],providers:[] as Provider[],approvals:[] as Approval[],profile:null as ServerProfile|null};
export function useSnapshot(enabled:boolean,onError:(e:unknown)=>void){
  const [data,set]=useState(initial);
  const revisions=useRef(0);
  const reload=useCallback(async (sections?:Array<keyof typeof initial>)=>{
    if(!enabled)return;
    const revision=revisions.current;
    const ticket=cacheTicket();
    const urls={workspaces:"/api/workspaces",threads:"/api/threads",models:"/api/models",providers:"/api/providers",approvals:"/api/approvals",profile:"/api/server/profile"};
    async function load<K extends keyof typeof initial>(key:K) {
      try {
        const value=await api<typeof initial[K]>(urls[key]);
        if(revision!==revisions.current || latest.current[key]!==loadId)return;
        const result=key==="approvals"?(value as Approval[]).filter(a=>a.status==="pending"):value;
        if(key!=="approvals" && key!=="profile")cachePut(key,result,ticket);
        set(old=>({...old,[key]:result}));
      }catch(e){if(revision===revisions.current && latest.current[key]===loadId)onError(e);}
    }
    const keys=sections??Object.keys(urls) as (keyof typeof initial)[];
    const loadId=++counter.current;
    for(const key of keys)latest.current[key]=loadId;
    await Promise.all(keys.map(load));
  },[enabled,onError]);
  const latest=useRef<Partial<Record<keyof typeof initial,number>>>({});
  const counter=useRef(0);
  useEffect(()=>{
    if(enabled){
      set({...initial,workspaces:cached<Workspace[]>("workspaces")??[],threads:cached<Thread[]>("threads")??[],
        providers:cached<Provider[]>("providers")??[],models:cached<Model[]>("models")??[]});
      void reload();
    }else set(initial);
    return ()=>{revisions.current++;};
  },[enabled,reload]);
  function addThread(thread:Thread){set(previous=>({...previous,threads:[thread,...previous.threads.filter(t=>t.id!==thread.id)]}));}
  return {data,reload,addThread};
}
