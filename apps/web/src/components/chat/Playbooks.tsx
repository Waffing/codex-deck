import { useState } from "react";
import {
  ArrowUpRight,
  BookOpen,
  Code2,
  FileSearch,
  GitPullRequest,
  ListFilter,
  Plus,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
type Playbook = { title: string; prompt: string };
const defaults: Playbook[] = [
  { title: "梳理项目", prompt: "阅读工作区的目录结构和关键入口，概括项目架构与本地启动方式。" },
  { title: "审查改动", prompt: "检查当前 Git 改动，列出潜在问题与相关文件。" },
  { title: "运行测试", prompt: "查看项目测试脚本，运行相关测试并总结结果。" },
];
export function readPlaybooks(id: string): Playbook[] {
  try {
    const stored = localStorage.getItem("cd:playbooks:" + id);
    if (!stored) return defaults;
    const rows: unknown = JSON.parse(stored);
    return Array.isArray(rows)
      ? rows.filter((r): r is Playbook => typeof r?.title === "string" && typeof r?.prompt === "string")
      : defaults;
  } catch {
    return defaults;
  }
}
export function Welcome({
  workspaceId,
  workspaceName,
  onSelect,
}: {
  workspaceId: string;
  workspaceName: string;
  onSelect: (prompt: string) => void;
}) {
  const [items, setItems] = useState(() => readPlaybooks(workspaceId)),
    [editing, setEditing] = useState(false);
  const [name, setName] = useState(""),
    [prompt, setPrompt] = useState(""),
    [error, setError] = useState("");
  const icons = [FileSearch, GitPullRequest, Terminal];
  const update = (next: Playbook[]) => {
    try {
      localStorage.setItem("cd:playbooks:" + workspaceId, JSON.stringify(next));
      setItems(next);
    } catch {
      setError("浏览器存储不可用");
    }
  };
  return (
    <div className="cd-welcome">
      <div className="cd-welcome-icon" aria-hidden="true">
        <Code2 size={28} />
      </div>
      <h1>开始新的任务</h1>
      <p>给 Codex 一条指令，或从快捷剧本开始。</p>
      <div className="cd-playbook-head">
        <span>
          <BookOpen size={14} />
          工作区剧本
        </span>
        <button
          aria-label="管理快捷剧本"
          title="管理快捷剧本"
          aria-pressed={editing}
          onClick={() => setEditing(!editing)}
        >
          {editing ? <X size={14} /> : <ListFilter size={14} />}
        </button>
      </div>
      <div className="cd-playbooks">
        {items.map((item, index) => {
          const Icon = icons[index % 3];
          return (
            <div className="cd-playbook" key={index}>
              <button onClick={() => onSelect(item.prompt)}>
                <span className="cd-playbook-icon">
                  <Icon size={18} />
                </span>
                <b>{item.title}</b>
                <ArrowUpRight size={14} />
              </button>
              {editing && (
                <button
                  className="cd-remove"
                  aria-label={"删除 " + item.title}
                  onClick={() => update(items.filter((_, idx) => idx !== index))}
                >
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          );
        })}
      </div>
      {editing && (
        <form
          className="cd-new-book"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim() || !prompt.trim()) return;
            update([...items, { title: name.trim(), prompt: prompt.trim() }]);
            setName("");
            setPrompt("");
          }}
        >
          <input
            placeholder="剧本名称"
            aria-label="剧本名称"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            placeholder="任务指令"
            aria-label="剧本指令"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <button>
            <Plus size={14} />
            添加
          </button>
        </form>
      )}
      {error && <span role="alert">{error}</span>}
    </div>
  );
}
