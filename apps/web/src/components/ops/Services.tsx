import { useEffect, useState } from "react";
import type { Deployment, ServerProfile } from "@codexdeck/shared";
import {
  Activity,
  ArrowUpRight,
  Box,
  CircleStop,
  Cpu,
  Files,
  History,
  RefreshCw,
  Server,
  Terminal,
} from "lucide-react";
import { api, json } from "../../lib/api";
import { download } from "../files/Artifacts";
import {
  Empty,
  Feedback,
  SectionHead,
  sizeLabel,
  timeLabel,
  useAction,
  type AdminDrawer,
} from "../settings/common";

export function Services({ onDrawer }: { onDrawer: (d: AdminDrawer) => void }) {
  const [list, setList] = useState<Deployment[]>([]),
    [profile, setProfile] = useState<ServerProfile | null>(null);
  const [pending, setPending] = useState<{ id: string; action: string } | null>(null);
  const [check, setCheck] = useState({ path: "/", expected_content: "", check_browser: false });
  const a = useAction();
  async function load() {
    const [p, d] = await Promise.all([
      api<ServerProfile>("/api/server/profile"),
      api<Deployment[]>("/api/deployments"),
    ]);
    setProfile(p);
    setList(d);
  }
  useEffect(() => {
    void a.run(load);
  }, []);
  async function act(id: string, action: string) {
    const verify = action === "verify" || action === "promote";
    await api("/api/deployments/" + id + "/action", json("POST", verify ? { action, ...check } : { action }));
    setPending(null);
    await load();
  }
  function prepare(id: string, action: string) {
    setCheck({ path: "/", expected_content: "", check_browser: false });
    setPending({ id, action });
  }
  return (
    <>
      <SectionHead
        title="已部署服务"
        description="查看主机资源、预发布实例和当前线上版本。"
        actions={
          <button
            className="ad-button"
            disabled={a.busy}
            onClick={() =>
              void a.run(async () => {
                await api("/api/server/probe", json("POST", {}));
                await load();
              }, "体检报告已更新")
            }
          >
            <RefreshCw size={14} />
            重新探测
          </button>
        }
      />
      {profile && (
        <section aria-label="服务器体检">
          <div className="ad-pair">
            <span className="ad-provider-symbol">
              <Server size={17} />
            </span>
            <div>
              <strong>{profile.os}</strong>
              <small className="ad-panel-meta">最近体检　{timeLabel(profile.checked_at)}</small>
            </div>
          </div>
          <div className="ad-metrics">
            {[
              ["处理器", profile.cpu_count + " 核"],
              ["可用内存", sizeLabel(profile.free_memory)],
              ["可用磁盘", sizeLabel(profile.disk_free)],
              ["安全端口池", profile.safe_pool.join("–")],
            ].map(([l, v]) => (
              <div key={l}>
                <small>{l}</small>
                <strong>{v}</strong>
              </div>
            ))}
          </div>
        </section>
      )}
      <Feedback error={a.error} notice={a.notice} busy={a.busy} />
      <div className="ad-subhead">
        <h2>托管实例</h2>
        <small>{list.length} 个服务</small>
      </div>
      {list.length === 0 ? (
        <Empty
          title="尚未部署服务"
          description="在工作台中让 Codex 预发布工作区，实例就绪后可在这里预览、验收和回滚。"
          icon={<Box size={24} />}
        />
      ) : (
        <div className="ad-grid">
          {list.map((d) => {
            const running = ["staging", "live", "rolled_back"].includes(d.status);
            const report = d.last_verification;
            return (
              <article key={d.id} className="ad-card">
                <div className="ad-labelrow">
                  <div className="ad-pair">
                    <span className="ad-provider-symbol">
                      <Cpu size={17} />
                    </span>
                    <div>
                      <strong className="ad-mono">:{d.port}</strong>
                      <small>{d.mode}</small>
                    </div>
                  </div>
                  <span className={"ad-pill " + (running ? "positive" : "")}>{d.status}</span>
                </div>
                <dl className="ad-kv">
                  <dt>入口域名</dt>
                  <dd>{window.location.host}</dd>
                  <dt>环境</dt>
                  <dd>{d.status === "live" ? "Live" : "Staging"}</dd>
                  <dt>更新时间</dt>
                  <dd>{timeLabel(d.updated_at)}</dd>
                  <dt>最近验收</dt>
                  <dd>
                    {d.last_verification
                      ? (d.last_verification.ok ? "通过" : "失败") +
                        " · " +
                        timeLabel(d.last_verification.checked_at)
                      : "尚无报告"}
                  </dd>
                </dl>
                {report?.http && (
                  <details>
                    <summary>查看验收报告</summary>
                    <p>{report.path} · HTTP {report.http.status || "无法连接"} · {report.http.latency_ms} ms · {report.http.content_match ? "内容匹配" : "内容不匹配"}</p>
                    {report.http.error && <p>{report.http.error}</p>}
                    <p>服务日志 · {report.logs?.issues.length ?? 0} 条异常</p>
                    {report.logs?.issues.map((line, i) => <pre key={i}>{line}</pre>)}
                    {report.browser && <>
                      <p>浏览器验收 · {({disabled:"未启用",completed:"已执行",failed:"失败",unavailable:"不可用"})[report.browser.status]}</p>
                      {report.browser.message && <p>{report.browser.message}</p>}
                      {report.browser.issues.map((line, i) => <pre key={i}>{line}</pre>)}
                      {report.browser.artifacts.map((id, i) => (
                        <button key={id} className="ad-button" disabled={a.busy}
                          onClick={() => void a.run(() => download({artifact_id:id}))}>
                          下载{i === 0 ? "桌面" : "移动端"}截图
                        </button>
                      ))}
                    </>}
                  </details>
                )}
                {d.archived && <small>快照已过期，可从工作区重新预发布。</small>}
                <div className="ad-actions">
                  <button
                    className="ad-button"
                    disabled={!running}
                    onClick={() =>
                      onDrawer({ type: "preview", title: "端口预览", deploymentId: d.id, port: d.port })
                    }
                  >
                    <ArrowUpRight size={14} />
                    预览
                  </button>
                  <button
                    className="ad-button"
                    onClick={() => onDrawer({ type: "logs", title: "服务日志", deploymentId: d.id, port: d.port })}
                  >
                    <Terminal size={14} />
                    日志
                  </button>
                  <button
                    className="ad-button"
                    disabled={!running || a.busy}
                    onClick={() => prepare(d.id, "verify")}
                  >
                    <Activity size={14} />
                    验收
                  </button>
                  {running && d.status !== "live" && (
                    <button className="ad-button" disabled={a.busy} onClick={() => prepare(d.id, "promote")}>
                      发布上线
                    </button>
                  )}
                  {[
                    ["restart", "重启", RefreshCw],
                    ["rollback", "回滚", History],
                    ["stop", "停止", CircleStop],
                  ].map(([v, t, I]) => {
                    const Icon = I as typeof Files;
                    return (
                      <button
                        key={String(v)}
                        className="ad-button"
                        disabled={
                          a.busy ||
                          (v === "restart" && (d.archived || d.status === "starting")) ||
                          (v === "rollback" && (d.status !== "live" || !d.previous_id)) ||
                          (v === "stop" && !running)
                        }
                        onClick={() => prepare(d.id, String(v))}
                      >
                        <Icon size={13} />
                        {String(t)}
                      </button>
                    );
                  })}
                </div>
                {pending?.id === d.id && (
                  <div className="ad-actions">
                    {(pending.action === "verify" || pending.action === "promote") && (
                      <fieldset className="ad-form">
                        <legend>验收条件</legend>
                        <label>请求路径<input value={check.path} onChange={e => setCheck({...check, path:e.target.value})} /></label>
                        <label>响应应包含<input value={check.expected_content} placeholder="可选" onChange={e => setCheck({...check, expected_content:e.target.value})} /></label>
                        <label><input type="checkbox" checked={check.check_browser} onChange={e => setCheck({...check, check_browser:e.target.checked})} />要求桌面及移动浏览器验收</label>
                      </fieldset>
                    )}
                    <span>
                      {pending.action === "promote" ? "验收通过后，将线上流量切换到该版本。"
                        : ({restart:"确认重启该服务？",rollback:"确认恢复上一线上版本？",stop:"确认停止该服务？",verify:""} as Record<string,string>)[pending.action]}
                    </span>
                    <button
                      className="ad-button ad-danger"
                      disabled={a.busy || (["verify","promote"].includes(pending.action) && !/^\/(?!\/)[^\s\\]*$/.test(check.path))}
                      onClick={() => void a.run(() => act(d.id, pending.action), "服务状态已更新")}
                    >
                      {pending.action === "verify" ? "开始验收" : pending.action === "promote" ? "确认发布" : "确认执行"}
                    </button>
                    <button className="ad-button" onClick={() => setPending(null)}>
                      取消
                    </button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </>
  );
}
