import {useEffect,useState} from "react";
import {api,json} from "../../lib/api";
import {Feedback,useAction} from "./common";

const labels={docker:"独立 Docker 容器",native:"原生 Linux 沙箱",container_sandbox:"当前容器内沙箱",unavailable:"不可用"};
type Status={strategy:keyof typeof labels;configured_image:string;image:string|null;detail:string};
export function ExecutionEnvironment() {
  const [status,setStatus]=useState<Status>(),[image,setImage]=useState(""),[loading,setLoading]=useState(true);
  const action=useAction();
  useEffect(()=>{
    const controller=new AbortController();
    api<Status>("/api/settings/executor",{signal:controller.signal})
      .then(value=>{if(!controller.signal.aborted){setStatus(value);setImage(value.configured_image);}})
      .catch(error=>{if(!controller.signal.aborted)action.setError(error.message);})
      .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return ()=>controller.abort();
  },[]);
  return <section className="ad-card settings-form"><h2>执行环境</h2>
    <dl><dt>运行策略</dt><dd>{status?labels[status.strategy]:loading?"正在探测…":"未知"}</dd>
      {status?.image&&<><dt>实际执行镜像</dt><dd><code>{status.image}</code></dd></>}
    </dl>
    {status&&<small>{status.detail}</small>}
    <label>指定执行镜像<input value={image} disabled={action.busy||loading} placeholder="留空使用部署默认值" onChange={e=>setImage(e.target.value)}/></label>
    <div className="ad-actions"><button className="ad-button" disabled={action.busy||loading} onClick={()=>action.run(async()=>{
      setStatus(await api<Status>("/api/settings/executor/detect",json("POST",{})));
    })}>一键探测</button>
    <button className="ad-button primary" disabled={action.busy||loading||image===(status?.configured_image??"")} onClick={()=>action.run(async()=>{
      const result=await api<Status>("/api/settings/executor",json("PATCH",{image:image.trim()}));
      setStatus(result);setImage(result.configured_image);
    },"已保存执行镜像")}>保存镜像</button></div>
    <Feedback {...action}/></section>;
}
