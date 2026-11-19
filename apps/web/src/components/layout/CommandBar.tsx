import {useState} from "react";
import {CornerDownLeft,Command,Search,X} from "lucide-react";
export type DeckCommand={category:string;label:string;run:()=>void};
export function CommandBar({items,close}:{items:DeckCommand[];close:()=>void}){
  const [query,setQuery]=useState(""),[index,setIndex]=useState(0);
  const filtered=items.filter(x=>(x.category+x.label).toLowerCase().includes(query.toLowerCase())).slice(0,60);
  const choose=(item?:DeckCommand)=>{if(item){close();item.run();}};
  return <section className="deck-menu command-menu" aria-label="全局命令"><div className="command-input"><Search size={17}/><input autoFocus placeholder="查找工作区、会话、模型或剧本…" value={query} aria-label="搜索命令" onChange={e=>{setQuery(e.target.value);setIndex(0)}} onKeyDown={e=>{
    if(e.key==="Enter")choose(filtered[index]);if(e.key==="ArrowDown"){e.preventDefault();setIndex(Math.min(filtered.length-1,index+1))}
    if(e.key==="ArrowUp"){e.preventDefault();setIndex(Math.max(0,index-1))}if(e.key==="Escape")close();
  }}/><button aria-label="关闭命令面板" onClick={close}><X size={15}/></button></div>
  <div className="menu-options">{filtered.map((item,i)=><button key={item.category+":"+i} className={index===i?"selected":""} onMouseEnter={()=>setIndex(i)} onClick={()=>choose(item)}><Command size={14}/><span>{item.label}</span><small>{item.category}</small>{index===i&&<CornerDownLeft size={12}/>}</button>)}{!filtered.length&&<p>没有匹配的命令</p>}</div></section>
}
