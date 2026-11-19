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
    await api("/api/deployments/" + id + "/action", json("POST", { action }));
    setPending(null);
    await load();
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
                    onClick={() => void a.run(() => act(d.id, "verify"), "验收报告已更新")}
                  >
                    <Activity size={14} />
                    验收
                  </button>
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
                          (v === "rollback" && (d.status !== "live" || !d.previous_id)) ||
                          (v === "stop" && !running)
                        }
                        onClick={() => setPending({ id: d.id, action: String(v) })}
                      >
                        <Icon size={13} />
                        {String(t)}
                      </button>
                    );
                  })}
                </div>
                {pending?.id === d.id && (
                  <div className="ad-actions">
                    <span>
                      确认
                      {
                        ({ restart: "重启", rollback: "回滚", stop: "停止" } as Record<string, string>)[
                          pending.action
                        ]
                      }
                      该服务？
                    </span>
                    <button
                      className="ad-button ad-danger"
                      disabled={a.busy}
                      onClick={() => void a.run(() => act(d.id, pending.action), "服务状态已更新")}
                    >
                      确认执行
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
