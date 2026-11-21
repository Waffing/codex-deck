import {useEffect,useState,type ReactNode} from "react";
import {Database,FileStack,Layout,Palette,Volume2,X} from "lucide-react";
import type {WorkbenchPreferences as Prefs} from "@codexdeck/shared";
import {clearLocalCache,setCacheEnabled,useCacheStats} from "../../lib/cache";
import {formatFileSize} from "../files/Artifacts";
import {previewSound} from "../layout/feedback";
import {ArtifactModeControl} from "../chat/TurnFiles";
import {NumberControl,SegmentedControl,ToggleSwitch} from "./Controls";

type Props={prefs:Prefs;update:(patch:Partial<Prefs>)=>void};
const skins=[
  {id:"white",name:"极简纯白",mode:"light"},{id:"obsidian",name:"曜石琥珀",mode:"dark"},
  {id:"pine",name:"午夜松林",mode:"dark"},{id:"paper",name:"暖纸阅读",mode:"light"},
] as const;
const swatches=["#19745E","#375F91","#654DB1","#9A522F","#B24768","#667C36"];
function Group({title,icon,children}:{title:string;icon:ReactNode;children:ReactNode}) {
  return <section className="ad-card settings-form workshop-group"><h2>{icon}{title}</h2>{children}</section>;
}
export function AppearanceWorkshop({prefs,update}:Props) {
  const [ext,setExt]=useState(""),[error,setError]=useState("");
  const [dark,setDark]=useState(()=>window.matchMedia?.("(prefers-color-scheme: dark)").matches??false);
  useEffect(()=>{
    const media=matchMedia("(prefers-color-scheme: dark)");
    const change=()=>setDark(media.matches);
    media.addEventListener("change",change);return ()=>media.removeEventListener("change",change);
  },[]);
  const current=(prefs.theme==="system"?dark:prefs.theme==="dark")?prefs.darkSkin:prefs.lightSkin;
  function addExt() {
    const val=ext.trim().toLowerCase().replace(/^\.?/,".");
    if(!/^\.[a-z0-9]+(?:\.[a-z0-9]+)*$/.test(val)||val.length>32){setError("输入有效的文件后缀，例如 .glb。");return;}
    if(!prefs.artifactExtensions.includes(val)){
      if(prefs.artifactExtensions.length>=100){setError("最多可保存 100 个后缀。");return;}
      update({artifactExtensions:[...prefs.artifactExtensions,val]});
    }
    setExt("");setError("");
  }
  return <>
    <Group title="皮肤工坊" icon={<Palette size={16}/>}>
      <label>外观主题<SegmentedControl aria-label="外观主题" value={prefs.theme} onValueChange={theme=>update({theme:theme as Prefs["theme"]})}>
        <option value="system">跟随系统</option><option value="light">亮色</option><option value="dark">暗色</option></SegmentedControl></label>
      <div className="skin-grid">{skins.map(s=><button key={s.id} type="button" aria-pressed={current===s.id} data-palette={s.id} onClick={()=>update(s.mode==="light"?{lightSkin:s.id,theme:"light"}:{darkSkin:s.id,theme:"dark"})}>
        <span className="skin-sample" aria-hidden="true"><i/><b/><em/></span>{s.name}</button>)}</div>
      <div className="workshop-row"><span>强调色</span><div className="color-swatches">{swatches.map(color=><button key={color} type="button" title={color} aria-label={"强调色 "+color} aria-pressed={prefs.accent===color} style={{backgroundColor:color}} onClick={()=>update({accent:color})}/>)}
        <input aria-label="自定义强调色" type="color" value={prefs.accent??"#19745e"} onChange={e=>update({accent:e.target.value})}/>
        <button className="text-reset" onClick={()=>update({accent:null})}>随皮肤</button></div></div>
      <label>正文字体<SegmentedControl value={prefs.bodyFont} onValueChange={v=>update({bodyFont:v as Prefs["bodyFont"]})}><option value="sans">无衬线</option><option value="serif">衬线</option><option value="system">系统字体</option></SegmentedControl></label>
      <label>代码字体<SegmentedControl value={prefs.codeFont} onValueChange={v=>update({codeFont:v as Prefs["codeFont"]})}><option value="plex">IBM Plex Mono</option><option value="consolas">Consolas</option><option value="system">系统等宽</option></SegmentedControl></label>
      <label>字号缩放<SegmentedControl value={prefs.fontScale} onValueChange={v=>update({fontScale:Number(v) as Prefs["fontScale"]})}><option value="95">紧凑 95%</option><option value="100">标准 100%</option><option value="108">舒适 108%</option></SegmentedControl></label>
      <label>侧边栏微磨砂<ToggleSwitch checked={prefs.frostedSidebar} onCheckedChange={frostedSidebar=>update({frostedSidebar})}/></label>
    </Group>
    <Group title="工作台显示" icon={<Layout size={16}/>}>
      {([["compactBubbles","紧凑气泡"],["telemetry","单轮性能与费用"],["expandTimeline","默认展开执行过程"],["minimap","对话进度标尺"],["debug","开发者原始 JSON 调试"]] as const).map(([key,name])=><label key={key}>{name}<ToggleSwitch aria-label={name} checked={prefs[key]} onCheckedChange={v=>update({[key]:v})}/></label>)}
      <label>发送快捷键<SegmentedControl value={prefs.sendShortcut} onValueChange={v=>update({sendShortcut:v as Prefs["sendShortcut"]})}><option value="enter">Enter</option><option value="ctrl_enter">Ctrl / ⌘ + Enter</option></SegmentedControl></label>
      <label>上下文提醒阈值（%）<NumberControl min={1} max={100} key={prefs.contextThreshold} defaultValue={prefs.contextThreshold} onBlur={e=>{if(e.target.value&&e.target.validity.valid)update({contextThreshold:e.target.valueAsNumber});}}/></label>
    </Group>
    <Group title="文件与交付物" icon={<FileStack size={16}/>}>
      <div className="workshop-row"><span>底部文件栏</span><ArtifactModeControl/></div>
      <div className="ext-tags">{prefs.artifactExtensions.map(s=><button key={s} aria-label={"移除 "+s} onClick={()=>update({artifactExtensions:prefs.artifactExtensions.filter(v=>v!==s)})}>{s}<X size={11}/></button>)}</div>
      <form className="ext-input" onSubmit={e=>{e.preventDefault();addExt();}}><input aria-label="新增交付物后缀" placeholder=".glb" maxLength={32} value={ext} onChange={e=>setExt(e.target.value)}/><button type="submit" className="ad-button">添加后缀</button></form>
    </Group>
    <Group title="提示音" icon={<Volume2 size={16}/>}>
      <label>声音风格<SegmentedControl value={prefs.soundStyle} onValueChange={v=>update({soundStyle:v as Prefs["soundStyle"]})}><option value="wood">柔和木琴</option><option value="tick">极简滴答</option><option value="mute">静音</option></SegmentedControl></label>
      {([["soundComplete","任务完成"],["soundApproval","等待审批"],["soundError","任务报错"]] as const).map(([key,label])=><label key={key}>{label}<ToggleSwitch checked={prefs[key]} onCheckedChange={v=>update({[key]:v})}/></label>)}
      <button className="ad-button" disabled={prefs.soundStyle==="mute"} onClick={()=>void previewSound(prefs.soundStyle).catch(()=>setError("此浏览器当前无法播放声音。"))}>试听</button>
    </Group>
    <CacheCard/>{error&&<p role="alert">{error}</p>}
  </>;
}
function CacheCard() {
  const {bytes,threads,enabled}=useCacheStats();
  const [message,setMessage]=useState("");
  async function action(work:Promise<void>,done:string){try{await work;setMessage(done);}catch{setMessage("无法修改本机缓存。");}}
  return <Group title="缓存与性能" icon={<Database size={16}/>}>
    <label>启用本地极速缓存<ToggleSwitch checked={enabled} onCheckedChange={v=>void action(setCacheEnabled(v),"已保存")}/></label>
    <div className="workshop-row"><span>{threads} 个会话 · {formatFileSize(bytes)}</span><button type="button" className="ad-button" onClick={()=>void action(clearLocalCache(),"本地缓存已清空")}>一键清空本地缓存</button></div>
    {message&&<small role="status">{message}</small>}
  </Group>;
}
