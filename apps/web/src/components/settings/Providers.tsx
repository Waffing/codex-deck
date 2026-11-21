import {GatewayRouting,GlobalSwitch,HealthDots,ProviderSymbol} from "./GatewayRouting";
import {GatewayInspector,GatewayClients} from "./GatewayInspector";
import {OpenApi} from "./OpenApi";
import type {RoutingProfile} from "@codexdeck/shared";
import "./gateway-center.css";
import {ToggleSwitch,SegmentedControl,NumberControl} from "./Controls";
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
import {BenchmarkBoard,ModelLibrary} from "./ModelLibrary";

type ProviderDraft = {
  name: string;
  preset: ProviderPreset;
  base_url: string;
  enabled: boolean;
  strip: boolean;
  forceChat: boolean;
  headers: string;
  key: string;
  extraKeys:string[]; retain:string[]; strategy:"round_robin"|"failover";
  protocol:NonNullable<Provider["protocol_type"]>|""; patch:string; weight:number;rpm:number;daily:number;monthly:number;budgetAction:"alert"|"block";threshold:number;cooldown:number;
  balanceEndpoint:string; balanceToken:string; balanceUser:string;
};
type ModelDraft = {
  alias: string;
  model_id: string;
  provider_id: string;
  protocol: Model["protocol"];
  currency: "USD" | "CNY";
  confirmedFree: boolean;
  input: number;
  output: number;
  cache:number; context:number; maxOutput:number; capabilities:string[];
  fallback: string[];
  enabled: boolean;
};
const blankProvider: ProviderDraft = {
  protocol:"",patch:"{}",weight:100,rpm:0,daily:0,monthly:0,budgetAction:"alert",threshold:3,cooldown:30,
  preset: "custom",
  name: "",
  base_url: "",
  key: "",
  extraKeys:[],retain:[],strategy:"round_robin",balanceEndpoint:"",balanceToken:"",balanceUser:"",
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
  currency: "USD", confirmedFree:false,
  input: 0,
  output: 0,
  cache:0,context:128000,maxOutput:16384,capabilities:[],
  fallback: [],
  enabled: true,
};
type References = {threads:number; fallback:string[]; isDefault:boolean};

export function Providers({ onChanged }: { onChanged?: () => void }) {
  const [providers, setProviders] = useState<Provider[]>([]),
    [models, setModels] = useState<Model[]>([]),
    [presets, setPresets] = useState<Preset[]>([]);
  const [tab,setTab]=useState("厂商切换台"),[routes,setRoutes]=useState<RoutingProfile[]>([]),[passphrase,setPassphrase]=useState("");
  const [health,setHealth]=useState<{provider_id:string;states:number[];availability:number|null;circuit:{state:string}}[]>([]);
  const [editor, setEditor] = useState<{ type: "provider" | "model"; id?: string } | null>(null);
  const [p, setP] = useState<ProviderDraft>(blankProvider),
    [m, setM] = useState<ModelDraft>(blankModel);
  const [deleting, setDeleting] = useState<{ kind: "providers" | "models"; id: string } | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [defaultAlias,setDefaultAlias]=useState<string|null>(null);
  const [refs,setRefs]=useState<References|null>(null);
  const [replacement,setReplacement]=useState("");
  const inspectId=useRef<string|undefined>(undefined);
  const file = useRef<HTMLInputElement | null>(null);
  const a = useAction();
  const [library,setLibrary]=useState<Provider|null>(null);
  async function load() {
    const [ps, ms, ts, current] = await Promise.all([
      api<Provider[]>("/api/providers"),
      api<Model[]>("/api/models"),
      api<Preset[]>("/api/providers/presets"),
      api<{alias:string|null}>("/api/models/default"),
    ]);
    const [routeRows,matrix]=await Promise.all([api<RoutingProfile[]>("/api/routing-profiles"),api<{providers:typeof health}>("/api/providers/health-matrix")]);
    setRoutes(routeRows);setHealth(matrix.providers);
    setProviders(ps);
    setModels(ms);
    setPresets(ts);
    setDefaultAlias(current.alias);
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
            protocol:row.protocol_type??"",patch:JSON.stringify(row.patch_rules??{},null,2),
            weight:row.weight??100,rpm:row.rpm_limit??0,daily:row.daily_budget??0,monthly:row.monthly_budget??0,budgetAction:row.budget_action??"alert",
            threshold:row.circuit_breaker?.failure_threshold??3,cooldown:row.circuit_breaker?.cooldown_seconds??30,
            name: row.name,
            preset: row.preset,
            base_url: row.base_url,
            enabled: row.enabled,
            key: "",
            extraKeys:[],retain:(row.keys??[]).map(k=>k.id),strategy:row.rotation_strategy??"round_robin",
            balanceEndpoint:row.balance_endpoint??"",balanceToken:"",balanceUser:row.balance_user_id??"",
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
    setRefs(null);
    setReplacement("");
    inspectId.current=row?.id;
    if(row) void a.run(async()=>{
      const current=await api<References>(`/api/models/${row.id}/references`);
      if(inspectId.current===row.id) setRefs(current);
    });
    const c = row?.pricing_currency ?? "USD";
    setM(
      row
        ? {
            alias: row.alias,
            model_id: row.model_id,
            provider_id: row.provider_id,
            enabled: row.enabled,
            protocol: row.protocol,
            currency: c,confirmedFree:row.confirmed_free??false,
            input: c === "USD" ? row.cost_input_usd_per_million : (row.cost_input_cny_per_million ?? 0),
            output: c === "USD" ? row.cost_output_usd_per_million : (row.cost_output_cny_per_million ?? 0),
            fallback: row.fallback_model_ids,
            context:row.context_window??128000,maxOutput:row.max_output_tokens??16384,
            cache:row.cache_read_price_per_1m??0,capabilities:row.capabilities??[],
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
        protocol_type:p.protocol||null,patch_rules:JSON.parse(p.patch),weight:p.weight,rpm_limit:p.rpm,daily_budget:p.daily,monthly_budget:p.monthly,budget_action:p.budgetAction,
        circuit_breaker:{failure_threshold:p.threshold,cooldown_seconds:p.cooldown},name: p.name,
        preset: p.preset,
        base_url: p.base_url,
        enabled: p.enabled,
        quirks: { strip_reasoning: p.strip, force_chat: p.forceChat },
        api_keys:[p.key,...p.extraKeys].map(k=>k.trim()).filter(Boolean),
        ...(id&&{retain_key_ids:p.retain}), rotation_strategy:p.strategy,
        balance_endpoint:p.balanceEndpoint.trim()||null, balance_user_id:p.balanceUser.trim()||null,
        ...(p.balanceToken&&{balance_token:p.balanceToken}),
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
        pricing_currency: m.currency,confirmed_free:m.input===0 && m.output===0 && m.cache===0 && m.confirmedFree,
        ["cost_input_" + cur + "_per_million"]: m.input,
        ["cost_output_" + cur + "_per_million"]: m.output,
        fallback_model_ids: m.fallback,
        context_window:m.context,max_output_tokens:m.maxOutput,cache_read_price_per_1m:m.cache,capabilities:m.capabilities,
      }),
    );
    setEditor(null);
    await changed();
  }
  async function exportChannels(mode:"redacted"|"encrypted") {
    const data=await api("/api/providers/export",json("POST",{mode,...(mode==="encrypted"&&{passphrase})}));
    const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:"application/json"}));
    setPassphrase("");
    const link = document.createElement("a");
    link.href = url;
    link.download = "codexdeck-providers.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 500);
  }
  async function importChannel(f: File) {
    const doc = JSON.parse(await f.text());
    if(doc.format==="codexdeck-config-v1"){
      await api("/api/providers/import",json("POST",{bundle:doc,...(doc.mode==="encrypted"&&{passphrase})}));
      setPassphrase("");await changed();return;
    }
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
        title="API 指挥中心"
        actions={
          <button className="ad-primary" onClick={() => {setTab("厂商切换台");editProvider()}}>
            <Plus size={15} />
            添加渠道
          </button>
        }
      />
      <div role="tablist" aria-label="API 指挥中心" className="gw-tabs">{["厂商切换台","虚拟路由与模型库","请求检视器","外部接入与配额"].map(t=><button key={t} type="button" role="tab" aria-selected={tab===t} onClick={()=>{setTab(t);setEditor(null);setDeleting(null)}}>{t}</button>)}</div>
      <Feedback error={a.error} notice={a.notice} busy={a.busy} />
      {tab==="请求检视器" && <GatewayInspector providers={providers}/>}
      {tab==="外部接入与配额" && <><GatewayClients models={models} routes={routes}/><OpenApi showLedger={false}/></>}
      {tab==="厂商切换台" && <>
      <GlobalSwitch routes={routes} models={models} changed={changed} configure={()=>setTab("虚拟路由与模型库")}/>
      <div className="ad-subhead">
        <h2>供应商渠道</h2>
        <div className="ad-actions">
          <button className="ad-button" onClick={() => file.current?.click()}>
            <Upload size={13} />
            导入
          </button>
          <button className="ad-button" onClick={()=>void a.run(()=>exportChannels("redacted"),"已导出脱敏配置")}>
            <Download size={13} />
            脱敏导出
          </button>
          <details className="gw-bundle"><summary>加密迁移</summary><label>迁移口令<input type="password" autoComplete="new-password" minLength={12} value={passphrase} placeholder="至少 12 个字符" onChange={e=>setPassphrase(e.target.value)}/></label>
            <button className="ad-button" disabled={passphrase.length<12} onClick={()=>void a.run(()=>exportChannels("encrypted"),"已导出加密配置")}>导出加密包</button>
            <button className="ad-button" disabled={passphrase.length<12} onClick={()=>file.current?.click()}>导入加密包</button></details>
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
      {editor?.type === "provider" && (
        <div className="gw-backdrop"><form role="dialog" aria-label={editor.id?"编辑渠道":"添加渠道"} className="ad-form-panel ad-form gw-drawer"
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
          {!editor.id&&<div className="gw-presets">{presets.map(t=><button type="button" key={t.id} aria-pressed={p.preset===t.id} onClick={()=>setP({...p,name:t.label,preset:t.id,base_url:t.defaultBaseUrl??"",protocol:t.protocol_type??"",patch:JSON.stringify(t.patch_rules??{},null,2)})}><ProviderSymbol preset={t.id} name={t.label}/>{t.label}</button>)}</div>}
          <div className="ad-form-grid">
            <label>
              供应商预设
              <select
                value={p.preset}
                onChange={(e) => {
                  const t = presets.find((r) => r.id === e.target.value)!;
                  setP({ ...p, preset: t.id, base_url: t.defaultBaseUrl ?? "", name: t.label,protocol:t.protocol_type??"",patch:JSON.stringify(t.patch_rules??{},null,2) });
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
          <details><summary>协议、修补与配额</summary><div className="ad-form-grid">
            <label>出站协议<select value={p.protocol} onChange={e=>setP({...p,protocol:e.target.value as ProviderDraft["protocol"]})}>{[["","按模型自动选择"],["openai_responses","Responses"],["openai_chat","Chat Completions"],["anthropic_messages","Anthropic Messages"],["gemini_openai","Gemini OpenAI"]].map(([v,t])=><option key={v} value={v}>{t}</option>)}</select></label>
            {([["weight","路由权重",1,1000],["rpm","每分钟请求数",0,1000000],["daily","每日预算",0,undefined],["monthly","每月预算",0,undefined],["threshold","连续失败阈值",1,100],["cooldown","冷却秒数",1,86400]] as const).map(([k,label,min,max])=><label key={k}>{label}<input type="number" value={p[k]} min={min} max={max} step={k==="daily"||k==="monthly"?"any":1} onChange={e=>setP({...p,[k]:Number(e.target.value)})}/></label>)}
            <label>超出预算<select value={p.budgetAction} onChange={e=>setP({...p,budgetAction:e.target.value as ProviderDraft["budgetAction"]})}><option value="alert">告警</option><option value="block">阻止请求</option></select></label>
            <label>修补规则 JSON<textarea rows={5} value={p.patch} onChange={e=>setP({...p,patch:e.target.value})} placeholder='{"developer_to_system":true,"include_usage":true}'/></label>
          </div></details>
          <fieldset><legend>Key 轮询池</legend>
            {providers.find(row=>row.id===editor.id)?.keys?.map(k=><label key={k.id} className="ad-check">
              <ToggleSwitch checked={p.retain.includes(k.id)} onCheckedChange={next=>setP({...p,retain:next?[...p.retain,k.id]:p.retain.filter(id=>id!==k.id)})}/>
              保留 {k.masked} · {k.status}</label>)}
            {p.extraKeys.map((key,i)=><label key={i}>附加 Key {i+1}<input type="password" autoComplete="new-password" value={key} onChange={e=>setP({...p,extraKeys:p.extraKeys.map((old,n)=>i===n?e.target.value:old)})}/></label>)}
            <button type="button" className="ad-button" onClick={()=>setP({...p,extraKeys:[...p.extraKeys,""]})}>添加另一个 Key</button>
            <label>轮询策略<SegmentedControl value={p.strategy} onValueChange={next=>setP({...p,strategy:next as ProviderDraft["strategy"]})}>
              <option value="round_robin">按序轮询</option><option value="failover">仅故障切换</option></SegmentedControl></label></fieldset>
          <details><summary>余额查询凭证</summary>
            <label>余额端点<input type="url" placeholder="使用厂商预设" value={p.balanceEndpoint} onChange={e=>setP({...p,balanceEndpoint:e.target.value})}/></label>
            <label>余额管理令牌<input type="password" autoComplete="new-password" placeholder="留空保留" value={p.balanceToken} onChange={e=>setP({...p,balanceToken:e.target.value})}/></label>
            <label>余额用户 ID<input value={p.balanceUser} onChange={e=>setP({...p,balanceUser:e.target.value})}/></label></details>
          <details>
            <summary>高级适配</summary>
            <label className="ad-check">
              <ToggleSwitch
                checked={p.forceChat}
                onCheckedChange={next=> setP({ ...p, forceChat: next })}
              />
              强制 Chat Completions 转译
            </label>
            <label className="ad-check">
              <ToggleSwitch checked={p.strip} onCheckedChange={next=> setP({ ...p, strip: next })} />
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
            <ToggleSwitch
              checked={p.enabled}
              onCheckedChange={next=> setP({ ...p, enabled: next })}
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
        {deleteConfirm}<Feedback error={a.error}/></form></div>
      )}
      {library&&<ModelLibrary provider={library} close={()=>setLibrary(null)} changed={changed}/>}
      {!providers.length ? (
        <Empty title="尚未连接供应商" description="添加 OpenAI 或兼容 API 渠道，再为工作区绑定模型。" />
      ) : (
        <div className="ad-grid">
          {providers.map((row) => (
            <article key={row.id} className="ad-card">
              <div className="ad-labelrow">
                <div className="ad-pair">
                  <ProviderSymbol name={row.name} preset={row.preset}/>
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
              <div className="ad-pill-group" aria-label="已保存密钥">{row.keys?.map(key=><span key={key.id} className="ad-pill" title={key.cooldown_until??undefined}>
                <i className={"status-dot "+(key.status==="ready"?"running":key.status==="unauthorized"?"failed":"pending")}/>{key.masked} · {key.status}</span>)}</div>
              <div className="ad-balance"><span>余额</span> <strong>{row.last_balance?.amount!=null?`${row.last_balance.amount.toLocaleString()} ${row.last_balance.unit}`:"—"}</strong>
                {row.last_balance&&<small>
                  {({ok:"已更新",unsupported:"上游不支持余额查询",unauthorized:"余额凭证未获授权",error:"刷新失败"})[row.last_balance.status]}
                  {" · "}{new Date(row.last_balance.checked_at).toLocaleString()} {row.last_balance.error}
                  {row.last_balance.status!=="ok"&&row.last_balance.balance_at&&` · 余额取自 ${new Date(row.last_balance.balance_at).toLocaleString()}`}
                </small>}</div>
              <div className="ad-pill-group"><span className="ad-pill">{row.protocol_type??"自动协议"}</span><span className="ad-pill">{(row.keys??[]).filter(k=>k.status==="ready").length}/{row.keys?.length??0} Key 可用</span></div>
              <HealthDots health={health.find(h=>h.provider_id===row.id)} reset={()=>void a.run(async()=>{await api("/api/providers/"+row.id+"/reset-circuit",json("POST",{}));await changed()},"熔断器已复位")}/>
              <Abilities probe={row.last_probe} />
              {row.last_probe?.error && <small>{row.last_probe.error}</small>}
              <div className="ad-actions">
                <button className="ad-button" onClick={()=>setLibrary(row)}>从上游获取模型</button>
                <button className="ad-button" disabled={a.busy} onClick={()=>void a.run(async()=>{await api(`/api/providers/${row.id}/balance`,json("POST",{}));await changed()})}>刷新余额</button>
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
      </>}
      {tab==="虚拟路由与模型库"&&<>
      <GatewayRouting routes={routes} models={models} changed={changed}/>
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
              <SegmentedControl
                value={m.protocol}
                onValueChange={next=> setM({ ...m, protocol: next as Model["protocol"] })}
              >
                <option value="auto">自动选择</option>
                <option value="responses">Responses 原生</option>
                <option value="chat">强制 Chat Completions 转译</option>
              </SegmentedControl>
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
              <NumberControl
                step="any"
                min="0"
                required
                value={m.input}
                onChange={(e) => setM({ ...m, input: Number(e.target.value) })}
              />
            </label>
            <label>上下文窗口<NumberControl required min="1" step="1" value={m.context} onChange={e=>setM({...m,context:Number(e.target.value)})}/></label>
            <label>最大输出 Token<NumberControl min="1" step="1" max={m.context} required value={m.maxOutput} onChange={e=>setM({...m,maxOutput:Number(e.target.value)})}/></label>
            <label>缓存读取单价 / 百万 Token<NumberControl min="0" step="any" required value={m.cache} onChange={e=>setM({...m,cache:Number(e.target.value)})}/></label>
            <label>
              输出单价 / 百万 Token
              <NumberControl
                step="any"
                min="0"
                required
                value={m.output}
                onChange={(e) => setM({ ...m, output: Number(e.target.value) })}
              />
            </label>
          </div>
          <div className="ad-actions">
            {m.input===0 && m.output===0 && m.cache===0 && <label className="ad-check"><ToggleSwitch checked={m.confirmedFree} onCheckedChange={confirmedFree=>setM({...m,confirmedFree})}/>确认此模型免费</label>}
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
            <div aria-label="上下文预设" className="ad-segments">{[32,64,128,200,256,400,1000].map(k=><button type="button" key={k} data-on={m.context===k*1000}
              onClick={()=>setM({...m,context:k*1000,maxOutput:Math.min(m.maxOutput,k*1000)})}>{k===1000?"1M":k+"K"}</button>)}</div>
            <div role="group" aria-label="模型能力标注" className="ad-segments">
              {Object.entries({tools:"工具调用",vision:"图片输入",reasoning:"推理",reasoning_summary:"公开推理摘要"}).map(([tag,label])=>{
                const active=m.capabilities.includes(tag);
                return <button type="button" key={tag} aria-pressed={active} data-on={active}
                  onClick={()=>setM({...m,capabilities:active?m.capabilities.filter(v=>v!==tag):[...m.capabilities,tag]})}>{label}</button>;
              })}
            </div>
            <label className="ad-check">
              <ToggleSwitch
                checked={m.enabled}
                onCheckedChange={next=> setM({ ...m, enabled: next })}
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
            <SegmentedControl
              aria-label="添加备用模型"
              value=""
              onValueChange={next=> setM({ ...m, fallback: [...m.fallback, next] })}
            >
              <option value="">选择备用模型…</option>
              {models
                .filter((v) => v.id !== editor.id && !m.fallback.includes(v.id) && v.enabled)
                .map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.alias}
                  </option>
                ))}
            </SegmentedControl>
          </fieldset>
          {editor.id && refs && <fieldset>
            <legend>模型引用</legend>
            <p>{refs.threads} 个会话 · {refs.fallback.length} 条备用路由{refs.isDefault && " · 当前默认模型"}</p>
            {(refs.threads>0 || refs.fallback.length>0 || refs.isDefault) && <>
              <label>迁移到<SegmentedControl value={replacement} onValueChange={next=>setReplacement(next)}>
                <option value="">选择可用模型…</option>
                {models.filter(row=>row.id!==editor.id && row.enabled && providers.some(p=>p.id===row.provider_id && p.enabled))
                  .map(row=><option key={row.id} value={row.id}>{row.alias}</option>)}
              </SegmentedControl></label>
              <button type="button" className="ad-button" disabled={!replacement || a.busy} onClick={()=>void a.run(async()=>{
                const remaining=await api<References>(`/api/models/${editor.id}/replace`,json("POST",{replacement_id:replacement}));
                setRefs(remaining);
                await changed();
              },"模型引用已迁移")}>确认迁移全部引用</button>
            </>}
          </fieldset>}
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
                      {row.alias===defaultAlias && <small> 默认</small>}
                    </td>
                    <td>{providers.find((v) => v.id === row.provider_id)?.name}</td>
                    <td>{row.protocol} · {(row.context_window??128000).toLocaleString()} ctx<Abilities probe={row.last_probe ?? null}/>{row.capabilities?.map(c=><span className="ad-pill" key={c}>{c}</span>)}</td>
                    <td className="num">
                      {c} {c === "CNY" ? row.cost_input_cny_per_million : row.cost_input_usd_per_million} /{" "}
                      {c === "CNY" ? row.cost_output_cny_per_million : row.cost_output_usd_per_million}
                    </td>
                    <td>
                      <button className="ad-button" disabled={a.busy || !row.enabled || !providers.some(p=>p.id===row.provider_id && p.enabled)} onClick={()=>void a.run(async()=>{
                        const result=await api<ProbeResult>(`/api/providers/${row.provider_id}/probe`,json("POST",{model_id:row.id}));
                        await changed();
                        if(!result.ok) throw new Error(result.error ?? "模型探测失败");
                      },"模型探测完成")}>探测此模型</button>
                      {row.alias!==defaultAlias && <button className="ad-button" disabled={a.busy || !row.enabled || !providers.some(p=>p.id===row.provider_id && p.enabled)} onClick={()=>void a.run(async()=>{
                        await api("/api/models/default",json("PUT",{alias:row.alias}));
                        await changed();
                      },"默认模型已更新")}>设为默认</button>}
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
      {deleteConfirm}
      <BenchmarkBoard current={defaultAlias} models={models.filter(m=>m.enabled&&providers.some(p=>p.id===m.provider_id&&p.enabled))} changed={changed}/>
      </>}
    </>
  );
}
