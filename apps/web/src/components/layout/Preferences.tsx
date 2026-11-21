import {useEffect, useRef, useState} from "react";
import {workbenchPreferencesSchema, type WorkbenchPreferences} from "@codexdeck/shared";
import {api,json} from "../../lib/api";

export function usePreferences(enabled:boolean,onError:(err:unknown)=>void) {
  const [prefs,set]=useState<WorkbenchPreferences>(()=> {
    try { return workbenchPreferencesSchema.parse(JSON.parse(localStorage.getItem("codexdeck.preferences")??"{}")); }
    catch { return workbenchPreferencesSchema.parse({}); }
  });
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
        if(seq===revision.current) remember(next);
      } catch(err) {
        onError(err);
        if(seq===revision.current) remember(await api<WorkbenchPreferences>("/api/settings/preferences"));
      }
    }).catch(onError);
  }
  return {prefs,update};
}

export type PreferenceProps=ReturnType<typeof usePreferences>;
export function PreferenceControls({prefs,update}:PreferenceProps) {
  return <section className="ad-card settings-form"><h2>工作台显示</h2>
    <label>外观主题<select value={prefs.theme} onChange={e=>update({theme:e.target.value as WorkbenchPreferences["theme"]})}>
      <option value="system">跟随系统</option><option value="light">亮色</option><option value="dark">暗色</option>
    </select></label>
    {([["compactBubbles","紧凑气泡","缩小对话间距，在一屏中显示更多内容。"],["telemetry","单轮性能与费用","在每轮回答下显示用量和费用。"],
      ["expandTimeline","默认展开执行过程","打开会话时显示工具调用明细。"],["minimap","对话进度标尺","在对话左侧快速跳转到某轮。"],
      ["debug","开发者原始 JSON 调试","查看已经脱敏的协议事件。"]] as const).map(([key,label,hint])=>
      <label key={key}><span>{label}<small>{hint}</small></span><input aria-label={label} type="checkbox" checked={prefs[key]} onChange={e=>update({[key]:e.target.checked})}/></label>)}
    <label>发送快捷键<select value={prefs.sendShortcut} onChange={e=>update({sendShortcut:e.target.value as WorkbenchPreferences["sendShortcut"]})}><option value="enter">Enter</option><option value="ctrl_enter">Ctrl / ⌘ + Enter</option></select></label>
    <label>上下文提醒阈值（%）<input type="number" min={1} max={100} key={prefs.contextThreshold} defaultValue={prefs.contextThreshold} onBlur={e=>{if(e.target.value && e.target.validity.valid)update({contextThreshold:e.target.valueAsNumber});}}/></label>
  </section>;
}
