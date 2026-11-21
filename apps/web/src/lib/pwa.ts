import {useSyncExternalStore} from "react";

interface InstallPrompt extends Event {
  prompt:()=>Promise<void>;
  userChoice:Promise<{outcome:"accepted"|"dismissed"}>;
}
let pending:InstallPrompt|undefined;
let installed=false;
const listeners=new Set<()=>void>();
const notify=()=>listeners.forEach(fn=>fn());
const subscribe=(fn:()=>void)=>{listeners.add(fn);return ()=>{listeners.delete(fn);};};
const display=()=>window.matchMedia?.("(display-mode: standalone)");
const status=()=>installed || display()?.matches || (navigator as Navigator & {standalone?:boolean}).standalone?"installed":pending?"available":"manual";

export function registerPwa(){
  display()?.addEventListener("change",notify);
  window.addEventListener("beforeinstallprompt",event=>{
    event.preventDefault();pending=event as InstallPrompt;notify();
  });
  window.addEventListener("appinstalled",()=>{installed=true;pending=undefined;notify();});
  if(import.meta.env.PROD && window.isSecureContext && "serviceWorker" in navigator){
    void navigator.serviceWorker.register("/sw.js",{scope:"/",updateViaCache:"none"}).catch(()=>{ /* Browser settings can disable service workers. */ });
  }
}
export function useInstallState(){return useSyncExternalStore(subscribe,status);}
export async function requestInstall(){
  const prompt=pending;
  if(!prompt)return;
  pending=undefined;notify();
  await prompt.prompt();
  await prompt.userChoice;
}
