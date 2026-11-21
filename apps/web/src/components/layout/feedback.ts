import {useEffect,useRef,useState} from "react";
import type {WorkbenchPreferences} from "@codexdeck/shared";

type Kind="running"|"completed"|"approval"|"failed"|"cancelled";
interface Activity {thread_id:string;task_id:string|null;seq_id:number;kind:Kind}
let audio:AudioContext|undefined;
function audioContext(){return audio??=new AudioContext();}
export async function previewSound(style:WorkbenchPreferences["soundStyle"],kind:Kind="completed") {
  if(style==="mute"||!("AudioContext" in window))return;
  const context=audioContext();
  if(context.state!=="running")await context.resume();
  const notes=kind==="failed"?[392,294]:kind==="approval"?[523,659]:[659,880];
  for(const [i,note] of (style==="tick"?notes.slice(0,1):notes).entries()){
    const tone=context.createOscillator(),gain=context.createGain(),at=context.currentTime+i*.10;
    tone.type=style==="tick"?"sine":"triangle";tone.frequency.value=note;
    const end=at+(style==="tick"?.075:.22);
    gain.gain.setValueAtTime(.0001,at);gain.gain.exponentialRampToValueAtTime(.041,at+.008);
    gain.gain.exponentialRampToValueAtTime(.0001,end);
    tone.connect(gain);gain.connect(context.destination);tone.start(at);tone.stop(end);
    tone.onended=()=>{tone.disconnect();gain.disconnect();};
  }
}

export function useActivityFeedback(enabled:boolean,prefs:WorkbenchPreferences,running:boolean,approval:boolean) {
  const [failed,setFailed]=useState(false);
  const latest=useRef(prefs);latest.current=prefs;
  useEffect(()=>{
    if(!enabled)return;
    const seen=new Map<string,number>();
    const unlock=()=>{if(latest.current.soundStyle!=="mute" && "AudioContext" in window)void audioContext().resume().catch(()=>{});};
    const event=(e:Event)=>{
      const a=(e as CustomEvent<Activity>).detail;
      if(!a || !Number.isSafeInteger(a.seq_id) || a.seq_id<=(seen.get(a.thread_id)??0))return;
      seen.set(a.thread_id,a.seq_id);
      if(a.kind==="running" || a.kind==="completed")setFailed(false);
      if(a.kind==="failed")setFailed(true);
      const p=latest.current;
      if(audio?.state==="running" && (a.kind==="completed"&&p.soundComplete || a.kind==="approval"&&p.soundApproval || a.kind==="failed"&&p.soundError))
        void previewSound(p.soundStyle,a.kind).catch(()=>{});
    };
    window.addEventListener("pointerdown",unlock);window.addEventListener("keydown",unlock);window.addEventListener("codexdeck:activity",event);
    return ()=>{window.removeEventListener("pointerdown",unlock);window.removeEventListener("keydown",unlock);window.removeEventListener("codexdeck:activity",event);};
  },[enabled]);
  useEffect(()=>{
    const icon=document.querySelector<HTMLLinkElement>("link[rel=icon]");if(!icon||!enabled)return;
    const old=icon.href,state=approval?"approval":failed?"failed":running?"running":"idle";
    icon.dataset.state=state;
    let frame=false;
    const paint=()=>{
      const dot=state==="idle"?"":`<circle cx="25" cy="7" r="${frame?4.5:5.5}" stroke="#17202a" stroke-width="2" fill="${state==="approval"?"#ffba4d":state==="failed"?"#ff6e70":"#64d7ae"}"/>`;
      icon.href="data:image/svg+xml,"+encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#151b20"/><path d="m7 9 8 7-8 7m11-1h7" fill="none" stroke="#8ee3ce" stroke-width="3"/>${dot}</svg>`);frame=!frame;
    };
    paint();const id=state==="running"&&!matchMedia("(prefers-reduced-motion: reduce)").matches?setInterval(paint,1000):undefined;
    return ()=>{clearInterval(id);icon.href=old;delete icon.dataset.state;};
  },[enabled,approval,running,failed]);
}
