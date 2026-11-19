import { useEffect, useState } from "react";
import { ArrowDownToLine, FileCode2, FileText, Image as ImageIcon } from "lucide-react";
import type { Artifact } from "@codexdeck/shared";
import { api, json } from "../../lib/api";
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
  const icon = /\.(md|txt)$/i.test(item.name) ? <FileText size={18} /> : <FileCode2 size={18} />;
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
        {image ? <FileImage artifact={item} /> : <span className="cd-file-icon">{icon}</span>}
        <span>
          <strong>{item.name}</strong>
          <small>
            {
              { added: "新增文件", modified: "已修改", upload: "上传文件", screenshot: "验收截图" }[
                item.change_type
              ]
            }
          </small>
        </span>
      </button>
      <button
        aria-label={"下载 " + item.name}
        onClick={() => void download({ artifact_id: item.id }).catch(() => onError("下载链接生成失败"))}
      >
        <ArrowDownToLine size={14} />
      </button>
    </div>
  );
}
