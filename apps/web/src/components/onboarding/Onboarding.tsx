import { useEffect, useState } from "react";
import type { Model, OnboardingStatus, Provider, ProviderPreset, ProbeResult, Workspace } from "@codexdeck/shared";
import {
  ArrowRight,
  Cable,
  Check,
  ChevronRight,
  Cpu,
  Eye,
  EyeOff,
  FolderGit2,
  KeyRound,
  Layers3,
  LockKeyhole,
  ShieldCheck,
  Terminal,
  Workflow,
} from "lucide-react";
import { api, json } from "../../lib/api";
import { Abilities, Feedback, useAction, type Preset } from "../settings/common";
import "../settings/admin.css";
import "./onboarding.css";

const steps = [
  { title: "管理员账户", hint: "设置控制台访问凭据", Icon: KeyRound },
  { title: "模型网关", hint: "连接第三方 API 并验证协议", Icon: Cable },
  { title: "项目工作区", hint: "选择目录或克隆仓库", Icon: FolderGit2 },
];
const modelSuggestions: Partial<Record<ProviderPreset, string>> = {
  openai_official: "gpt-4.1",
  openrouter: "openai/gpt-4.1",
  deepseek: "deepseek-chat",
  ollama: "",
};

function Topology({ step }: { step: number }) {
  return (
    <div className="ob-circuit" aria-hidden="true">
      <div className="ob-grid" />
      <div className="ob-diagram">
        <div className="ob-wire one" />
        <div className="ob-wire two" />
        <div className="ob-wire three" />
        <div className="ob-wire four" />
        <div className="ob-pad pad-one" />
        <div className="ob-pad pad-two" />
        <div className="ob-pad pad-three" />
        <div className="ob-pad pad-four" />
        <div className="ob-board bottom" />
        <div className="ob-board middle" />
        <div className="ob-board top">
          <div className="ob-chip">
            <Cpu size={34} />
          </div>
          <i />
          <i />
          <i />
        </div>
      </div>
      <div className="ob-node node-auth">
        <ShieldCheck size={13} />
        <span>ADMIN</span>
        <b data-lit={step >= 0} />
      </div>
      <div className="ob-node node-gateway">
        <Workflow size={13} />
        <span>GATEWAY</span>
        <b data-lit={step >= 1} />
      </div>
      <div className="ob-node node-work">
        <FolderGit2 size={13} />
        <span>WORKSPACE</span>
        <b data-lit={step >= 2} />
      </div>
    </div>
  );
}

export function Onboarding({ onComplete }: { onComplete: (showProfile: boolean) => void }) {
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [step, setStep] = useState(0);
  const [setupCode, setSetupCode] = useState("");
  const [password, setPassword] = useState(""),
    [confirm, setConfirm] = useState(""),
    [visible, setVisible] = useState(false);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [preset, setPreset] = useState<ProviderPreset>("openai_official");
  const [base, setBase] = useState("https://api.openai.com/v1"),
    [key, setKey] = useState(""),
    [modelId, setModelId] = useState("gpt-4.1");
  const [provider, setProvider] = useState<Provider | null>(null),
    [model, setModel] = useState<Model | null>(null);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [mode, setMode] = useState("new"),
    [name, setName] = useState(""),
    [url, setUrl] = useState(""),
    [dir, setDir] = useState("");
  const [directories, setDirectories] = useState<string[]>([]);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const a = useAction();
  const login = !!status && !status.authenticated && !status.setup_required;

  async function sync() {
    const state = await api<OnboardingStatus>("/api/onboarding/status");
    setStatus(state);
    if (!state.authenticated) {
      setStep(0);
      return;
    }
    if (state.completed) {
      onComplete(false);
      return;
    }
    const [templates, ps, ms, ws, dirs] = await Promise.all([
      api<Preset[]>("/api/providers/presets"),
      api<Provider[]>("/api/providers"),
      api<Model[]>("/api/models"),
      api<Workspace[]>("/api/workspaces"),
      api<{ directories: string[] }>("/api/workspaces/local-directories"),
    ]);
    setPresets(templates);
    setDirectories(dirs.directories);
    const linked = ms.find((m) => m.enabled && ps.some((p) => p.id === m.provider_id && p.enabled));
    const channel = (linked && ps.find((p) => p.id === linked.provider_id)) || ps.find((p) => p.enabled);
    if (channel) {
      setProvider(channel);
      setPreset(channel.preset);
      setBase(channel.base_url);
      setProbe(channel.last_probe);
    }
    if (linked) {
      setModel(linked);
      setModelId(linked.model_id);
    }
    setWorkspace(ws.find((w) => w.status === "ready") ?? null);
    setStep(linked ? 2 : 1);
  }
  useEffect(() => {
    void sync().catch((e) => a.setError(String(e)));
  }, []);
  async function account() {
    if (!login && password !== confirm) throw new Error("两次输入的密码不一致。");
    await api(login ? "/api/auth/login" : "/api/auth/setup", json("POST", login ? { password } : { password, setup_code:setupCode.trim() }));
    setSetupCode("");
    setPassword("");
    setConfirm("");
    setVisible(false);
    await sync();
  }
  async function connect() {
    if (!base.trim() || !modelId.trim()) throw new Error("请输入接口地址和模型 ID。");
    const info = {
      name: presets.find((p) => p.id === preset)?.label ?? preset,
      preset,
      base_url: base,
      ...(key && { api_key: key }),
    };
    const next = await api<Provider>(
      provider ? "/api/providers/" + provider.id : "/api/providers",
      json(provider ? "PATCH" : "POST", info),
    );
    setProvider(next);
    setKey("");
    const updated = await api<Model>(
      model ? "/api/models/" + model.id : "/api/models",
      json(model ? "PATCH" : "POST", { provider_id: next.id, alias: modelId.trim(), model_id: modelId.trim() }),
    );
    setModel(updated);
    setProbe(await api<ProbeResult>("/api/providers/" + next.id + "/probe", json("POST", {})));
  }
  async function finish() {
    let ws = workspace;
    if (!ws) {
      const endpoint = mode === "clone" ? "clone" : mode === "import" ? "import" : "";
      const body =
        mode === "import"
          ? { directory: dir, name: name.trim() || dir }
          : mode === "clone"
            ? { url, name: name.trim() }
            : { name: name.trim() };
      ws = await api<Workspace>("/api/workspaces" + (endpoint ? "/" + endpoint : ""), json("POST", body));
      setWorkspace(ws);
    }
    while (ws.status === "cloning") {
      await new Promise((resolve) => setTimeout(resolve, 600));
      const list = await api<Workspace[]>("/api/workspaces");
      const updated = list.find((w) => w.id === ws?.id);
      if (!updated) throw new Error("找不到正在克隆的工作区。");
      ws = updated;
      setWorkspace(ws);
    }
    if (ws.status !== "ready") {
      setWorkspace(null);
      throw new Error("克隆失败，请检查 HTTPS 仓库地址后重试。");
    }
    await api("/api/onboarding/complete", json("POST", {}));
    onComplete(true);
  }
  function choosePreset(id: ProviderPreset) {
    setPreset(id);
    setBase(presets.find((p) => p.id === id)?.defaultBaseUrl ?? "");
    setModelId(modelSuggestions[id] ?? "");
    setProbe(null);
  }
  const title = login ? "登录控制台" : ["设置管理员账户", "连接模型网关", "创建项目工作区"][step];
  const hints = login
    ? "使用管理员密码进入当前实例。"
    : [
        "为本机控制台设置密码。后续会话、审批与环境设置均由此账户管理。",
        "选择供应商，验证网关路由并绑定工作台的第一个模型。",
        "选择项目的来源。Codex 会在这个工作区内读取文件并建立 Git 快照。",
      ][step];
  const Icon = login ? LockKeyhole : steps[step].Icon;
  return (
    <main className="ob-root">
      <header className="ob-top">
        <div className="ob-brand">
          <span className="ob-brand-mark">
            <Terminal size={21} />
          </span>
          CodexDeck
        </div>
        <span className="ob-local">
          <i />
          本地控制台
        </span>
      </header>
      <div className="ob-main">
        <section className="ob-rail">
          <div className="ob-caption">
            <Layers3 size={15} />
            {login ? "工作台连接" : "工作台初始化"}
          </div>
          <h1>
            {login ? "连接你的工作台" : "配置你的工作台"}
            <span>.</span>
          </h1>
          <Topology step={step} />
          <ol className="ob-steps">
            {steps.map(({ title: t, hint, Icon: I }, i) => (
              <li key={t} data-active={!login && i === step} data-done={login || i < step}>
                <span className="ob-step-icon">{login || i < step ? <Check size={17} /> : <I size={17} />}</span>
                <div>
                  <strong>{t}</strong>
                  <small>{hint}</small>
                </div>
              </li>
            ))}
          </ol>
        </section>
        <section className="ob-card">
          <div className="ob-card-top">
            <span className="ob-eyebrow">{login ? "管理员登录" : `初始配置　 /　 0${step + 1} OF 03`}</span>
            <span className="ob-bars">
              {steps.map((_, i) => (
                <i key={i} data-filled={login || i <= step} />
              ))}
            </span>
          </div>
          <div className="ob-card-body">
            <span className="ob-form-icon">
              <Icon size={22} />
            </span>
            <h2>{title}</h2>
            <p>{hints}</p>
            {!status ? (
              <div className="ad-message">正在读取控制台状态…</div>
            ) : step === 0 ? (
              <form
                className="ad-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void a.run(account);
                }}
              >
                {!login && <label>安装码<input type="password" autoComplete="off" value={setupCode} onChange={e=>setSetupCode(e.target.value)} placeholder="安装机数据目录中的 setup-code" required /></label>}
                <label>
                  管理员密码
                  <div className="ob-password">
                    <input
                      aria-label="管理员密码"
                      autoComplete={login ? "current-password" : "new-password"}
                      type={visible ? "text" : "password"}
                      value={password}
                      required
                      minLength={login ? 1 : 12}
                      placeholder={login ? "输入管理员密码" : "至少 12 个字符"}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                    <button
                      type="button"
                      aria-label={visible ? "隐藏密码" : "显示密码"}
                      onClick={() => setVisible((v) => !v)}
                    >
                      {visible ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                </label>
                {!login && (
                  <label>
                    确认密码
                    <input
                      type={visible ? "text" : "password"}
                      autoComplete="new-password"
                      placeholder="再次输入密码"
                      required
                      value={confirm}
                      onChange={(e) => setConfirm(e.target.value)}
                    />
                  </label>
                )}
                <Feedback error={a.error} busy={a.busy} />
                <button className="ad-primary ob-submit" disabled={a.busy}>
                  {login ? "登录" : "创建管理员"}
                  <ArrowRight size={16} />
                </button>
              </form>
            ) : step === 1 ? (
              <form
                className="ad-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void a.run(connect);
                }}
              >
                <label>
                  供应商预设
                  <select value={preset} onChange={(e) => choosePreset(e.target.value as ProviderPreset)}>
                    {presets.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  接口地址
                  <input
                    type="url"
                    value={base}
                    placeholder="https://example.com/v1"
                    required
                    onChange={(e) => {
                      setBase(e.target.value);
                      setProbe(null);
                    }}
                  />
                </label>
                <label>
                  API Key
                  <input
                    type="password"
                    value={key}
                    placeholder={provider?.api_key_masked ?? "无密钥的本地服务可留空"}
                    autoComplete="off"
                    onChange={(e) => {
                      setKey(e.target.value);
                      setProbe(null);
                    }}
                  />
                </label>
                <label>
                  模型 ID
                  <input
                    value={modelId}
                    placeholder="输入上游模型 ID"
                    required
                    onChange={(e) => {
                      setModelId(e.target.value);
                      setProbe(null);
                    }}
                  />
                </label>
                {probe && (
                  <div className="ob-probe" role="status">
                    <strong>{probe.ok ? "连接成功" : "探测未通过"}</strong>
                    <Abilities probe={probe} />
                    {!probe.ok && (
                      <small>
                        {probe.error?.includes("protected") ? "当前端口受探测保护，可保留配置继续。" : probe.error}
                      </small>
                    )}
                  </div>
                )}
                <Feedback error={a.error} busy={a.busy} />
                <div className="ad-actions">
                  <button className={probe ? "ad-button" : "ad-primary"} disabled={a.busy}>
                    <Cable size={15} />
                    一键测通
                  </button>
                  {probe && (
                    <button
                      type="button"
                      className="ad-primary"
                      disabled={a.busy}
                      onClick={() => {
                        a.setError("");
                        setStep(2);
                      }}
                    >
                      下一步
                      <ArrowRight size={15} />
                    </button>
                  )}
                </div>
              </form>
            ) : (
              <form
                className="ad-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void a.run(finish);
                }}
              >
                {workspace ? (
                  <div className="ad-line">
                    <FolderGit2 size={17} />
                    {workspace.name} · {workspace.status === "cloning" ? "正在克隆" : "已就绪"}
                  </div>
                ) : (
                  <>
                    <div className="ad-segments">
                      {[
                        ["new", "新建目录"],
                        ["import", "已有目录"],
                        ["clone", "Clone 仓库"],
                      ].map(([v, t]) => (
                        <button data-on={mode === v} key={v} type="button" onClick={() => setMode(v)}>
                          {t}
                        </button>
                      ))}
                    </div>
                    {mode === "import" && (
                      <label>
                        本地目录
                        <select value={dir} required onChange={(e) => setDir(e.target.value)}>
                          <option value="">选择受控目录</option>
                          {directories.map((d) => (
                            <option key={d}>{d}</option>
                          ))}
                        </select>
                        {!directories.length && <small>当前没有可导入的目录，可新建项目目录。</small>}
                      </label>
                    )}
                    {mode === "clone" && (
                      <label>
                        仓库地址
                        <input
                          value={url}
                          onChange={(e) => setUrl(e.target.value)}
                          type="url"
                          placeholder="https://github.com/owner/repo.git"
                          required
                        />
                      </label>
                    )}
                    <label>
                      工作区名称
                      <input
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        required={mode !== "import"}
                        placeholder="例如 my-project"
                      />
                    </label>
                  </>
                )}
                <Feedback error={a.error} busy={a.busy} />
                <button
                  className="ad-primary ob-submit"
                  disabled={a.busy || (!workspace && mode === "import" && !dir)}
                >
                  进入工作台
                  <ArrowRight size={16} />
                </button>
              </form>
            )}
            {!status && <Feedback error={a.error} />}
          </div>
          <div className="ob-card-footer">
            <ShieldCheck size={14} />
            {step === 1 ? "供应商密钥在服务器加密保存" : "凭据保存在当前 CodexDeck 实例"}
          </div>
        </section>
      </div>
      <footer className="ob-foot">
        <span>
          <Terminal size={13} />
          CodexDeck
        </span>
        <span>
          {login ? "身份验证" : "首次设置"}
          <ChevronRight size={12} />
          {steps[step].title}
        </span>
      </footer>
    </main>
  );
}
