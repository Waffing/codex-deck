import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronUp, Hand, ShieldAlert, ShieldCheck, X } from "lucide-react";
import type {Workspace} from "@codexdeck/shared";

type Level=Workspace["automation_level"];
const modes=[
  {value:"conservative",label:"请求批准",description:"编辑外部文件、执行命令或联网时始终询问",Icon:Hand},
  {value:"semi",label:"帮我批准",description:"常规开发自动放行，仅对检测到的风险操作请求批准",Icon:ShieldCheck},
  {value:"unrestricted",label:"完全访问权限",description:"可访问服务器工作区与网络，全自动执行",Icon:ShieldAlert},
] as const;
export function PermissionPicker({value,disabled,onChange}:{value:Level;disabled?:boolean;onChange:(value:Level)=>void}){
  const trigger=useRef<HTMLButtonElement>(null),dialog=useRef<HTMLDialogElement>(null);
  const [open,setOpen]=useState(false),[help,setHelp]=useState(false),[confirm,setConfirm]=useState(false),[remember,setRemember]=useState(false);
  const current=modes.find(m=>m.value===value), Icon=current?.Icon??ShieldCheck;
  function close(){dialog.current?.close();setOpen(false);setHelp(false);setConfirm(false);}
  useEffect(()=>{
    const box=dialog.current,anchor=trigger.current;
    if(!open || !box || !anchor)return;
    function position(){
      const rect=anchor!.getBoundingClientRect();
      box!.style.setProperty("--approval-left",Math.max(12,Math.min(rect.left,window.innerWidth-392))+"px");
      box!.style.setProperty("--approval-bottom",Math.max(12,window.innerHeight-rect.top+8)+"px");
    }
    position();box.showModal();const selected=box.querySelector<HTMLButtonElement>('[aria-checked="true"]');
    selected?.focus({preventScroll:true});window.addEventListener("resize",position);
    return ()=>{window.removeEventListener("resize",position);if(box.open)box.close();};
  },[open]);
  function choose(level:Level){
    if(level==="unrestricted" && value!==level && localStorage.getItem("deck.full-consent")!=="yes" && !confirm){
      setConfirm(true);return;
    }
    if(level==="unrestricted" && confirm && remember)localStorage.setItem("deck.full-consent","yes");
    close();onChange(level);
  }
  function move(e:KeyboardEvent<HTMLDivElement>){
    if(e.key!=="ArrowUp" && e.key!=="ArrowDown")return;
    const options=Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="radio"]'));
    const index=options.indexOf(document.activeElement as HTMLButtonElement);
    options[(index+(e.key==="ArrowUp"?-1:1)+options.length)%options.length]?.focus();e.preventDefault();
  }
  return <>
    <button ref={trigger} type="button" className="cd-permission-trigger" data-full={value==="unrestricted"} aria-label={"工作区权限："+(current?.label??"工作区自动")} aria-expanded={open} aria-haspopup="dialog" disabled={disabled} onClick={()=>setOpen(true)}>
      <Icon size={14}/><span>{current?.label??"工作区自动"}</span><ChevronUp size={11}/>
    </button>
    {open && <dialog ref={dialog} className="cd-permission-sheet" aria-label="应如何批准 Codex 操作？" onCancel={close} onClick={e=>{if(e.target!==e.currentTarget)return;const r=e.currentTarget.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)close();}}>
      <header><strong>应如何批准 Codex 操作？</strong><button type="button" aria-expanded={help} onClick={()=>setHelp(!help)}>了解更多</button><button type="button" aria-label="关闭权限选择" onClick={close}><X size={16}/></button></header>
      {help && <p>选择将应用于此工作区后续运行的任务。Plan 模式使用只读环境。</p>}
      {value==="full" && <p>此项目沿用工作区自动权限，选择下方档位即可切换。</p>}
      {confirm ? <section className="cd-consent"><strong>启用完全访问权限？</strong><p>Codex 将在执行环境中自动修改文件、运行命令并访问网络。</p>
        <label><input type="checkbox" checked={remember} onChange={e=>setRemember(e.target.checked)}/>在此浏览器不再提示</label>
        <footer><button type="button" onClick={()=>setConfirm(false)}>返回</button><button type="button" onClick={()=>choose("unrestricted")}>确认启用</button></footer>
      </section> : <div role="radiogroup" aria-label="权限档位" onKeyDown={move}>
        {modes.map(({value:level,label,description,Icon:ModeIcon})=><button key={level} type="button" role="radio" aria-checked={value===level} data-full={level==="unrestricted"} onClick={()=>choose(level)}>
          <ModeIcon size={19}/><span><b>{label}</b><small>{description}</small></span>{value===level&&<Check size={16}/>}
        </button>)}
      </div>}
    </dialog>}
  </>;
}
