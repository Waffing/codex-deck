import { useEffect, useRef, useState } from "react";
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type RenderTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = workerUrl;

export default function PdfPage({ bytes }: { bytes: ArrayBuffer }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [document, setDocument] = useState<PDFDocumentProxy>();
  const [page, go] = useState(1);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const task = getDocument({ data: bytes.slice(0), useWorkerFetch: false, useWasm: false, maxImageSize: 16_000_000, enableXfa: false });
    void task.promise.then(pdf => { if (active) setDocument(pdf); }, () => { if (active) setError("此 PDF 已损坏或需要密码。"); });
    return () => { active = false; void task.destroy().catch(()=>{}); };
  }, [bytes]);
  useEffect(() => {
    if (!document || !canvas.current) return;
    let active = true;
    let render: RenderTask | undefined;
    const target = canvas.current;
    void document.getPage(page).then(async sheet => {
      if (!active) return;
      const bounds = sheet.getViewport({ scale: 1 });
      const scale = Math.min(2, 1600 / Math.max(bounds.width, 1), 2400 / Math.max(bounds.height, 1));
      const viewport = sheet.getViewport({ scale });
      target.width = Math.ceil(viewport.width); target.height = Math.ceil(viewport.height);
      render = sheet.render({ canvas: target, viewport });
      await render.promise;
    }).catch(()=>{ if (active) setError("这一页无法渲染。"); });
    return () => { active = false; render?.cancel(); };
  }, [page, document]);
  if (error) return <p role="alert">{error}</p>;
  return <><div className="dv-tools"><button disabled={!document || page === 1} onClick={()=>go(page-1)}>上一页</button>
    <small>{document ? `${page} / ${document.numPages}` : "正在载入 PDF…"}</small><button disabled={!document || page >= document.numPages} onClick={()=>go(page+1)}>下一页</button></div>
    <canvas ref={canvas} className="dv-pdf" aria-label={`PDF 第 ${page} 页`} /></>;
}
