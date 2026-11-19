import { useState, type ReactNode } from "react";
import { AlertCircle, CheckCircle2, DatabaseZap, Loader2 } from "lucide-react";
import type { ProbeResult, ProviderPreset } from "@codexdeck/shared";

export type Preset = { id: ProviderPreset; label: string; defaultBaseUrl: string | null };
export type AdminDrawer = { type: "logs" | "preview"; title: string; deploymentId: string; port: number };
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  async function run(fn: () => Promise<void>, message = "") {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      setNotice(message);
    } catch (e) {
      setError(e instanceof Error ? e.message : "请求失败，请重试。");
    } finally {
      setBusy(false);
    }
  }
  return { busy, notice, error, run, setError, setNotice };
}
export function Feedback({ error, notice, busy = false }: { error?: string; notice?: string; busy?: boolean }) {
  if (error)
    return (
      <div className="ad-message danger" role="alert">
        <AlertCircle size={15} />
        {error}
      </div>
    );
  if (notice)
    return (
      <div className="ad-message good" role="status">
        <CheckCircle2 size={15} />
        {notice}
      </div>
    );
  if (busy)
    return (
      <div className="ad-message" role="status">
        <Loader2 size={14} className="ad-spin" />
        正在处理…
      </div>
    );
  return null;
}
export function SectionHead({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="ad-section-head">
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions}
    </header>
  );
}
export function Empty({ title, description, icon }: { title: string; description: string; icon?: ReactNode }) {
  return (
    <section className="ad-empty">
      <div className="ad-empty-icon">{icon ?? <DatabaseZap size={24} />}</div>
      <h3>{title}</h3>
      <p>{description}</p>
    </section>
  );
}
export function Abilities({ probe }: { probe: ProbeResult | null }) {
  if (!probe) return <span className="ad-pill">尚未探测</span>;
  const c = probe.capabilities;
  const names = [
    c.responses && "Responses",
    c.chat && "Chat 转译",
    c.tools && "Tools",
    c.vision && "Vision",
  ].filter(Boolean);
  return (
    <span className="ad-pill-group">
      {names.map((name) => (
        <span className="ad-pill positive" key={String(name)}>
          {name}
        </span>
      ))}
      {c.latency_ms !== null && <span className="ad-pill">TTFT {c.latency_ms} ms</span>}
      {!probe.ok && <span className="ad-pill caution">探测未通过</span>}
    </span>
  );
}
export function timeLabel(value: string) {
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
}
export function sizeLabel(bytes: number) {
  return (bytes / 1024 ** 3).toFixed(1) + " GB";
}
