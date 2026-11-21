import { memo, useRef, useState, type ComponentProps } from "react";
import { MermaidDiagram } from "../files/MermaidDiagram";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Check, Copy, Download, ImageDown } from "lucide-react";

type HtmlNode = { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: HtmlNode[] };
const annotation = /(失败|错误|告警|警告|\b(?:error|failed|warning)\b)|(成功|已通过|已完成|\b(?:passed|success)\b)|(\d+(?:[.,]\d+)*\s*(?:ms\b|s\b|min\b|tok\/s\b|tokens?\b|%|秒|分钟))|((?:[.\w-]+\/)+[\w.-]+|\b[\w-]+\.(?:tsx?|jsx?|md|py|json|toml|ya?ml|css|rs|go)\b)/gi;

function annotateText() {
  function walk(node: HtmlNode) {
    if (!node.children || ["pre", "code", "a", "strong"].includes(node.tagName ?? "")) return;
    node.children = node.children.flatMap((child) => {
      if (child.type !== "text" || !child.value) {
        walk(child);
        return [child];
      }
      const original = child.value;
      let offset = 0;
      const parts: HtmlNode[] = [];
      for (const hit of original.matchAll(annotation)) {
        const index = hit.index;
        if (index > offset) parts.push({ type: "text", value: original.slice(offset, index) });
        const kind = hit[1] ? "danger" : hit[2] ? "success" : hit[3] ? "metric" : "path";
        parts.push({ type: "element", tagName: "span", properties: { className: ["md-" + kind] }, children: [{ type: "text", value: hit[0] }] });
        offset = index + hit[0].length;
      }
      if (!parts.length) return [child];
      if (offset < original.length) parts.push({ type: "text", value: original.slice(offset) });
      return parts;
    });
  }
  return walk;
}

function plain(node?: HtmlNode): string {
  return node?.value ?? node?.children?.map(plain).join("") ?? "";
}

function CodeBlock({ children, node }: ComponentProps<"pre"> & { node?: HtmlNode }) {
  const [expanded, setExpanded] = useState(false);
  const [copy, setCopy] = useState<"idle" | "ok" | "error">("idle");
  const code = node?.children?.find(n => n.tagName === "code");
  const source = plain(code).replace(/\n$/, "");
  const classes = code?.properties?.className;
  const lang = Array.isArray(classes) ? String(classes.find(c => String(c).startsWith("language-")) ?? "").slice(9) : "";
  if (lang === "mermaid") return <MermaidDiagram source={source}/>;
  const count = source.split("\n").length;
  return <figure className="md-code-block">
    <figcaption><span>{lang || "text"}</span><button type="button" aria-label="复制代码" onClick={async () => {
      try { await navigator.clipboard.writeText(source); setCopy("ok"); } catch { setCopy("error"); }
    }}>{copy === "ok" ? <Check size={13}/> : <Copy size={13}/>} {copy === "ok" ? "已复制" : copy === "error" ? "复制失败" : "复制"}</button></figcaption>
    <div className="md-code-lines" data-folded={count > 18 && !expanded}>
      <span className="md-gutter" aria-hidden="true">{Array.from({ length: count }, (_, i) => i + 1).join("\n")}</span>
      <pre>{children}</pre>
    </div>
    {count > 18 && <button className="md-unfold" aria-expanded={expanded} type="button" onClick={() => setExpanded(!expanded)}>
      {expanded ? "折叠代码" : `展开全部 ${count} 行`}</button>}
  </figure>;
}
const components: Components = {
  pre: CodeBlock,
  table: ({ children }) => <div className="md-table-scroll"><table>{children}</table></div>,
  a: ({ children, href }) => <a href={href} rel="noreferrer noopener" target="_blank">{children}</a>,
  img: ({ src, alt }) => {
    if (typeof src !== "string" || !src) return <span>{alt}</span>;
    // Reading a conversation must not silently contact a third-party image server.
    return /^\/api\/artifacts\/[^/]/.test(src) ? <img src={src} alt={alt ?? ""} loading="lazy"/> : <a href={src} target="_blank" rel="noreferrer noopener">{alt || "查看图片"}</a>;
  },
};

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const AnswerDocument = memo(function AnswerDocument({ source, turnId, complete, onError }: {
  source: string; turnId: string; complete: boolean; onError: (message: string) => void;
}) {
  const article = useRef<HTMLDivElement>(null);
  const [exporting, setExporting] = useState(false);
  async function exportImage() {
    if (!article.current || exporting) return;
    setExporting(true);
    const frame = document.createElement("div");
    frame.className = "md-export-stage";
    const paper = document.createElement("div");
    paper.className = "md-export-paper";
    const title = document.createElement("header");
    title.textContent = "CodexDeck  /  对话记录";
    paper.append(title, article.current.cloneNode(true));
    for (const folded of paper.querySelectorAll("[data-folded]")) folded.setAttribute("data-folded", "false");
    for (const button of paper.querySelectorAll("button")) button.remove();
    frame.append(paper);
    document.body.append(frame);
    try {
      const { toBlob } = await import("html-to-image");
      await document.fonts.ready;
      const image = await toBlob(paper, { pixelRatio: 1.5, skipFonts: true });
      if (!image) throw new Error("导出图片失败");
      downloadBlob(image, `codexdeck-${turnId}.png`);
    } catch (error) {
      onError(error instanceof Error ? error.message : "导出图片失败");
    } finally {
      frame.remove();
      setExporting(false);
    }
  }
  return <>
    <div ref={article} className="cd-answer md-document">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight, annotateText]} components={components} skipHtml>{source}</ReactMarkdown>
    </div>
    {complete && <div className="cd-export">
      <button onClick={() => downloadBlob(new Blob([source], { type: "text/markdown;charset=utf-8" }), `codexdeck-${turnId}.md`)}><Download size={13}/>导出 .md</button>
      <button disabled={exporting} onClick={() => void exportImage()}><ImageDown size={13}/>{exporting ? "正在生成…" : "导出 PNG"}</button>
    </div>}
  </>;
});
