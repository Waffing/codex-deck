import {useEffect,useState} from "react";
import {createRoot} from "react-dom/client";
import {FileText, LockKeyhole} from "lucide-react";
import type {ShareReaderState} from "@codexdeck/shared";
import {DocumentViewer} from "./components/files/DocumentViewer";
import {api,json} from "./lib/api";
import "./components/files/share.css";

function SharePage() {
  const [state,setState]=useState<ShareReaderState>();
  const [busy,setBusy]=useState(false),[error,setError]=useState("");
  const slug=location.pathname.split("/")[2];
  const base="/api/public/shares/"+encodeURIComponent(slug);
  async function verify(passcode?:string) {
    setBusy(true);setError("");
    try {setState(await api<ShareReaderState>(base+"/verify",json("POST",passcode===undefined?{}:{passcode})));}
    catch(e) {setError(e instanceof Error?e.message:"加载分享失败，请重试。");}
    finally {setBusy(false);}
  }
  useEffect(()=>{void verify();},[base]);
  useEffect(()=>{
    const media=matchMedia("(prefers-color-scheme: dark)");
    const apply=()=>{document.documentElement.dataset.theme=media.matches?"dark":"light";};
    apply();media.addEventListener("change",apply);
    return ()=>media.removeEventListener("change",apply);
  },[]);
  return <main className="public-document">
    <header className="public-masthead"><span><FileText size={18}/> CodexDeck</span><span>成品分享</span></header>
    {state?.state==="ready"?<article><header><h1>{state.title}</h1><p>{new Date(state.expires_at).toLocaleString()} 到期</p></header>
      <DocumentViewer name={state.name} size={state.size} contentUrl={base+"/content"} downloadUrl={state.allow_download?base+"/download":undefined}/></article>:
    <section className="share-cover">{state?.state==="locked"?<form onSubmit={e=>{e.preventDefault();void verify(String(new FormData(e.currentTarget).get("code")));}}>
      <LockKeyhole size={27}/><h1>输入提取码</h1><label>提取码<input type="password" name="code" autoFocus required maxLength={64} autoComplete="off"/></label>
      {error&&<p role="alert">{error}</p>}<button disabled={busy}>查看成品</button></form>:
      state?.state==="unavailable"?<><FileText size={27}/><h1>分享已失效</h1><p>请联系分享者获取有效链接。</p></>:
      <><p role="status">{error || "正在打开分享…"}</p>{error&&<button onClick={()=>void verify()}>重试</button>}</>}</section>}
  </main>;
}
createRoot(document.getElementById("root")!).render(<SharePage/>);
