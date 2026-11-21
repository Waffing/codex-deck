import {useEffect, useRef, useState} from "react";
import {workbenchPreferencesSchema, type WorkbenchPreferences} from "@codexdeck/shared";
import {api,json} from "../../lib/api";

export function usePreferences(enabled:boolean,onError:(err:unknown)=>void) {
  const [prefs,set]=useState<WorkbenchPreferences>(()=> {
    try { return workbenchPreferencesSchema.parse(JSON.parse(localStorage.getItem("codexdeck.preferences")??"{}")); }
    catch { return workbenchPreferencesSchema.parse({}); }
  });
  const [saved,setSaved]=useState(false);
  const savedTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  useEffect(()=>()=>clearTimeout(savedTimer.current),[]);
  const pending=useRef(Promise.resolve()), revision=useRef(0);
  const remember=(next:WorkbenchPreferences)=>{set(next);localStorage.setItem("codexdeck.preferences",JSON.stringify(next));};
  useEffect(()=>{
    if (!enabled) return;
    let active=true;
    const reload=async()=>{
      await pending.current;
      const seq=revision.current;
      try {
        const data=await api<WorkbenchPreferences>("/api/settings/preferences");
        if(active && seq===revision.current) remember(data);
      } catch(err) { if(active) onError(err); }
    };
    void reload();
    window.addEventListener("focus",reload);
    const timer=setInterval(()=>{if(!document.hidden)void reload();},15000);
    return ()=>{active=false;clearInterval(timer);window.removeEventListener("focus",reload);};
  },[enabled,onError]);
  function update(patch:Partial<WorkbenchPreferences>) {
    const seq=++revision.current;
    set(current=>({...current,...patch}));
    pending.current=pending.current.then(async()=>{
      try {
        const next=await api<WorkbenchPreferences>("/api/settings/preferences",json("PATCH",patch));
        if(seq===revision.current){remember(next);setSaved(true);clearTimeout(savedTimer.current);savedTimer.current=setTimeout(()=>setSaved(false),1600);}
      } catch(err) {
        onError(err);
        if(seq===revision.current) remember(await api<WorkbenchPreferences>("/api/settings/preferences"));
      }
    }).catch(onError);
  }
  return {prefs,update,saved};
}

export type PreferenceProps=ReturnType<typeof usePreferences>;
export {AppearanceWorkshop as PreferenceControls} from "../settings/AppearanceWorkshop";
