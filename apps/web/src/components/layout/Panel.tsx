import {useState} from "react";
import {X,FileText,Activity,PanelRightClose,GripVertical} from "lucide-react";
import type {Workspace,ServerProfile} from "@codexdeck/shared";
import {DrawerContent,type DrawerTab} from "../files/DrawerContent";
import {Profile} from "./Profile";
export type PanelTab=DrawerTab|{kind:"profile";title:string};
export const tabKey=(t:PanelTab)=>JSON.stringify([t.kind,"path" in t?t.path:undefined,"deploymentId" in t?t.deploymentId:undefined,t.title]);
export function Panel({tabs,selected,select,close,workspace,profile,open}:{tabs:PanelTab[];selected:string;select:(key:string)=>void;close:(key?:string)=>void;workspace:Workspace|null;profile:ServerProfile|null;open:(t:PanelTab)=>void}){
  const [width,setWidth]=useState(()=>Number(localStorage.getItem("deck.panel"))||440);
  const tab=tabs.find(t=>tabKey(t)===selected)??tabs.at(-1);
  if(!tab)return null;
  function resize(x:number){const w=Math.round(Math.max(285,Math.min(window.innerWidth*.58,window.innerWidth-x)));setWidth(w);localStorage.setItem("deck.panel",String(w));}
  return <aside className="deck-drawer" style={{width}} aria-label="检查器"><div className="drawer-grip" role="separator" aria-label="调整抽屉宽度" tabIndex={0} onKeyDown={e=>{if(e.key==="ArrowLeft"||e.key==="ArrowRight")resize(innerWidth-width+(e.key==="ArrowLeft"?-20:20));}} onPointerDown={e=>{e.currentTarget.setPointerCapture(e.pointerId);}} onPointerMove={e=>{if(e.currentTarget.hasPointerCapture(e.pointerId))resize(e.clientX);}} onPointerUp={e=>e.currentTarget.releasePointerCapture(e.pointerId)}><GripVertical size={12}/></div>
    <div className="drawer-head"><span><PanelRightClose size={16}/> 检查器</span><button className="deck-icon" onClick={()=>close()} aria-label="关闭抽屉"><X size={16}/></button></div>
    <div className="drawer-tabs">{tabs.map(t=><div className={tabKey(t)===tabKey(tab)?"active":""} key={tabKey(t)}><button onClick={()=>select(tabKey(t))}>{t.kind==="profile"?<Activity size={13}/>:<FileText size={13}/>} {t.title}</button><button aria-label={"关闭 "+t.title} onClick={()=>close(tabKey(t))}><X size={11}/></button></div>)}</div>
    <div className="drawer-body">{tab.kind==="profile"?<Profile profile={profile}/>:workspace&&<DrawerContent workspace={workspace} tab={tab} onOpen={open}/>}</div>
  </aside>;
}
