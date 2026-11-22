import { useEffect, useState } from "react";
import { Activity, BookOpen, KeyRound, Plug, RefreshCw, Server, ShieldCheck, Users, Wrench } from "lucide-react";
import type { ApiKey, Deployment, Provider, ServerProfile } from "@codexdeck/shared";
import { api } from "../../lib/api";
import { Providers, type ProviderTab } from "./Providers";
import { UsageLedger } from "./UsageLedger";
import { Services } from "../ops/Services";
import { Feedback, useAction } from "./common";
import type { AdminDrawer } from "./common";

type ApiTab = "overview" | "providers" | "models" | "clients" | "activity";

const tabs: Array<{ id: ApiTab; label: string; icon: typeof Server }> = [
  { id: "overview", label: "服务总览", icon: Server },
  { id: "providers", label: "供应商", icon: Users },
  { id: "models", label: "模型与路由", icon: Wrench },
  { id: "clients", label: "客户端接入", icon: KeyRound },
  { id: "activity", label: "请求与账本", icon: Activity },
];

type Snapshot = {
  deployments: Deployment[];
  providers: Provider[];
  keys: ApiKey[];
  profile: ServerProfile | null;
};

export function ApiServiceCockpit({
  initialTab = "overview",
  onDrawer,
  onChanged,
  onNavigate,
}: {
  initialTab?: ApiTab;
  onDrawer: (drawer: AdminDrawer) => void;
  onChanged?: () => void;
  onNavigate?: (view: "mcp") => void;
}) {
  const [tab, setTab] = useState<ApiTab>(initialTab);
  const [snapshot, setSnapshot] = useState<Snapshot>({
    deployments: [],
    providers: [],
    keys: [],
    profile: null,
  });
  const [loaded, setLoaded] = useState(false);
  const action = useAction();

  async function load() {
    const [deployments, providers, keys, profile] = await Promise.all([
      api<Deployment[]>("/api/deployments"),
      api<Provider[]>("/api/providers"),
      api<ApiKey[]>("/api/api-keys"),
      api<ServerProfile>("/api/server/profile"),
    ]);
    setSnapshot({ deployments, providers, keys, profile });
    setLoaded(true);
  }

  async function refreshAll() {
    await load();
    onChanged?.();
  }

  useEffect(() => {
    void action.run(load);
  }, []);

  const running = snapshot.deployments.filter((deployment) =>
    ["staging", "live", "rolled_back"].includes(deployment.status),
  ).length;
  const activeKeys = snapshot.keys.filter((key) => !key.revoked_at).length;
  const enabledProviders = snapshot.providers.filter((provider) => provider.enabled).length;

  function setView(next: ApiTab) {
    setTab(next);
    window.requestAnimationFrame(() => {
      document.querySelector(".api-cockpit-tabs [aria-selected='true']")?.scrollIntoView({
        block: "nearest",
        inline: "nearest",
      });
    });
  }

  function renderProviders(initialProviderTab: ProviderTab, description: string) {
    return (
      <Providers
        key={initialProviderTab}
        initialTab={initialProviderTab}
        embedded
        description={description}
        onChanged={refreshAll}
        onGoToModels={() => setView("models")}
      />
    );
  }

  return (
    <div className="api-cockpit">
      <div className="api-cockpit-crumb">
        <span>控制台</span>
        <span aria-hidden="true">/</span>
        <strong>API 指挥中心</strong>
      </div>
      <div className="api-cockpit-hero">
        <div>
          <h1>API 指挥中心</h1>
          <p>管理上游供应商、模型路由、客户端凭证与请求用量。</p>
        </div>
        <div className="api-cockpit-hero-actions">
          {onNavigate && (
            <button className="ad-button" onClick={() => onNavigate("mcp")} title="打开 MCP 工具管理">
              <Plug size={14} />
              MCP 工具
            </button>
          )}
          <a className="ad-button" href="/api/openapi.json" target="_blank" rel="noreferrer">
            <BookOpen size={14} />
            OpenAPI 文档
          </a>
        </div>
      </div>
      <div className="api-cockpit-runtime">
        <div className="api-cockpit-runtime-main">
          <span className="api-cockpit-runtime-icon">
            <Server size={18} />
          </span>
          <div>
            <strong>{snapshot.profile?.os ?? "本地服务节点"}</strong>
            <small>
              <i className={"api-status-dot " + (snapshot.profile ? "running" : "idle")} />
              {!loaded ? "正在读取服务状态" : snapshot.profile ? "服务状态正常" : "暂未获取服务状态"}
              {snapshot.profile?.checked_at ? ` · 最近体检 ${new Date(snapshot.profile.checked_at).toLocaleString()}` : ""}
            </small>
          </div>
        </div>
        <div className="api-cockpit-runtime-actions">
          <button className="ad-button" disabled={action.busy} onClick={() => void action.run(load, "状态已刷新")}>
            <RefreshCw size={14} />
            刷新状态
          </button>
          <button className="ad-button" onClick={() => setView("activity")}>
            <Activity size={14} />
            请求与账本
          </button>
        </div>
      </div>
      <div className="api-cockpit-metrics" aria-label="API 服务摘要">
        <div><small>运行中服务</small><strong>{loaded ? running : "—"}</strong><span>{loaded ? "个实例" : "等待读取"}</span></div>
        <div><small>已启用供应商</small><strong>{loaded ? enabledProviders : "—"}</strong><span>{loaded ? `共 ${snapshot.providers.length} 个渠道` : "等待读取"}</span></div>
        <div><small>有效客户端 Key</small><strong>{loaded ? activeKeys : "—"}</strong><span>{loaded ? "个" : "等待读取"}</span></div>
        <div><small>密钥处理</small><strong className="api-metric-good"><ShieldCheck size={17} />正常</strong><span>查询仅显示脱敏信息</span></div>
      </div>
      <nav className="api-cockpit-tabs" role="tablist" aria-label="API 指挥中心分类">
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            role="tab"
            type="button"
            aria-selected={tab === id}
            onClick={() => setView(id)}
          >
            <Icon size={14} />
            {label}
          </button>
        ))}
      </nav>
      <Feedback busy={action.busy} notice={action.notice} error={action.error} />
      <section className="api-cockpit-panel" role="tabpanel">
        {tab === "overview" && <Services onDrawer={onDrawer} />}
        {tab === "clients" && renderProviders("外部接入与配额", "管理客户端访问密钥、模型授权范围和连接配置。")}
        {tab === "providers" && renderProviders("厂商切换台", "维护上游地址、密钥池、余额状态和连接能力。")}
        {tab === "models" && renderProviders("虚拟路由与模型库", "管理模型别名、上下文、定价、能力与备用顺序。")}
        {tab === "activity" && (
          <>
            {renderProviders("请求检视器", "查看请求状态、上游耗时、Token 用量与回退记录。")}
            <UsageLedger />
          </>
        )}
      </section>
    </div>
  );
}
