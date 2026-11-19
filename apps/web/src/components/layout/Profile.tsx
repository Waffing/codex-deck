import type {ServerProfile} from "@codexdeck/shared";
import {Cpu,HardDrive,MemoryStick,Network} from "lucide-react";
export function Profile({profile:p}:{profile:ServerProfile|null}){
  if(!p)return <p className="deck-empty">正在读取服务器体检报告…</p>;
  const gb=(n:number)=>(n/2**30).toFixed(1)+" GB";
  return <section className="profile-view"><div className="profile-title"><Cpu/><div><small>HOST PROFILE</small><h2>服务器体检</h2></div></div>
    <p>{p.os}</p><div className="profile-facts">{[[Cpu,"处理器",p.cpu_count+" 核"],[MemoryStick,"可用内存",gb(p.free_memory)],[HardDrive,"磁盘剩余",gb(p.disk_free)],[Network,"安全端口池",p.safe_pool.join(" – ")]].map(([I,k,v])=>{const Icon=I as typeof Cpu;return <div key={String(k)}><Icon size={17}/><span>{String(k)}</span><strong>{String(v)}</strong></div>})}</div>
    <h3>运行时</h3><dl>{Object.entries(p.runtimes).map(([name,v])=><div key={name}><dt>{name}</dt><dd>{v??"未检测到"}</dd></div>)}</dl>
    <details><summary>已占用端口 · {p.occupied_ports.length}</summary><code>{p.occupied_ports.join(" · ")||"无"}</code></details>
    <details><summary>可用端口 · {p.available_ports.length}</summary><pre>{p.available_ports.join(" · ")}</pre></details></section>
}
