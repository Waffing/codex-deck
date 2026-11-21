import { useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Download,
  File,
  Folder,
  FolderOpen,
  GitCompareArrows,
  Pencil,
  Save,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { Artifact, Workspace } from "@codexdeck/shared";
import { api, json } from "../../lib/api";
import { download, FileImage } from "./Artifacts";
export type DrawerTab = {
  kind: "tree" | "file" | "diff" | "agents" | "logs" | "preview" | "image";
  title: string;
  path?: string;
  artifact?: Artifact;
  comparison?: Artifact[];
  turnId?: string;
  deploymentId?: string;
  port?: number;
};
type Entry = { name: string; path: string; type: "directory" | "file" | "symlink" };
function TreeBranch({
  workspaceId,
  path,
  onOpen,
}: {
  workspaceId: string;
  path: string;
  onOpen: (t: DrawerTab) => void;
}) {
  const [entries, setEntries] = useState<Entry[] | null>(null),
    [opened, setOpened] = useState<Record<string, boolean>>({}),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    api<Entry[]>("/api/workspaces/" + workspaceId + "/files/tree?path=" + encodeURIComponent(path))
      .then((items) => {
        if (active) setEntries(items);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [workspaceId, path]);
  if (error) return <p role="alert">{error}</p>;
  if (!entries) return <small>正在读取…</small>;
  if (!entries.length) return <small className="cd-empty-dir">目录为空</small>;
  return (
    <ul className="cd-tree">
      {entries.map((e) => (
        <li key={e.path}>
          <button
            disabled={e.type === "symlink"}
            onClick={() =>
              e.type === "directory"
                ? setOpened((prev) => ({ ...prev, [e.path]: !prev[e.path] }))
                : onOpen({ kind: "file", path: e.path, title: e.name })
            }
          >
            {e.type === "directory" ? (
              opened[e.path] ? (
                <>
                  <ChevronDown />
                  <FolderOpen />
                </>
              ) : (
                <>
                  <ChevronRight />
                  <Folder />
                </>
              )
            ) : (
              <File />
            )}
            {e.name}
          </button>
          {e.type === "directory" && opened[e.path] && (
            <TreeBranch workspaceId={workspaceId} path={e.path} onOpen={onOpen} />
          )}
        </li>
      ))}
    </ul>
  );
}
function Highlight({ source }: { source: string }) {
  const tokens = source.split(
    /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/[^\n]*|^#{1,6}[^\n]*|\b(?:const|let|var|function|return|export|import|class|async|await|true|false|null|new|interface|from|type|if|else|def|for|while)\b|\b\d+(?:\.\d+)?\b)/gm,
  );
  return (
    <pre className="cd-code">
      <code>
        {tokens.map((t, i) => (
          <span
            key={i}
            className={
              i % 2
                ? /^["']/.test(t)
                  ? "tok-str"
                  : /^(\/\/|#)/.test(t)
                    ? "tok-comment"
                    : /^\d/.test(t)
                      ? "tok-num"
                      : "tok-key"
                : undefined
            }
          >
            {t}
          </span>
        ))}
      </code>
    </pre>
  );
}
function Diff({ patch }: { patch: string }) {
  if (!patch)
    return (
      <div className="cd-drawer-empty">
        <GitCompareArrows />
        <p>工作区没有 Git 差异</p>
      </div>
    );
  const rows: { left: string; right: string; kind: string }[] = [];
  let del: string[] = [],
    add: string[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(del.length, add.length); i++)
      rows.push({ left: del[i] ?? "", right: add[i] ?? "", kind: "change" });
    del = [];
    add = [];
  };
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git") || line.startsWith("@@")) {
      flush();
      rows.push({ left: line, right: "", kind: "header" });
    } else if (/^(index |--- |\+\+\+ |new file mode|deleted file mode)/.test(line)) continue;
    else if (line.startsWith("-")) del.push(line.slice(1));
    else if (line.startsWith("+")) add.push(line.slice(1));
    else {
      flush();
      rows.push({ left: line, right: line, kind: "context" });
    }
  }
  flush();
  return (
    <div className="cd-diff">
      <div className="cd-diff-title">
        <b>变更前</b>
        <b>变更后</b>
      </div>
      {rows.map((r, i) => (
        <div className={"cd-diff-" + r.kind} key={i}>
          <code>{r.left}</code>
          {r.kind !== "header" && <code>{r.right}</code>}
        </div>
      ))}
    </div>
  );
}
export function DrawerContent({
  tab,
  workspace,
  onOpen,
}: {
  tab: DrawerTab;
  workspace: Workspace;
  onOpen: (tab: DrawerTab) => void;
}) {
  return (
    <DrawerBody
      key={[workspace.id, tab.kind, tab.path, tab.deploymentId, tab.port, tab.artifact?.id].join("|")}
      {...{ tab, workspace, onOpen }}
    />
  );
}
function DrawerBody({
  tab,
  workspace,
  onOpen,
}: {
  tab: DrawerTab;
  workspace: Workspace;
  onOpen: (tab: DrawerTab) => void;
}) {
  const [value, setValue] = useState(""),
    [initial, setInitial] = useState(""),
    [edit, setEdit] = useState(false);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false),
    [zoom, setZoom] = useState(false),
    [saving, setSaving] = useState(false);
  const [compare, setCompare] = useState(false);
  const [binary, setBinary] = useState(false);
  const [revision,setRevision] = useState("missing"), [readOnly,setReadOnly] = useState(false);
  const [conflict,setConflict] = useState<string|null>(null);
  const base = "/api/workspaces/" + workspace.id;
  const fileUrl = base + "/files/content?path=" + encodeURIComponent(tab.path ?? "");
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function fetchTab() {
      try {
        let data = "";
        if (tab.kind === "file") {
          const file = await api<{ content:string; mime_type:string; revision:string; read_only:boolean }>(fileUrl);
          const previewable =
            /^text\/|json|javascript|typescript|xml|yaml|toml/i.test(file.mime_type) ||
            (file.mime_type === "application/octet-stream" && !/[\u0000\uFFFD]/.test(file.content));
          if (active) setBinary(!previewable);
          if (active) { setRevision(file.revision); setReadOnly(file.read_only); }
          if (previewable) data = file.content;
        } else if (tab.kind === "agents") {
          const doc = await api<{content:string;revision:string;read_only:boolean}>(base + "/agents-md");
          data = doc.content;
          if (active) { setRevision(doc.revision); setReadOnly(doc.read_only); }
        }
        else if (tab.kind === "diff") data = (await api<{ diff: string }>(base + "/git/diff")).diff;
        else if (tab.kind === "logs")
          data = (
            await api<{ logs: string }>(
              "/api/deployments/" + tab.deploymentId + "/action",
              json("POST", { action: "logs" }),
            )
          ).logs;
        if (active) {
          setValue(data);
          setInitial(data);
          setError("");
        }
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : "读取失败");
      } finally {
        if (active) {
          setLoading(false);
          if (tab.kind === "logs") timer = setTimeout(fetchTab, 2500);
        }
      }
    }
    void fetchTab();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [base, fileUrl, tab.deploymentId, tab.kind]);
  async function save() {
    setSaving(true);
    setError("");
    try {
      const res = await api<{revision:string}>(tab.kind === "agents" ? base + "/agents-md" : fileUrl, {
        method:"PUT", headers:{"Content-Type":"application/json","If-Match":revision}, body:JSON.stringify({content:value})
      });
      setRevision(res.revision);
      setConflict(null);
      setInitial(value);
      setEdit(false);
      setSaved(true);
    } catch (e) {
      if ((e as {status?:number}).status===409) {
        setError("文件已被修改。以下是当前磁盘版本，请对照草稿合并后再保存。");
        try {
          const current=await api<{content:string;revision:string;read_only:boolean}>(tab.kind==="agents"? base+"/agents-md":fileUrl);
          setConflict(current.content); setRevision(current.revision); setReadOnly(current.read_only);
        } catch { setError("无法读取冲突版本。请重新打开文件。"); }
      } else setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }
  if (tab.kind === "tree")
    return (
      <div className="cd-drawer-body">
        <h3>工作区文件</h3>
        <TreeBranch workspaceId={workspace.id} path="" onOpen={onOpen} />
      </div>
    );
  if (tab.kind === "preview")
    return (
      <iframe
        sandbox="allow-scripts allow-forms"
        className="cd-iframe"
        src={"/preview/" + Number(tab.port) + "/"}
        title={"服务预览 " + tab.port}
      />
    );
  if (tab.kind === "image" && tab.artifact) {
    const images = compare && tab.comparison?.length ? tab.comparison : [tab.artifact];
    return (
      <div className="cd-drawer-body cd-image-view">
        <div className="cd-image-actions">
          <button onClick={() => setZoom(!zoom)}>
            {zoom ? <ZoomOut size={16} /> : <ZoomIn size={16} />} {zoom ? "适应宽度" : "原始大小"}
          </button>
          {(tab.comparison?.length ?? 0) > 1 && (
            <button aria-pressed={compare} onClick={() => setCompare(!compare)}>
              <GitCompareArrows size={16} />
              {compare ? "查看单图" : "对比验收截图"}
            </button>
          )}
        </div>
        <div className={compare ? "cd-image-grid comparing" : "cd-image-grid"}>
          {images.map((img) => (
            <figure key={img.id}>
              <figcaption>
                {/^verify-1440-/.test(img.name)
                  ? "桌面 · 1440 × 900"
                  : /^verify-390-/.test(img.name)
                    ? "移动 · 390 × 844"
                    : img.name}
              </figcaption>
              <div className={zoom ? "cd-image-scroll cd-zoom" : "cd-image-scroll"}>
                <FileImage artifact={img} large />
              </div>
            </figure>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className="cd-drawer-body">
      <div className="cd-file-toolbar">
        <code>{tab.path || (tab.kind === "agents" ? "AGENTS.md" : tab.title)}</code>
        {(tab.kind === "file" || tab.kind === "agents") &&
          !binary &&
          (edit || !error) &&
          (edit ? (
            <>
              <button
                disabled={saving}
                onClick={() => {
                  setValue(initial);
                  setEdit(false);
                  setError("");
                }}
              >
                取消
              </button>
              <button disabled={saving || readOnly} onClick={() => void save()}>
                <Save size={13} />
                保存
              </button>
            </>
          ) : (
            <button
              disabled={loading || readOnly}
              onClick={() => {
                setEdit(true);
                setSaved(false);
              }}
            >
              <Pencil size={13} />
              编辑
            </button>
          ))}
        {tab.kind === "file" && (
          <button title="查看 Git Diff" onClick={() => onOpen({ kind: "diff", title: "Git Diff" })}>
            <GitCompareArrows size={14} />
          </button>
        )}
        {tab.kind === "diff" && (
          <a download="changes.patch" href={base + "/git/diff?format=patch"}>
            <Download size={14} />
            Patch
          </a>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      {readOnly && !binary && <p>含脱敏内容，此预览为只读。</p>}
      {conflict !== null && <details open><summary>当前磁盘版本</summary><pre>{conflict}</pre></details>}
      {loading ? (
        <span>正在读取…</span>
      ) : edit ? (
        <textarea
          className="cd-editor"
          aria-label="文件内容"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      ) : (
        !error &&
        (binary ? (
          <p>
            此文件为二进制格式。
            {tab.artifact && (
              <button
                onClick={() =>
                  void download({ artifact_id: tab.artifact!.id }).catch(() => setError("下载链接生成失败"))
                }
              >
                下载原文件
              </button>
            )}
          </p>
        ) : tab.kind === "diff" ? (
          <Diff patch={value} />
        ) : tab.kind === "logs" ? (
          <pre className="cd-terminal">{value || "暂无日志"}</pre>
        ) : (
          <Highlight source={value} />
        ))
      )}
      {saved && <small role="status">已保存</small>}
    </div>
  );
}
