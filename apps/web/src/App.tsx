import {AppearanceContext} from "./components/layout/AppearanceContext";
import {useSkin} from "./components/layout/skin";
import {useActivityFeedback} from "./components/layout/feedback";
import "./components/settings/workshop.css";
import {useCallback,useEffect,useRef,useState} from "react";
import {Activity,ArrowRight,Bell,Box,Check,CircleDot,Command,FileCode2,FolderGit2,GitCompareArrows,KeyRound,Layers3,LayoutDashboard,LogOut,Menu,MessageSquare,Monitor,Moon,PanelLeftClose,PanelLeftOpen,Plus,Search,Server,Settings2,ShieldCheck,SlidersHorizontal,Sun,Terminal,WifiOff,X,ChevronDown,Files,Ellipsis} from "lucide-react";
import type {Thread,Workspace} from "@codexdeck/shared";
import {authorizeCache,closeCacheSession,sessionClosed} from "./lib/cache";
import {clearOutbox} from "./stores/outbox";
import {api,json} from "./lib/api";
import {connectEvents,clearRealtime,discardThrough,useRealtime} from "./stores/realtime";
import {Button} from "./components/ui/button";
import {ChatPane} from "./components/chat/ChatPane";
import {readPlaybooks} from "./components/chat/Playbooks";
import {ApprovalCard} from "./components/approval/ApprovalCard";
import {Onboarding} from "./components/onboarding/Onboarding";
import {AdminPages} from "./components/settings/AdminPages";
import {Panel,tabKey,type PanelTab} from "./components/layout/Panel";
import {CommandBar,type DeckCommand} from "./components/layout/CommandBar";
import {WorkspaceMenu} from "./components/layout/WorkspaceMenu";
import {ConversationList} from "./components/layout/ConversationList";
import {usePreferences} from "./components/layout/Preferences";
import {SettingsCenter} from "./components/settings/SettingsCenter";
import {GuestWorkbench} from "./components/GuestWorkbench";
import {SessionInspector} from "./components/layout/SessionInspector";
import type {ChatTurn} from "./components/chat/Timeline";
import type {ThreadEvent} from "@codexdeck/shared";
import {MobileOverview} from "./components/layout/MobileOverview";
import {useTheme,useSnapshot,readView,viewName,type View} from "./components/layout/session";
const navigation=[{view:"workbench",icon:LayoutDashboard},{view:"services",icon:Box},{view:"providers",icon:Layers3},{view:"open-api",icon:KeyRound},{view:"system",icon:SlidersHorizontal}] as const;
const mobileNav=[{view:"workbench",label:"工作台",icon:Terminal},{view:"approvals",label:"审批",icon:ShieldCheck},{view:"services",label:"服务",icon:Server},{view:"more",label:"更多",icon:Menu}] as const;
const noEvents:ThreadEvent[]=[];

function Wordmark(){return <div className="deck-wordmark"><span className="logo-tile"><Layers3 size={19} strokeWidth={2.3}/></span><strong>Codex<span>Deck</span></strong></div>;}
export default function App(){return location.pathname==="/guest" ? <GuestWorkbench/> : <AdminApp/>;}
function AdminApp(){
  const [gate,setGate]=useState<"loading"|"setup"|"ready">("loading"),[error,setError]=useState("");
  const [view,setView]=useState<View>(readView),[wsId,setWs]=useState(()=>localStorage.getItem("deck.workspace")??""),[thId,setTh]=useState(()=>localStorage.getItem("deck.thread")??"");
  const [menu,setMenu]=useState<"commands"|"workspaces"|"account"|"threads"|null>(null),[collapsed,setCollapsed]=useState(false);
  const [tabs,setTabs]=useState<PanelTab[]>([]),[selected,setSelected]=useState("");
  const [requesting,setRequesting]=useState(false);
  const [inspected,setInspected]=useState<ChatTurn>();
  const [infoOpen,setInfoOpen]=useState(()=>localStorage.getItem("deck.inspector")==="open");
  function toggleInfo(){setInfoOpen(!infoOpen);localStorage.setItem("deck.inspector",infoOpen?"closed":"open")}
  const live=useRealtime();
  const expire=useCallback((broadcast=true)=>{clearRealtime();clearOutbox();void closeCacheSession(broadcast);setGate("setup");},[]);
  useEffect(()=>{
    const close=(e:StorageEvent)=>{if(e.key===sessionClosed)expire(false);};
    window.addEventListener("storage",close);return ()=>window.removeEventListener("storage",close);
  },[expire]);
  const handleError=useCallback((e:unknown)=>{if((e as {status?:number})?.status===401){expire();return;}setError(e instanceof Error?e.message:"操作失败");},[expire]);
  const preferences=usePreferences(gate==="ready",handleError);
  const theme=useTheme(preferences.prefs.theme,theme=>preferences.update({theme}));
  const {data,reload,addThread}=useSnapshot(gate==="ready",handleError);
  const workspace=data.workspaces.find(w=>w.id===wsId)??data.workspaces[0]??null;
  useSkin(preferences.prefs,theme.dark);
  useActivityFeedback(gate==="ready",preferences.prefs,data.threads.some(t=>t.status==="running"),data.approvals.length>0);
  const threads=data.threads.filter(t=>t.workspace_id===workspace?.id);
  const thread=threads.find(t=>t.id===thId)??threads[0]??null;
  const count=live.approvals??data.approvals.length;
  const activeThread=thread?.id??"";
  const [subscription,setSubscription]=useState<{id:string;cursor:number}|null>(null);
  const snapshotReady=useCallback((id:string,cursor:number)=>{
    discardThrough(id,cursor);
    setSubscription(old=>old?.id===id?old:{id,cursor});
  },[]);
  const checkSession=useCallback(async ()=>{
    const s=await api<{authenticated:boolean;onboarding_completed:boolean;cache_scope:string|null}>("/api/auth/status");
    if(!s.authenticated || !s.cache_scope){expire();return;}
    await authorizeCache(s.cache_scope);
    setGate(s.onboarding_completed?"ready":"setup");
  },[expire]);
  useEffect(()=>{void checkSession().catch(handleError);},[checkSession,handleError]);
  const selectedSubscription=view==="workbench" && subscription?.id===activeThread?subscription:null;
  useEffect(()=>{
    if(gate!=="ready")return;
    return connectEvents(selectedSubscription?.id??"",()=>{void reload(["threads","approvals"]);},expire,selectedSubscription?.cursor??0,preferences.prefs.debug);
  },[gate,selectedSubscription,reload,expire,preferences.prefs.debug]);
  useEffect(()=>{if(subscription?.id!==activeThread)setSubscription(null);},[activeThread,subscription?.id]);
  useEffect(()=>{const pop=()=>{setView(readView());setMenu(null)};window.addEventListener("popstate",pop);return ()=>window.removeEventListener("popstate",pop);},[]);
  useEffect(()=>{const k=(e:KeyboardEvent)=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==="k"){e.preventDefault();setMenu(m=>m==="commands"?null:"commands");}if(e.key==="Escape")setMenu(null);};window.addEventListener("keydown",k);return ()=>window.removeEventListener("keydown",k);},[]);
  const seen=useRef(new Set<string>());
  useEffect(()=>{if(!data.approvals.length){document.title="CodexDeck";return;}
    document.title="[待审批] CodexDeck";
    const timer=setInterval(()=>{document.title=document.title.startsWith("[")?"CodexDeck":"[待审批] CodexDeck"},1400);
    for(const a of data.approvals) if(!seen.current.has(a.id)){seen.current.add(a.id);if("Notification" in window&&Notification.permission==="granted")try{new Notification("CodexDeck · 待审批",{body:a.action,tag:a.id})}catch{/* Browser may only permit mobile notifications through a service worker. */}}
    return ()=>{clearInterval(timer);document.title="CodexDeck";};
  },[data.approvals]);
  function go(v:View){setView(v);setMenu(null);history.pushState(null,"",v==="workbench"?"/":"/console/"+v);}
  const open=useCallback((t:PanelTab)=>{const key=tabKey(t);setTabs(old=>old.some(entry=>tabKey(entry)===key)?old:[...old,t]);setSelected(key);setMenu(null);},[]);
  function choose(w:Workspace){setWs(w.id);setTh("");localStorage.setItem("deck.workspace",w.id);localStorage.removeItem("deck.thread");setTabs([]);go("workbench");void reload();}
  function jump(t:Thread){if(t.workspace_id!==workspace?.id)setTabs([]);setWs(t.workspace_id??"");setTh(t.id);localStorage.setItem("deck.workspace",t.workspace_id??"");localStorage.setItem("deck.thread",t.id);go("workbench");}
  const creating=useRef(new Map<string,Promise<Thread>>());
  function newThread(){
    if(!workspace)return Promise.reject(new Error("请先创建工作区"));
    const id=workspace.id;
    const existing=creating.current.get(id);if(existing)return existing;
    const next=api<Thread>("/api/threads",json("POST",{workspace_id:id,title:"新会话"}))
      .then(t=>{addThread(t);jump(t);return t;}).finally(()=>creating.current.delete(id));
    creating.current.set(id,next);return next;
  }
  function act(f:()=>Promise<unknown>){if(requesting)return;setRequesting(true);void f().catch(handleError).finally(()=>setRequesting(false));}
  async function logout(){await api("/api/auth/logout",{method:"POST"});expire();setTabs([]);setMenu(null);setError("");}
  async function runPlaybook(prompt:string){
    go("workbench");
    const target=thread??await newThread();
    await api("/api/threads/"+target.id+(target.status==="running"?"/inject":"/messages"),json("POST",{prompt}));
    await reload();
  }
  function jumpApproval(){const t=data.threads.find(t=>t.id===data.approvals[0]?.thread_id);if(t)jump(t);else go("approvals");}
  const options:DeckCommand[]=[...navigation.map(n=>({category:"导航",label:viewName[n.view],run:()=>go(n.view)})),
    ...data.workspaces.map(w=>({category:"工作区",label:w.name,run:()=>choose(w)})),...data.threads.map(t=>({category:"会话",label:t.title,run:()=>jump(t)})),
    ...data.models.filter(m=>m.enabled&&data.providers.some(p=>p.id===m.provider_id&&p.enabled)).map(m=>({category:"切换模型",label:m.alias,run:()=>act(async()=>{const t=thread??await newThread();await api("/api/threads/"+t.id+"/model",json("PATCH",{model_alias:m.alias}));await reload();})})),
    ...(workspace?readPlaybooks(workspace.id).map(p=>({category:"快捷剧本",label:p.title,run:()=>act(()=>runPlaybook(p.prompt))})):[])];
  const pulse=live.heartbeat;
  const gatewayLabel=pulse?.gateway_state ? {unconfigured:"未配置",unverified:"待验证",stale:"验证已过期",verified:"可用",failed:"异常"}[pulse.gateway_state] : "等待心跳";
  const gatewayDetail=[gatewayLabel,pulse?.gateway_checked_at && new Date(pulse.gateway_checked_at).toLocaleString(),pulse?.gateway_error].filter(Boolean).join(" · ");
  const notifyButton=<button className="menu-line" onClick={()=>{setMenu(null);if("Notification" in window)void Notification.requestPermission().then(v=>setError(v==="granted"?"桌面通知已启用":"浏览器暂未允许通知"));else setError("此浏览器不支持桌面通知")}}><Bell size={14}/>启用桌面通知</button>;
  const accountActions=<>{notifyButton}<button className="menu-line" onClick={()=>{theme.system();setMenu(null)}}><Monitor size={14}/>跟随系统主题 {theme.mode==="system"&&<Check size={12}/>}</button><button className="menu-line" onClick={()=>act(logout)}><LogOut size={14}/>退出登录</button></>;
  const toast=error&&<div className="deck-toast" role="status">{error}<button aria-label="关闭提示" onClick={()=>setError("")}><X size={15}/></button></div>;
  if(gate!=="ready")return <>{gate==="loading"?<div className="deck-loading"><Wordmark/></div>:<Onboarding onComplete={show=>{void checkSession().catch(handleError);if(show)open({kind:"profile",title:"服务器体检"})}}/>}{toast}</>;
  return <AppearanceContext.Provider value={preferences}><div className={"deck "+(collapsed?"nav-collapsed":"")}>
    <header className="deck-top"><Wordmark/><i className="deck-sep"/><button className="workspace-switch" aria-expanded={menu==="workspaces"} onClick={()=>setMenu(menu==="workspaces"?null:"workspaces")}><FolderGit2 size={15}/><b>{workspace?.name??"选择工作区"}</b><ChevronDown size={13}/></button>
    <button className="health-pill" onClick={()=>open({kind:"profile",title:"服务器体检"})} aria-label="打开服务器体检" title={gatewayDetail}><i className={"status-dot "+(pulse?.gateway_healthy?"running":"idle")}/><span>网关{gatewayLabel}</span><i/><Activity size={13}/><span>CPU {pulse?.cpu_percent!=null?Math.round(pulse.cpu_percent)+"%":"—"}</span><span>内存 {pulse?Math.round((1-pulse.free_memory_bytes/pulse.total_memory_bytes)*100)+"%":"—"}</span><span>服务 {pulse?.running_services??"—"}</span></button>
    <div className="head-actions"><button className="command-trigger" onClick={()=>setMenu(menu==="commands"?null:"commands")} aria-label="全局命令面板"><Search size={14}/><span>搜索命令</span><kbd>⌘ K</kbd></button><button className={"deck-icon approvals-indicator "+(count?"has-pending":"")} onClick={jumpApproval} aria-label={"待审批 "+count}><Bell size={16}/>{count>0&&<b>{count}</b>}</button><button className="deck-icon" aria-label="切换主题" onClick={theme.toggle}>{theme.dark?<Sun size={16}/>:<Moon size={16}/>}</button><button className="account-trigger" title="管理员菜单" onClick={()=>setMenu(menu==="account"?null:"account")}>AD</button></div></header>
    {menu&&<button className="menu-dismiss" aria-label="收起菜单" onClick={()=>setMenu(null)}/>}
    {menu==="commands"&&<CommandBar items={options} close={()=>setMenu(null)}/>}
    {menu==="workspaces"&&<WorkspaceMenu workspaces={data.workspaces} selected={workspace?.id??""} choose={choose}/>}
    {menu==="account"&&<section className="deck-menu account-menu"><div className="menu-caption">管理员</div>{accountActions}</section>}
    {menu==="threads"&&<section className="deck-menu workspace-menu"><ConversationList threads={data.threads} workspaces={data.workspaces} activeId={activeThread} pending={new Set(data.approvals.map(a=>a.thread_id))} open={jump} create={()=>act(newThread)} refresh={reload} onError={handleError}/></section>}
    <div className="deck-body"><aside className="deck-sidebar"><div className="side-context"><span className="side-context-icon"><Terminal size={17}/></span><div><strong>{workspace?.name??"工作区"}</strong><small>Workspace</small></div><button className="deck-icon" title="折叠导航栏" onClick={()=>setCollapsed(!collapsed)}>{collapsed?<PanelLeftOpen size={15}/>:<PanelLeftClose size={15}/>}</button></div>
    <ConversationList threads={data.threads} workspaces={data.workspaces} activeId={activeThread} pending={new Set(data.approvals.map(a=>a.thread_id))} open={jump} create={()=>act(newThread)} refresh={reload} onError={handleError}/>
    <div className="side-label nav-label">控制台</div><nav className="desk-nav">{navigation.map(n=><button key={n.view} title={viewName[n.view]} aria-current={view===n.view?"page":undefined} onClick={()=>go(n.view)}><n.icon size={16}/><span>{viewName[n.view]}</span><i className="nav-tooltip" aria-hidden="true">{viewName[n.view]}</i></button>)}</nav>
    <div className="side-foot"><i className={"status-dot "+(live.state==="online"?"running":"idle")}/><span>{live.state==="online"?"实时连接":"正在连接"}</span><code>WS</code></div></aside>
    <main className="desk-main">
    <div className="desk-path"><div><Terminal size={14}/>{view==="workbench"&&<><span>{workspace?.name??"控制台"}</span><em>/</em></>}<strong>{viewName[view]}</strong></div>
    {view==="workbench"&&<div className="drawer-actions">{([{kind:"tree",title:"文件树",I:Files},{kind:"diff",title:"Git Diff",I:GitCompareArrows},{kind:"agents",title:"AGENTS.md",I:FileCode2}] as const).map(({kind,title,I})=><button key={kind} title={title} aria-label={title} onClick={()=>open({kind,title})}><I size={14}/><span>{title}</span></button>)}<button className="inspect-toggle" title="会话信息" aria-label="会话信息" aria-expanded={infoOpen} onClick={toggleInfo}><CircleDot size={14}/><span>会话信息</span></button><button className="mobile-thread" aria-label="选择会话" onClick={()=>setMenu("threads")}><MessageSquare size={16}/></button></div>}</div>
    {count>0&&view!=="approvals"&&<button className="pending-jump" onClick={jumpApproval}><ShieldCheck size={14}/>{count} 项操作等待审批 <ArrowRight size={14}/></button>}
    {live.state==="offline"&&<div className="ws-note"><WifiOff size={14}/>连接已断开，正在重连</div>}
    {view==="workbench"&&<><MobileOverview approvals={data.approvals} threads={data.threads} workspaces={data.workspaces} refresh={reload} jump={jump} open={open} thread={thread}/>{workspace?<ChatPane onSnapshot={snapshotReady} onInspect={setInspected} preferences={preferences.prefs} key={workspace.id} workspace={workspace} thread={thread} events={live.thread===activeThread?live.events:noEvents} models={data.models} providers={data.providers} approvals={data.approvals.filter(a=>a.thread_id===activeThread)} onCreateThread={newThread} onRefresh={reload} onOpen={open} mobileApprovalId={data.approvals[0]?.id}/>:<div className="deck-empty"><FolderGit2/><h2>创建工作区</h2><Button onClick={()=>setMenu("workspaces")}>选择或新建工作区</Button></div>}</>}
    {view==="approvals"&&<section className="standalone-page"><h1>待审批 <small>{data.approvals.length}</small></h1>{data.approvals.length?data.approvals.map(a=><ApprovalCard key={a.id} approval={a} workspaceName={data.workspaces.find(w=>w.id===data.threads.find(t=>t.id===a.thread_id)?.workspace_id)?.name??""} onResolved={reload}/>):<div className="deck-empty"><ShieldCheck/><p>当前没有待审批操作</p></div>}</section>}
    {view==="more"&&<section className="standalone-page"><h1>更多</h1>{navigation.slice(2).map(n=><button className="menu-line" key={n.view} onClick={()=>go(n.view)}><n.icon size={18}/>{viewName[n.view]}<ArrowRight size={14}/></button>)}<hr/>{accountActions}</section>}
    {view!=="workbench"&&view!=="approvals"&&view!=="more"&&<div className="admin-scroll">{view==="system"?<SettingsCenter {...preferences} workspaces={data.workspaces}/>:<AdminPages view={view} onChanged={reload} onDrawer={t=>open({kind:t.type,title:t.title,port:t.port,deploymentId:t.deploymentId})}/>}</div>}
    </main>{view==="workbench"&&infoOpen&&!tabs.length&&<SessionInspector turn={inspected} close={toggleInfo} open={open}/>}<Panel workspace={workspace} profile={data.profile} tabs={tabs} selected={selected} select={setSelected} open={open} close={key=>setTabs(old=>key?old.filter(t=>tabKey(t)!==key):[])}/></div>
    <nav className="deck-bottom">{mobileNav.map(n=><button key={n.view} aria-current={(view===n.view||(n.view==="more"&&["providers","system","open-api"].includes(view)))?"page":undefined} onClick={()=>go(n.view)}><n.icon size={19}/>{n.label}{n.view==="approvals"&&count>0&&<i/>}</button>)}</nav>{preferences.saved&&<div className="workshop-toast" role="status">已保存</div>}{toast}</div></AppearanceContext.Provider>;
}
