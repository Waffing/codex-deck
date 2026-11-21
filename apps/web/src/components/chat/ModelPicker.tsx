import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Cpu, SlidersHorizontal } from "lucide-react";
import type { Model, Provider, Thread, Workspace } from "@codexdeck/shared";
import { api, json } from "../../lib/api";
export const automationLabels = { conservative: "保守", semi: "半自动", full: "全自动", unrestricted:"完全权限" };
export function ModelPicker({
  thread,
  models,
  providers,
  workspace,
  onCreateThread,
  onRefresh,
}: {
  thread: Thread | null;
  workspace: Workspace;
  models: Model[];
  providers: Provider[];
  onCreateThread: () => Promise<Thread>;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const panel = useRef<HTMLDivElement>(null);
  const available = providers
    .filter((p) => p.enabled)
    .map((p) => ({ p, models: models.filter((m) => m.enabled && m.provider_id === p.id) }))
    .filter((g) => g.models.length);
  const alias = thread?.active_model_alias || available[0]?.models[0]?.alias || "选择模型";
  useEffect(() => {
    if (!open) return;
    function outside(e: PointerEvent) {
      if (!panel.current?.contains(e.target as Node)) setOpen(false);
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  async function change(patch: object) {
    setBusy(true);
    setError("");
    try {
      const t = thread ?? (await onCreateThread());
      await api("/api/threads/" + t.id + "/model", json("PATCH", patch));
      onRefresh();
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "模型切换失败");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="cd-model-picker" ref={panel}>
      <button
        type="button"
        className="cd-model-trigger"
        aria-label="模型与策略"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Cpu size={15} />
        <span>{alias}</span>
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className="cd-model-menu">
          <header>
            <strong>模型与策略</strong>
            <small>{automationLabels[workspace.automation_level]}</small>
          </header>
          {available.map(({ p, models: group }) => (
            <section key={p.id}>
              <h4>{p.name}</h4>
              {group.map((m) => {
                const caps = m.last_probe?.capabilities;
                const mode =
                  m.protocol === "auto"
                    ? caps?.responses
                      ? "Responses"
                      : caps?.chat
                        ? "Chat转译"
                        : "Auto"
                    : m.protocol === "responses"
                      ? "Responses"
                      : "Chat转译";
                return (
                  <button
                    type="button"
                    disabled={busy}
                    key={m.id}
                    onClick={() => void change({ model_alias: m.alias })}
                  >
                    <span>{m.alias}</span>
                    {alias === m.alias && <Check size={13} />}
                    <small>{mode}</small>
                    {caps?.tools && <small>Tools</small>}
                    {caps?.vision && <small>Vision</small>}
                  </button>
                );
              })}
            </section>
          ))}
          {!available.length && <p>请先在模型中心启用模型。</p>}
          <footer>
            <label htmlFor="cd-effort">
              <SlidersHorizontal size={14} />
              思考深度
            </label>
            <select
              id="cd-effort"
              disabled={busy || !available.length}
              value={thread?.reasoning_effort ?? ""}
              onChange={(e) => void change({ reasoning_effort: e.target.value || null })}
            >
              <option value="">默认</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              {thread?.reasoning_effort && !["low", "medium", "high"].includes(thread.reasoning_effort) && (
                <option value={thread.reasoning_effort}>{thread.reasoning_effort}</option>
              )}
            </select>
          </footer>
          {error && <p role="alert">{error}</p>}
        </div>
      )}
    </div>
  );
}
