import { useState } from "react";

const defaults = {debug:false,telemetry:true,expandTimeline:false};
type Preferences = typeof defaults;
export function usePreferences() {
  const [prefs,set] = useState<Preferences>(() => {
    const initial = {...defaults};
    try {
      const saved = JSON.parse(localStorage.getItem("codexdeck.preferences") ?? "{}");
      for (const key of Object.keys(initial) as (keyof Preferences)[]) if (typeof saved?.[key] === "boolean") initial[key]=saved[key];
    } catch { /* Invalid saved preferences fall back to the defaults. */ }
    return initial;
  });
  function update(next: Preferences) {
    set(next);
    localStorage.setItem("codexdeck.preferences",JSON.stringify(next));
  }
  return {prefs,update};
}
export function PreferenceControls({prefs,update,mode,onTheme}: ReturnType<typeof usePreferences>&{mode:string;onTheme:(v:string)=>void}) {
  return <section className="console-preferences"><h2>工作台显示</h2>
    <label>外观<select value={mode} onChange={e=>onTheme(e.target.value)} aria-label="外观主题">
      <option value="system">跟随系统</option><option value="light">亮色</option><option value="dark">暗色</option>
    </select></label>
    {([["telemetry","单轮性能与费用"],["expandTimeline","默认展开执行过程"],["debug","开发者原始 JSON 调试"]] as const).map(([key,label])=><label key={key}>
      {label}<input type="checkbox" checked={prefs[key]} onChange={e=>update({...prefs,[key]:e.target.checked})}/></label>)}
  </section>;
}
