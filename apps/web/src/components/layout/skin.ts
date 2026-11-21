import {useLayoutEffect} from "react";
import type {WorkbenchPreferences} from "@codexdeck/shared";

export function useSkin(prefs:WorkbenchPreferences,dark:boolean) {
  useLayoutEffect(()=>{
    const root=document.documentElement;
    root.dataset.skin=dark?prefs.darkSkin:prefs.lightSkin;
    root.dataset.frosted=String(prefs.frostedSidebar);root.dataset.bodyFont=prefs.bodyFont;root.dataset.codeFont=prefs.codeFont;
    root.style.setProperty("--deck-scale",String(prefs.fontScale/100));
    if(prefs.accent) {
      root.style.setProperty("--accent",prefs.accent);
      const [r,g,b]=[1,3,5].map(i=>{const s=parseInt(prefs.accent!.slice(i,i+2),16)/255;return s<=.04045?s/12.92:((s+.055)/1.055)**2.4;});
      root.style.setProperty("--accent-fg",.2126*r+.7152*g+.0722*b>.18?"#111111":"#ffffff");
    } else {root.style.removeProperty("--accent");root.style.removeProperty("--accent-fg");}
  },[prefs,dark]);
}
