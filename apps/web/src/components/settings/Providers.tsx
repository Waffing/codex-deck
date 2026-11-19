import { useEffect, useRef, useState } from "react";
import type { Model, Provider, ProviderPreset, ProbeResult } from "@codexdeck/shared";
import {
  Cable,
  ChevronDown,
  ChevronUp,
  Download,
  GripVertical,
  Plus,
  Save,
  SlidersHorizontal,
  Upload,
  X,
} from "lucide-react";
import { api, json } from "../../lib/api";
import { Abilities, Empty, Feedback, SectionHead, useAction, type Preset } from "./common";

type ProviderDraft = {
  name: string;
  preset: ProviderPreset;
  base_url: string;
  enabled: boolean;
  strip: boolean;
  forceChat: boolean;
  headers: string;
  key: string;
};
type ModelDraft = {
  alias: string;
  model_id: string;
  provider_id: string;
  protocol: Model["protocol"];
  currency: "USD" | "CNY";
  input: number;
  output: number;
  fallback: string[];
  enabled: boolean;
};
const blankProvider: ProviderDraft = {
  preset: "custom",
  name: "",
  base_url: "",
  key: "",
  enabled: true,
  strip: false,
  forceChat: false,
  headers: "",
};
const blankModel: ModelDraft = {
  alias: "",
  model_id: "",
  provider_id: "",
  protocol: "auto",
  currency: "USD",
  input: 0,
  output: 0,
  fallback: [],
  enabled: true,
};

export function Providers({ onChanged }: { onChanged?: () => void }) {
  const [providers, setProviders] = useState<Provider[]>([]),
    [models, setModels] = useState<Model[]>([]),
    [presets, setPresets] = useState<Preset[]>([]);
  const [editor, setEditor] = useState<{ type: "provider" | "model"; id?: string } | null>(null);
  const [p, setP] = useState<ProviderDraft>(blankProvider),
    [m, setM] = useState<ModelDraft>(blankModel);
  const [deleting, setDeleting] = useState<{ kind: "providers" | "models"; id: string } | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const file = useRef<HTMLInputElement | null>(null);
  const a = useAction();
  async function load() {
    const [ps, ms, ts] = await Promise.all([
      api<Provider[]>("/api/providers"),
      api<Model[]>("/api/models"),
      api<Preset[]>("/api/providers/presets"),
    ]);
    setProviders(ps);
    setModels(ms);
    setPresets(ts);
  }
  useEffect(() => {
    void a.run(load);
  }, []);
  async function changed() {
    await load();
    onChanged?.();
  }
  function editProvider(row?: Provider) {
    setP(
      row
        ? {
            name: row.name,
            preset: row.preset,
            base_url: row.base_url,
            enabled: row.enabled,
            key: "",
            headers: "",
            forceChat: !!row.quirks.force_chat,
            strip: row.quirks.strip_reasoning,
          }
        : { ...blankProvider },
    );
    setEditor({ type: "provider", id: row?.id });
    setDeleting(null);
    a.setError("");
  }
  function editModel(row?: Model) {
    const c = row?.pricing_currency ?? "USD";
    setM(
      row
        ? {
            alias: row.alias,
            model_id: row.model_id,
            provider_id: row.provider_id,
            enabled: row.enabled,
            protocol: row.protocol,
            currency: c,
            input: c === "USD" ? row.cost_input_usd_per_million : (row.cost_input_cny_per_million ?? 0),
            output: c === "USD" ? row.cost_output_usd_per_million : (row.cost_output_cny_per_million ?? 0),
            fallback: row.fallback_model_ids,
          }
        : { ...blankModel, provider_id: providers[0]?.id ?? "" },
    );
    setEditor({ type: "model", id: row?.id });
    setDeleting(null);
    a.setError("");
  }
  async function saveProvider() {
    const id = editor?.id;
    const headers = p.headers.trim() ? (JSON.parse(p.headers) as unknown) : undefined;
    if (
      headers !== undefined &&
      (!headers ||
        typeof headers !== "object" ||
        Array.isArray(headers) ||
        Object.values(headers).some((v) => typeof v !== "string"))
    )
      throw new Error("自定义请求头需要 JSON 字符串键值对。");
    await api(
      "/api/providers" + (id ? "/" + id : ""),
      json(id ? "PATCH" : "POST", {
        name: p.name,
        preset: p.preset,
        base_url: p.base_url,
        enabled: p.enabled,
        quirks: { strip_reasoning: p.strip, force_chat: p.forceChat },
        ...(p.key && { api_key: p.key }),
        ...(headers !== undefined && { headers }),
      }),
    );
    setP(blankProvider);
    setEditor(null);
    await changed();
  }
  async function saveModel() {
    const id = editor?.id,
      cur = m.currency.toLowerCase();
    await api(
      "/api/models" + (id ? "/" + id : ""),
      json(id ? "PATCH" : "POST", {
        alias: m.alias,
        model_id: m.model_id,
        provider_id: m.provider_id,
        enabled: m.enabled,
        protocol: m.protocol,
        pricing_currency: m.currency,
        ["cost_input_" + cur + "_per_million"]: m.input,
        ["cost_output_" + cur + "_per_million"]: m.output,
        fallback_model_ids: m.fallback,
      }),
    );
    setEditor(null);
    await changed();
  }
  function exportChannels() {
    const data = providers.map(({ name, preset, base_url, enabled, quirks }) => ({
      name,
      preset,
      base_url,
      enabled,
      quirks,
    }));
    const url = URL.createObjectURL(
      new Blob([JSON.stringify({ version: 1, providers: data }, null, 2)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "codexdeck-providers.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 500);
  }
  async function importChannel(f: File) {
    const doc = JSON.parse(await f.text());
    if (!Array.isArray(doc.providers) || doc.version !== 1 || !doc.providers.length)
      throw new Error("请选择 CodexDeck 导出的渠道配置。");
    for (const row of doc.providers) {
      if (
        typeof row.name !== "string" ||
        typeof row.base_url !== "string" ||
        !presets.some((t) => t.id === row.preset)
      )
        throw new Error("配置中存在无效的渠道。");
    }
    for (const { name, preset, base_url, enabled, quirks } of doc.providers) {
      if (providers.some((v) => v.base_url === base_url && v.name === name)) continue;
      await api(
        "/api/providers",
        json("POST", {
          name,
          preset,
          base_url,
          enabled: !!enabled,
          quirks: { strip_reasoning: !!quirks?.strip_reasoning, force_chat: !!quirks?.force_chat },
        }),
      );
    }
    await changed();
  }
  function order(from: number, to: number) {
    if (to < 0 || to >= m.fallback.length) return;
    const ids = [...m.fallback];
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    setM({ ...m, fallback: ids });
  }
  const deleteConfirm = deleting && (
    <div className="ad-message caution">
      确认删除{deleting.kind === "providers" ? "此渠道及其模型" : "此模型"}？
      <button
        className="ad-button ad-danger"
        disabled={a.busy}
        onClick={() =>
          void a.run(async () => {
            await api("/api/" + deleting.kind + "/" + deleting.id, json("DELETE"));
            setDeleting(null);
            setEditor(null);
            await changed();
          }, "已删除")
        }
      >
        确认删除
      </button>
      <button className="ad-button" onClick={() => setDeleting(null)}>
        取消
      </button>
    </div>
  );
  return (
    <>
      <SectionHead
        title="第三方 API 与模型"
        description="连接上游渠道，配置模型协议、推理价格与备用路由。"
        actions={
          <button className="ad-primary" onClick={() => editProvider()}>
            <Plus size={15} />
            添加渠道
          </button>
        }
      />
      <div className="ad-subhead">
        <h2>供应商渠道</h2>
        <div className="ad-actions">
          <button className="ad-button" onClick={() => file.current?.click()}>
            <Upload size={13} />
            导入
          </button>
          <button className="ad-button" onClick={exportChannels}>
            <Download size={13} />
            脱敏导出
          </button>
          <input
            ref={file}
            type="file"
            hidden
            accept=".json,application/json"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void a.run(() => importChannel(f), "渠道已导入，请补充密钥");
            }}
          />
        </div>
      </div>
      <Feedback error={a.error} notice={a.notice} busy={a.busy} />
      {editor?.type === "provider" && (
        <form
          className="ad-form-panel ad-form"
          onSubmit={(e) => {
            e.preventDefault();
            void a.run(saveProvider, "渠道已保存");
          }}
        >
          <div className="ad-labelrow">
            <strong>{editor.id ? "编辑渠道" : "添加渠道"}</strong>
            <button
              className="ad-button"
              type="button"
              aria-label="关闭渠道编辑"
              onClick={() => {
                setEditor(null);
                setP(blankProvider);
              }}
            >
              <X size={14} />
            </button>
          </div>
          <div className="ad-form-grid">
            <label>
              供应商预设
              <select
                value={p.preset}
                onChange={(e) => {
                  const t = presets.find((r) => r.id === e.target.value)!;
                  setP({ ...p, preset: t.id, base_url: t.defaultBaseUrl ?? "", name: t.label });
                }}
              >
                {presets.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              渠道名称
              <input required value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} />
            </label>
            <label>
              接口地址
              <input
                required
                type="url"
                value={p.base_url}
                onChange={(e) => setP({ ...p, base_url: e.target.value })}
              />
            </label>
            <label>
              API Key
              <input
                type="password"
                autoComplete="off"
                value={p.key}
                placeholder={editor.id ? "留空保留已存密钥" : "输入密钥"}
                onChange={(e) => setP({ ...p, key: e.target.value })}
              />
            </label>
          </div>
          <details>
            <summary>高级适配</summary>
            <label className="ad-check">
              <input
                type="checkbox"
                checked={p.forceChat}
                onChange={(e) => setP({ ...p, forceChat: e.target.checked })}
              />
              强制 Chat Completions 转译
            </label>
            <label className="ad-check">
              <input type="checkbox" checked={p.strip} onChange={(e) => setP({ ...p, strip: e.target.checked })} />
              剥离 reasoning 字段
            </label>
            <label>
              自定义请求头
              <textarea
                placeholder={'{"X-Client": "CodexDeck"}'}
                value={p.headers}
                onChange={(e) => setP({ ...p, headers: e.target.value })}
              />
              <small>留空保留已有请求头；输入 JSON 对象会替换请求头。</small>
            </label>
          </details>
          <label className="ad-check">
            <input
              type="checkbox"
              checked={p.enabled}
              onChange={(e) => setP({ ...p, enabled: e.target.checked })}
            />
            启用渠道
          </label>
          <div className="ad-actions">
            <button className="ad-primary" disabled={a.busy}>
              <Save size={14} />
              保存渠道
            </button>
            {editor.id && (
              <button
                type="button"
                className="ad-button ad-danger"
                onClick={() => setDeleting({ kind: "providers", id: editor.id! })}
              >
                删除渠道
              </button>
            )}
          </div>
        </form>
      )}
      {deleteConfirm}
      {!providers.length ? (
        <Empty title="尚未连接供应商" description="添加 OpenAI 或兼容 API 渠道，再为工作区绑定模型。" />
      ) : (
        <div className="ad-grid">
          {providers.map((row) => (
            <article key={row.id} className="ad-card">
              <div className="ad-labelrow">
                <div className="ad-pair">
                  <span className="ad-provider-symbol">
                    <Cable size={17} />
                  </span>
                  <div>
                    <strong>{row.name}</strong>
                    <small>{presets.find((t) => t.id === row.preset)?.label}</small>
                  </div>
                </div>
                <span className={"ad-pill " + (row.enabled ? "positive" : "")}>
                  {row.enabled ? "已启用" : "已停用"}
                </span>
              </div>
              <small className="ad-mono">{row.base_url}</small>
              <Abilities probe={row.last_probe} />
              {row.last_probe?.error && <small>{row.last_probe.error}</small>}
              <div className="ad-actions">
                <button
                  className="ad-button"
                  disabled={a.busy}
                  onClick={() =>
                    void a.run(async () => {
                      const r = await api<ProbeResult>("/api/providers/" + row.id + "/probe", json("POST", {}));
                      await changed();
                      if (!r.ok) throw new Error(r.error ?? "未检测到支持的协议。");
                    }, "探测完成")
                  }
                >
                  <Cable size={13} />
                  探测能力
                </button>
                <button className="ad-button" onClick={() => editProvider(row)}>
                  <SlidersHorizontal size={13} />
                  编辑
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
      <div className="ad-subhead">
        <h2>模型路由</h2>
        <button className="ad-button" disabled={!providers.length} onClick={() => editModel()}>
          <Plus size={14} />
          添加模型
        </button>
      </div>
      {editor?.type === "model" && (
        <form
          className="ad-form-panel ad-form"
          onSubmit={(e) => {
            e.preventDefault();
            void a.run(saveModel, "模型已保存");
          }}
        >
          <div className="ad-labelrow">
            <strong>{editor.id ? "编辑模型" : "添加模型"}</strong>
            <button className="ad-button" type="button" aria-label="关闭模型编辑" onClick={() => setEditor(null)}>
              <X size={14} />
            </button>
          </div>
          <div className="ad-form-grid">
            <label>
              所属渠道
              <select value={m.provider_id} onChange={(e) => setM({ ...m, provider_id: e.target.value })}>
                {providers.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              接入协议
              <select
                value={m.protocol}
                onChange={(e) => setM({ ...m, protocol: e.target.value as Model["protocol"] })}
              >
                <option value="auto">自动选择</option>
                <option value="responses">Responses 原生</option>
                <option value="chat">强制 Chat Completions 转译</option>
              </select>
            </label>
            <label>
              模型别名
              <input required value={m.alias} onChange={(e) => setM({ ...m, alias: e.target.value })} />
            </label>
            <label>
              上游模型 ID
              <input required value={m.model_id} onChange={(e) => setM({ ...m, model_id: e.target.value })} />
            </label>
            <label>
              输入单价 / 百万 Token
              <input
                type="number"
                step="any"
                min="0"
                required
                value={m.input}
                onChange={(e) => setM({ ...m, input: Number(e.target.value) })}
              />
            </label>
            <label>
              输出单价 / 百万 Token
              <input
                type="number"
                step="any"
                min="0"
                required
                value={m.output}
                onChange={(e) => setM({ ...m, output: Number(e.target.value) })}
              />
            </label>
          </div>
          <div className="ad-actions">
            <div aria-label="计价币种" className="ad-segments">
              {(["USD", "CNY"] as const).map((cur) => (
                <button
                  type="button"
                  key={cur}
                  data-on={m.currency === cur}
                  onClick={() => setM({ ...m, currency: cur })}
                >
                  {cur}
                </button>
              ))}
            </div>
            <label className="ad-check">
              <input
                type="checkbox"
                checked={m.enabled}
                onChange={(e) => setM({ ...m, enabled: e.target.checked })}
              />
              启用模型
            </label>
          </div>
          <fieldset>
            <legend>Failover 顺序</legend>
            {m.fallback.map((id, i) => (
              <div
                key={id}
                draggable
                onDragStart={() => setDragIndex(i)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  if (dragIndex !== null) order(dragIndex, i);
                  setDragIndex(null);
                }}
                className="ad-labelrow"
              >
                <span className="ad-pair">
                  <GripVertical size={13} />
                  {i + 1}. {models.find((v) => v.id === id)?.alias ?? id}
                </span>
                <div className="ad-actions">
                  <button
                    type="button"
                    className="ad-button"
                    aria-label="上移"
                    disabled={!i}
                    onClick={() => order(i, i - 1)}
                  >
                    <ChevronUp size={12} />
                  </button>
                  <button
                    type="button"
                    className="ad-button"
                    aria-label="下移"
                    disabled={i === m.fallback.length - 1}
                    onClick={() => order(i, i + 1)}
                  >
                    <ChevronDown size={12} />
                  </button>
                  <button
                    type="button"
                    className="ad-button"
                    aria-label="移除备用模型"
                    onClick={() => setM({ ...m, fallback: m.fallback.filter((v) => v !== id) })}
                  >
                    <X size={12} />
                  </button>
                </div>
              </div>
            ))}
            <select
              aria-label="添加备用模型"
              value=""
              onChange={(e) => setM({ ...m, fallback: [...m.fallback, e.target.value] })}
            >
              <option value="">选择备用模型…</option>
              {models
                .filter((v) => v.id !== editor.id && !m.fallback.includes(v.id) && v.enabled)
                .map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.alias}
                  </option>
                ))}
            </select>
          </fieldset>
          <div className="ad-actions">
            <button className="ad-primary" disabled={a.busy}>
              <Save size={14} />
              保存模型
            </button>
            {editor.id && (
              <button
                type="button"
                className="ad-button ad-danger"
                onClick={() => setDeleting({ kind: "models", id: editor.id! })}
              >
                删除模型
              </button>
            )}
          </div>
        </form>
      )}
      {models.length ? (
        <div className="ad-table-wrap">
          <table className="ad-table">
            <thead>
              <tr>
                {["模型别名", "渠道", "协议", "单价 / 百万 Token", "备用模型", ""].map((t, i) => (
                  <th key={i}>{t}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {models.map((row) => {
                const c = row.pricing_currency ?? "USD";
                return (
                  <tr key={row.id}>
                    <td>
                      <b className="ad-mono">{row.alias}</b>
                    </td>
                    <td>{providers.find((v) => v.id === row.provider_id)?.name}</td>
                    <td>{row.protocol}</td>
                    <td className="num">
                      {c} {c === "CNY" ? row.cost_input_cny_per_million : row.cost_input_usd_per_million} /{" "}
                      {c === "CNY" ? row.cost_output_cny_per_million : row.cost_output_usd_per_million}
                    </td>
                    <td>
                      {row.fallback_model_ids.map((id) => models.find((v) => v.id === id)?.alias).join(" → ") ||
                        "—"}
                    </td>
                    <td>
                      <button className="ad-button" onClick={() => editModel(row)}>
                        编辑
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty title="尚未绑定模型" description="添加模型别名后即可在工作台热切换。" />
      )}
    </>
  );
}
