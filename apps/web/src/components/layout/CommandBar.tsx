import {Fragment,useEffect,useRef,useState} from "react";
import type {GlobalSearchHit,SearchResults} from "@codexdeck/shared";
import {api} from "../../lib/api";
import "./search.css";
import {CornerDownLeft,Command,Search,X} from "lucide-react";
export type DeckCommand={category:string;label:string;run:()=>void};
type Option = DeckCommand & { hit?: GlobalSearchHit };

export function CommandBar({items,close,onHit}:{items:DeckCommand[];close:()=>void;onHit:(hit:GlobalSearchHit)=>void}){
  const [query,setQuery]=useState(""),[index,setIndex]=useState(0);
  const [results,setResults]=useState<SearchResults>(),[error,setError]=useState("");
  const [loading,setLoading]=useState(false);
  const dialog=useRef<HTMLElement>(null);
  const menu=useRef<HTMLDivElement>(null);
  const returnFocus=useRef<HTMLElement|null>(document.activeElement instanceof HTMLElement?document.activeElement:null);
  useEffect(()=>{
    dialog.current?.querySelector<HTMLInputElement>(".command-input input")?.focus();
    return ()=>{const target=returnFocus.current;if(target?.isConnected)target.focus();};
  },[]);
  useEffect(()=>{
    const term=query.trim(), abort=new AbortController();
    setResults(undefined);setError("");setLoading(!!term);
    if(!term)return;
    let timer: ReturnType<typeof setTimeout>;
    async function search(){
      try {
        const result=await api<SearchResults>("/api/search?q="+encodeURIComponent(term),{signal:abort.signal});
        if(abort.signal.aborted)return;
        setResults(result);setLoading(false);
        if(result.indexing)timer=setTimeout(()=>void search(),600);
      }catch(cause){if(!abort.signal.aborted){setLoading(false);setError((cause as Error).message);}}
    }
    timer=setTimeout(()=>void search(),160);
    return ()=>{abort.abort();clearTimeout(timer);};
  },[query]);

  const options:Option[]=[];
  for(const [group,label] of [["messages","对话消息"],["artifacts","成品文件"],["deployments","部署服务"]] as const){
    for(const hit of results?.[group]??[])options.push({category:label,label:hit.title,hit,run:()=>onHit(hit)});
  }
  const local=items.filter(x=>(x.category+x.label).toLowerCase().includes(query.trim().toLowerCase())).slice(0,60);
  for(const item of local)options.push({...item,category:"工作区与快捷操作"});
  const choose=(item?:Option)=>{if(item){close();item.run();}};
  const active=Math.max(0,Math.min(index,options.length-1));
  useEffect(()=>{menu.current?.querySelector("button.selected")?.scrollIntoView({block:"nearest"});},[index]);
  return <section ref={dialog} className="deck-menu command-menu" role="dialog" aria-modal="true" aria-label="全局命令面板" tabIndex={-1} onKeyDown={e=>{
    if(e.key!=="Tab")return;
    const focusable=Array.from(dialog.current?.querySelectorAll<HTMLElement>("input:not([disabled]),button:not([disabled])")??[]).filter(el=>el.getClientRects().length>0);
    const first=focusable[0],last=focusable.at(-1);
    if(!first||!last){e.preventDefault();dialog.current?.focus();return;}
    if(!dialog.current?.contains(document.activeElement)){e.preventDefault();(e.shiftKey?last:first).focus();}
    else if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}
    else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
  }}>
    <div className="command-input"><Search size={17}/><input autoFocus placeholder="查找消息、成品、工作区或命令…" value={query}
      aria-label="搜索命令" maxLength={160} onChange={e=>{setQuery(e.target.value);setIndex(0);}} onKeyDown={e=>{
        if(e.nativeEvent.isComposing)return;
        if(e.key==="Enter"){e.preventDefault();choose(options[active]);}
        if(e.key==="ArrowDown"){e.preventDefault();setIndex(Math.min(options.length-1,active+1));}
        if(e.key==="ArrowUp"){e.preventDefault();setIndex(Math.max(0,active-1));}
        if(e.key==="Escape")close();
      }}/><button aria-label="关闭命令面板" onClick={close}><X size={15}/></button></div>
    <div ref={menu} className="menu-options search-options">
      {options.map((option,i)=><Fragment key={option.hit?.entity_id+":"+i}>
        {option.category!==options[i-1]?.category&&<h3>{option.category}</h3>}
        <button className={active===i?"selected":""} onMouseEnter={()=>setIndex(i)} onClick={()=>choose(option)}>
          {option.hit?<Search size={14}/>:<Command size={14}/>}
          <span className="search-label"><span>{option.label}</span>{option.hit&&<small>
            {option.hit.snippet.map((part,n)=>part.match?<mark key={n}>{part.text}</mark>:<Fragment key={n}>{part.text}</Fragment>)}
          </small>}</span>{option.hit?.turn_index!=null&&<small>第 {option.hit.turn_index} 轮</small>}
          {active===i&&<CornerDownLeft size={12}/>}</button></Fragment>)}
      {error&&<p role="alert">{error}</p>}
      {loading&&<p role="status">正在搜索…</p>}
      {!loading&&results?.indexing&&<p role="status">正在整理历史索引…</p>}
      {!options.length&&!loading&&!error&&<p>没有匹配的结果</p>}
    </div></section>;
}
