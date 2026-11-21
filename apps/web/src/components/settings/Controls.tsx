import { Children, isValidElement, useEffect, useId, useLayoutEffect, useRef, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { Minus, Plus } from "lucide-react";
import type { Workspace } from "@codexdeck/shared";
import { api } from "../../lib/api";

interface SwitchProps {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (next:boolean)=>void;
  name?: string;
  value?: string;
  disabled?: boolean;
  "aria-label"?: string;
}
export function ToggleSwitch({checked,defaultChecked=false,onCheckedChange,name,value="on",...button}:SwitchProps) {
  const [local,setLocal]=useState(defaultChecked);
  const active=checked??local;
  const ref=useRef<HTMLButtonElement>(null);
  useEffect(()=>{
    const form=ref.current?.form;
    const reset=()=>setLocal(defaultChecked);
    form?.addEventListener("reset",reset);
    return ()=>form?.removeEventListener("reset",reset);
  },[defaultChecked]);
  return <><button type="button" {...button} ref={ref} role="switch" aria-checked={active} className="cd-switch"
    onClick={()=>{setLocal(!active);onCheckedChange?.(!active);}}><span/></button>
    {name && active && <input type="hidden" name={name} value={value} disabled={button.disabled}/>}</>;
}

function optionLabel(children:ReactNode):string {
  return Children.toArray(children).map(item=>isValidElement<{children?:ReactNode}>(item)?optionLabel(item.props.children):String(item)).join("");
}
type Option={value?:string|number;children:ReactNode;disabled?:boolean};
interface ChoiceProps {
  value?:string|number;defaultValue?:string|number;name?:string;children:ReactNode;
  onValueChange?:(next:string)=>void;disabled?:boolean;"aria-label"?:string;
}
export function SegmentedControl({value,defaultValue,name,children,onValueChange,disabled,...aria}:ChoiceProps) {
  const options=Children.toArray(children).filter(isValidElement<Option>).map(child=>({
    label:child.props.children,value:String(child.props.value??child.props.children),disabled:child.props.disabled,
  }));
  const first=String(defaultValue??options[0]?.value??"");
  const [local,setLocal]=useState(first);
  const selected=String(value??local);
  const group=useRef<HTMLSpanElement>(null);
  useLayoutEffect(()=>{
    const el=group.current,active=el?.querySelector<HTMLButtonElement>('button[aria-checked="true"]');
    if(!el||!active)return;
    const measure=()=>{
      el.style.setProperty("--segment-x",active.offsetLeft+"px");el.style.setProperty("--segment-y",active.offsetTop+"px");
      el.style.setProperty("--segment-w",active.offsetWidth+"px");el.style.setProperty("--segment-h",active.offsetHeight+"px");
    };
    measure();
    const observer=new ResizeObserver(measure);observer.observe(el);observer.observe(active);return ()=>observer.disconnect();
  },[selected]);
  useLayoutEffect(()=>{
    const box=group.current,label=box?.closest("label");
    if(!box||!label||aria["aria-label"])return;
    const text=Array.from(label.childNodes).filter(n=>n!==box).map(n=>n.textContent).join(" ").trim();
    if(text)box.setAttribute("aria-label",text);
  },[aria["aria-label"]]);
  useEffect(()=>{
    const form=group.current?.closest("form"),reset=()=>setLocal(first);
    form?.addEventListener("reset",reset);
    return ()=>form?.removeEventListener("reset",reset);
  },[first]);
  function choose(next:string){setLocal(next);onValueChange?.(next);}
  return <span ref={group} role="radiogroup" {...aria} className="cd-segments" onKeyDown={event=>{
    const available=options.filter(o=>!o.disabled),i=available.findIndex(o=>o.value===selected);
    if(!available.length||disabled)return;
    let n:number;
    switch(event.key){case "ArrowLeft":case "ArrowUp":n=(i-1+available.length)%available.length;break;
      case "ArrowRight":case "ArrowDown":n=(i+1)%available.length;break;case "Home":n=0;break;
      case "End":n=available.length-1;break;default:return;}
    event.preventDefault(); const next=available[n].value;choose(next);
    Array.from(group.current?.querySelectorAll<HTMLButtonElement>("button")??[]).find(b=>b.value===next)?.focus();
  }}>{options.map(o=><button key={o.value} type="button" role="radio" aria-label={optionLabel(o.label)} aria-checked={selected===o.value} value={o.value}
      disabled={disabled||o.disabled} tabIndex={selected===o.value?0:-1} onClick={()=>choose(o.value)}>{o.label}</button>)}
    {name && <input type="hidden" name={name} value={selected} disabled={disabled}/>}</span>;
}

export function NumberControl(props:InputHTMLAttributes<HTMLInputElement>) {
  const input=useRef<HTMLInputElement>(null),id=useId();
  useLayoutEffect(()=>{
    const label=input.current?.closest("label");
    if(label && !label.htmlFor)label.htmlFor=props.id??id;
  },[id,props.id]);
  function step(direction:number) {
    const node=input.current;
    if(!node || node.disabled || node.readOnly)return;
    if(node.step==="any") {
      const old=node.valueAsNumber||0,increment=Number(node.min)>0?Math.min(1,Number(node.min)):1;
      const next=Math.min(node.max===""?Infinity:Number(node.max),Math.max(node.min===""?-Infinity:Number(node.min),old+direction*increment));
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(node,String(next));
    } else if(direction>0) node.stepUp(); else node.stepDown();
    node.dispatchEvent(new Event("input",{bubbles:true}));
    if(props.onBlur){node.focus();node.blur();}
  }
  return <span className="cd-stepper"><button type="button" aria-label="减少" disabled={props.disabled} onClick={()=>step(-1)}><Minus size={12}/></button>
    <input {...props} id={props.id??id} type="number" ref={input}/><button type="button" aria-label="增加" disabled={props.disabled} onClick={()=>step(1)}><Plus size={12}/></button></span>;
}

type Level=Workspace["automation_level"];
export function AutomationControl({label,value,onChange,disabled}:{label:string;value:Level;onChange:(v:Level)=>void;disabled?:boolean}) {
  return <SegmentedControl aria-label={label} value={value} disabled={disabled} onValueChange={v=>onChange(v as Level)}>
    <option value="conservative">保守</option><option value="semi">半自动</option><option value="full">全自动</option><option value="unrestricted">完全访问</option>
  </SegmentedControl>;
}

export function CapabilityNote() {
  const [note,setNote]=useState("");
  useEffect(()=>{let live=true;api<{isolated_executor:boolean;deployment:boolean}>("/api/runtime/capabilities")
    .then(v=>{if(live)setNote("隔离执行器"+(v.isolated_executor?"已启用":"不可用")+" · 业务部署"+(v.deployment?"可用":"未启用"));}).catch(()=>{});return ()=>{live=false;};},[]);
  return note?<small>{note}</small>:null;
}
