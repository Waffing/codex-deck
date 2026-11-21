import { Children, isValidElement, lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { Download, FileText } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { WorkBook } from "xlsx";
import { MermaidDiagram } from "./MermaidDiagram";
import { checkOfficePackage } from "./office-package";
import "./document-viewer.css";

const PdfPage = lazy(() => import("./PdfPage"));
const SpreadsheetView = lazy(() => import("./SpreadsheetView"));
const limit = 32 * 1024 * 1024;
export const richFormat = /\.(?:docx|xlsx?|csv|pdf|html?|svg|md|markdown|mmd|mermaid|png|jpe?g|gif|webp|bmp|avif)$/i;

interface Props { name: string; contentUrl: string; size?: number; downloadUrl?: string; actions?: ReactNode }
type Loaded = { text: string } | { word: string } | { spreadsheet: WorkBook } | { pdf: ArrayBuffer } | { image: string };
const waiting = <p role="status">正在载入预览…</p>;

function MarkdownFile({ text }: { text: string }) {
  return <article className="dv-prose"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
    a: ({ children, href }) => href && /^https?:\/\//i.test(href) ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
    img: ({src,alt}) => typeof src === "string" && /^data:image\/(png|jpeg|gif|webp);base64,/i.test(src)
      ? <img alt={alt || ""} src={src} /> : <span>{alt}</span>,
    pre: ({ children }) => {
      const child = Children.toArray(children)[0];
      if (isValidElement<{className?:string;children?:ReactNode}>(child) && child.props.className === "language-mermaid")
        return <MermaidDiagram source={String(child.props.children ?? "")} />;
      return <pre>{children}</pre>;
    },
  }}>{text}</Markdown></article>;
}

async function decode(bytes: ArrayBuffer, extension: string): Promise<Loaded> {
  if (extension === "docx" || extension === "xlsx") checkOfficePackage(bytes);
  if (extension === "docx") {
    const [{ default: mammoth }, { default: purify }] = await Promise.all([import("mammoth"), import("dompurify")]);
    const result = await mammoth.convertToHtml({ arrayBuffer: bytes }, {
      externalFileAccess: false, includeEmbeddedStyleMap: false,
      convertImage: mammoth.images.imgElement(async image => ({
        src: /^image\/(png|jpeg|gif|webp|bmp)$/i.test(image.contentType) ? "data:"+image.contentType+";base64,"+await image.readAsBase64String() : "",
      })),
    });
    return { word: purify.sanitize(result.value, {
      ALLOWED_TAGS: ["p","br","h1","h2","h3","h4","h5","h6","ol","ul","li","table","tr","td","th","tbody","thead","strong","em","s","sub","sup","u","img","blockquote","pre","code","hr"],
      ALLOWED_ATTR: ["alt","src","rowspan","colspan"], ALLOWED_URI_REGEXP: /^data:image\/(png|jpeg|gif|webp|bmp);base64,/i,
    }) };
  }
  if (/^(xls|xlsx|csv)$/.test(extension)) {
    const { read } = await import("xlsx");
    const options = { cellHTML: false, cellFormula: false, bookVBA: false, dense: true };
    const spreadsheet: WorkBook = extension === "csv"
      ? read(new TextDecoder().decode(bytes), { ...options, type: "string", raw: true })
      : read(bytes, { ...options, type: "array" });
    return { spreadsheet };
  }
  if (extension === "pdf") return { pdf: bytes };
  if (/^(png|jpe?g|gif|webp|bmp|avif)$/.test(extension))
    return { image: URL.createObjectURL(new Blob([bytes], { type: "image/" + (extension==="jpg"?"jpeg":extension) })) };
  if (new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 1024)).includes(0)) throw new Error("此二进制格式仅支持下载。");
  return { text: new TextDecoder().decode(bytes) };
}

export function DocumentViewer(props: Props) {
  return <Viewer key={props.contentUrl} {...props} />;
}

function Viewer({name, contentUrl, size, downloadUrl, actions}: Props) {
  const [loaded, setLoaded] = useState<Loaded>();
  const [length, setLength] = useState(size);
  const [error, fail] = useState("");
  const [source, setSource] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [board, checker] = useState(true);
  const [zoom, setZoom] = useState(1);
  const extension = name.split(".").pop()?.toLowerCase() || "";
  const html = extension === "html" || extension === "htm", svg = extension === "svg";
  useEffect(() => {
    const controller = new AbortController();
    let imageUrl: string | undefined;
    async function load() {
      const response = await fetch(contentUrl, {signal:controller.signal, credentials:"same-origin", cache:"no-store"});
      if (!response.ok) throw new Error(response.status===410?"该版本已失效或快照不可用。":"无法读取此文件。");
      if (Number(response.headers.get("content-length")) > limit) throw new Error("文件超过 32 MiB 预览上限。");
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > limit) throw new Error("文件超过 32 MiB 预览上限。");
      if (controller.signal.aborted) return;
      const value = await decode(bytes, extension);
      if ("image" in value) imageUrl = value.image;
      if (controller.signal.aborted) { if (imageUrl) URL.revokeObjectURL(imageUrl); return; }
      setLength(bytes.byteLength); setLoaded(value);
    }
    void load().catch(e => { if (!controller.signal.aborted) fail(e instanceof Error ? e.message : "文件解析失败。"); });
    return () => { controller.abort(); if (imageUrl) URL.revokeObjectURL(imageUrl); };
  }, [contentUrl, extension]);
  let body: ReactNode = waiting;
  if (error) body = <p role="alert">{error}</p>;
  else if (loaded) {
    if ("word" in loaded) body = <article className="dv-prose" dangerouslySetInnerHTML={{__html:loaded.word}} />;
    else if ("pdf" in loaded) body = <PdfPage bytes={loaded.pdf} />;
    else if ("spreadsheet" in loaded) body = <SpreadsheetView workbook={loaded.spreadsheet} />;
    else if ("image" in loaded) body = <img className="dv-image" src={loaded.image} alt={name} />;
    else if (html || svg) body = <><div className="dv-tools">
      {html && <><button aria-pressed={!source} onClick={()=>setSource(false)}>实时预览</button><button aria-pressed={source} onClick={()=>setSource(true)}>源码</button>
        {!source && <button aria-pressed={mobile} onClick={()=>setMobile(!mobile)}>{mobile ? "桌面视口" : "手机视口"}</button>}</>}
      {svg && <><button aria-pressed={board} onClick={()=>checker(!board)}>棋盘格背景</button>
        <label>缩放 <select aria-label="SVG 缩放" value={zoom} onChange={e=>setZoom(Number(e.target.value))}>{[0.5,1,1.5,2,3].map(n=><option key={n} value={n}>{n*100}%</option>)}</select></label></>}
    </div>{source ? <pre className="dv-source">{loaded.text}</pre> : <div className={"dv-viewport" + (svg && board ? " dv-checker" : "")}>
      <iframe title={name+" 隔离预览"} sandbox="allow-scripts" referrerPolicy="no-referrer" src={contentUrl}
        style={{width:mobile?"min(390px, 100%)":"100%", transform:svg?`scale(${zoom})`:undefined,transformOrigin:"top left"}} /></div>}</>;
    else if (extension==="mmd" || extension==="mermaid") body = <MermaidDiagram source={loaded.text} />;
    else if (extension==="md" || extension==="markdown") body = <MarkdownFile text={loaded.text} />;
    else body = <pre className="dv-source">{loaded.text}</pre>;
  }
  return <section className="document-viewer" aria-label="文档预览"><header><FileText size={17}/><strong>{name}</strong>
    <small>{extension.toUpperCase()}{length !== undefined && " · " + (length < 1024 ? length + " B" : (length / 1024).toFixed(1)+" KB")}</small>{actions}
    {downloadUrl && <a href={downloadUrl} download={name} aria-label={"下载 "+name}><Download size={15}/> 下载</a>}</header>
    <div className="dv-content"><Suspense fallback={waiting}>{body}</Suspense></div></section>;
}
