import { useEffect, useRef, useState } from "react";
import mermaidUrl from "mermaid/dist/mermaid.min.js?url&no-inline";
import rendererUrl from "./diagram-renderer.js?url&no-inline";

function darkMode() {
  const theme = document.documentElement.dataset.theme;
  return theme ? theme === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function MermaidDiagram({ source }: { source: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(220);
  const [dark, setDark] = useState(darkMode);
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(darkMode()));
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setDark(darkMode());
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    media.addEventListener("change", update);
    function size(event: MessageEvent) {
      if (event.source === frame.current?.contentWindow && event.data?.type === "diagram-size" && Number.isFinite(event.data.height))
        setHeight(Math.min(1200, Math.max(80, event.data.height + 12)));
    }
    window.addEventListener("message", size);
    return () => { observer.disconnect(); media.removeEventListener("change", update); window.removeEventListener("message", size); };
  }, []);
  const library = new URL(mermaidUrl, location.origin).href;
  const renderer = new URL(rendererUrl, location.origin).href;
  const escaped = source.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const policy = `default-src 'none'; script-src ${library} ${renderer}; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'`;
  const html = `<!doctype html><html data-dark="${dark}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><style>body{margin:4px;color:${dark?"#e4e8e7":"#27332e"};font:14px system-ui,sans-serif}svg{max-width:100%;height:auto}pre{white-space:pre-wrap}</style></head><body><template>${escaped}</template><main>正在绘制图表…</main><script src="${library}"></script><script src="${renderer}"></script></body></html>`;
  return <iframe ref={frame} className="dv-diagram" title="Mermaid 图表" sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={html} style={{ height }} />;
}
