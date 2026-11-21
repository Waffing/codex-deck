import { useEffect, useState } from "react";
import { ArrowDownToLine, FileCode2, FileText, Image as ImageIcon, FileSpreadsheet, FileMusic, FileArchive, FileBarChart, FileBox } from "lucide-react";
import type { Artifact } from "@codexdeck/shared";
import { api, json } from "../../lib/api";
import {ShareButton} from "./ShareButton";
import type { DrawerTab } from "./DrawerContent";

export async function signed(subject: { artifact_id: string } | { turn_id: string }) {
  return (await api<{ download_url: string }>("/api/artifacts/sign", json("POST", subject))).download_url;
}
export async function download(subject: { artifact_id: string } | { turn_id: string }) {
  const a = document.createElement("a");
  a.href = await signed(subject);
  a.download = "";
  a.click();
}
export function FileImage({ artifact, large = false }: { artifact: Artifact; large?: boolean }) {
  const [src, setSrc] = useState(""),
    [error, setError] = useState(false);
  useEffect(() => {
    let alive = true;
    setSrc("");
    setError(false);
    signed({ artifact_id: artifact.id })
      .then((url) => {
        if (alive) setSrc(url);
      })
      .catch(() => {
        if (alive) setError(true);
      });
    return () => {
      alive = false;
    };
  }, [artifact.id]);
  if (error) return <span className="cd-image-failed">图片不可用</span>;
  return src ? (
    <img
      alt={artifact.name}
      className={large ? "cd-image-large" : "cd-image-thumb"}
      src={src}
      onError={() => setError(true)}
    />
  ) : (
    <ImageIcon size={18} />
  );
}
export function formatFileSize(bytes:number){
  if(bytes<1024)return bytes+" B";
  if(bytes<1024*1024)return (bytes/1024).toFixed(1)+" KB";
  return (bytes/1024/1024).toFixed(1)+" MB";
}
const fileTypes=[
  {extension:/\.docx?$/i,kind:"word",Icon:FileText},
  {extension:/\.pdf$/i,kind:"pdf",Icon:FileText},
  {extension:/\.(xlsx?|csv)$/i,kind:"sheet",Icon:FileSpreadsheet},
  {extension:/\.pptx?$/i,kind:"slides",Icon:FileBarChart},
  {extension:/\.(zip|tar\.gz|7z)$/i,kind:"archive",Icon:FileArchive},
  {extension:/\.(png|jpe?g|webp|svg|gif)$/i,kind:"image",Icon:ImageIcon},
  {extension:/\.(mp3|mp4)$/i,kind:"media",Icon:FileMusic},
  {extension:/\.(apk|exe|dmg)$/i,kind:"package",Icon:FileBox},
];
export function ArtifactChip({
  item,
  screenshots,
  onOpen,
  onError,
}: {
  item: Artifact;
  screenshots: Artifact[];
  onOpen: (tab: DrawerTab) => void;
  onError: (message: string) => void;
}) {
  const image = !!item.mime_type?.startsWith("image/");
  const {kind,Icon}=fileTypes.find(f=>f.extension.test(item.name))??{kind:"code",Icon:FileCode2};
  return (
    <div className={"cd-artifact" + (image ? " cd-image-artifact" : "")}>
      <button
        onClick={() =>
          onOpen({
            kind: image ? "image" : "file",
            title: item.name,
            path: item.path,
            artifact: item,
            comparison: item.change_type === "screenshot" ? screenshots : undefined,
          })
        }
      >
        <span className="cd-file-icon" data-kind={kind}><Icon size={18}/></span>
        <span>
          <strong>{item.name}</strong>
          <small>
            {
              { added: "新增文件", modified: "已修改", upload: "上传文件", screenshot: "验收截图" }[
                item.change_type
              ]
            }
            {item.size_bytes!=null && " · "+formatFileSize(item.size_bytes)}
          </small>
        </span>
      </button>
      <button
        aria-label={"下载 " + item.name}
        onClick={() => void download({ artifact_id: item.id }).catch(() => onError("下载链接生成失败"))}
      >
        <ArrowDownToLine size={14} />
      </button>
      <ShareButton artifactId={item.id} name={item.name}/>
    </div>
  );
}
