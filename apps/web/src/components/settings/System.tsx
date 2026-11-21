import { useEffect, useState } from "react";
import { Bell, BellRing, Plus, Radio, Send, Trash2, X } from "lucide-react";
import type { NotificationChannel, ServerProfile } from "@codexdeck/shared";
import { api, json } from "../../lib/api";
import { Empty, Feedback, SectionHead, sizeLabel, timeLabel, useAction } from "./common";
import type { AdminAuditEntry } from "@codexdeck/shared";

const typeNames = { webhook: "Webhook", feishu: "飞书", telegram: "Telegram", bark: "Bark" };
export function System({section="all"}:{section?:"all"|"notifications"|"system"}={}) {
  const [channels, setChannels] = useState<NotificationChannel[]>([]),
    [profile, setProfile] = useState<ServerProfile | null>(null),
    [edit, setEdit] = useState(false);
  const [name, setName] = useState(""),
    [type, setType] = useState<NotificationChannel["type"]>("webhook"),
    [url, setUrl] = useState(""),
    [token, setToken] = useState(""),
    [chat, setChat] = useState(""),
    [removal, setRemoval] = useState<string | null>(null);
  const [permission, setPermission] = useState(
    typeof Notification === "undefined" ? "unavailable" : Notification.permission,
  );
  const a = useAction();
  const [audit, setAudit] = useState<AdminAuditEntry[]>([]);
  const [moreAudit, setMoreAudit] = useState(false);
  async function loadAudit(before?:number) {
    const rows = await api<AdminAuditEntry[]>("/api/admin/audit" + (before ? "?before="+before : ""));
    setAudit(previous => before ? [...previous,...rows] : rows);
    setMoreAudit(rows.length === 100);
  }
  async function load() {
    const [cs, pr] = await Promise.all([
      api<NotificationChannel[]>("/api/notification-channels"),
      api<ServerProfile>("/api/server/profile"),
    ]);
    setChannels(cs);
    setProfile(pr);
  }
  useEffect(() => {
    void a.run(load);
  }, []);
  async function create() {
    await api(
      "/api/notification-channels",
      json("POST", { name, type, config: type === "telegram" ? { token, chat_id: chat } : { url } }),
    );
    setEdit(false);
    setName("");
    setUrl("");
    setToken("");
    setChat("");
    await load();
  }
  return (
    <>
      {section!=="system" && <SectionHead
        title="系统与通知"
        description="查看运行环境，选择审批、任务和部署异常的提醒渠道。"
        actions={
          <button className="ad-primary" onClick={() => setEdit((v) => !v)}>
            <Plus size={14} />
            添加通知渠道
          </button>
        }
      />}
      {section!=="notifications" && <><details className="ad-card">
        <summary>更改管理员密码</summary>
        <form className="ad-form" onSubmit={event=>{
          event.preventDefault();
          const form=event.currentTarget;
          const fields=new FormData(form);
          void a.run(async()=>{
            await api("/api/auth/password",json("POST",Object.fromEntries(fields)));
            form.reset();
          },"密码已更新，其他会话已退出");
        }}>
          <label>当前密码<input required type="password" name="current_password" autoComplete="current-password" /></label>
          <label>新密码（至少 12 位）<input required type="password" name="new_password" minLength={12} maxLength={256} autoComplete="new-password" /></label>
          <button className="ad-button" disabled={a.busy}>保存新密码</button>
        </form>
      </details>
      <details className="ad-card" onToggle={event=>{if(event.currentTarget.open) void a.run(()=>loadAudit());}}>
        <summary>管理员操作记录</summary>
        {!audit.length && <p>暂无操作记录</p>}
        {audit.map(row=><details key={row.id}>
          <summary>{timeLabel(row.created_at)} · {row.action} · HTTP {row.status}</summary>
          <dl className="ad-kv"><dt>对象</dt><dd>{row.target ?? "—"}</dd><dt>请求 ID</dt><dd>{row.request_id}</dd></dl>
          <pre>{JSON.stringify(JSON.parse(row.details),null,2)}</pre>
        </details>)}
        {moreAudit && <button className="ad-button" disabled={a.busy} onClick={()=>void a.run(()=>loadAudit(audit.at(-1)?.id))}>更早的操作</button>}
      </details>
      {profile && (
        <>
          <div className="ad-metrics">
            {[
              ["操作系统", profile.os],
              ["CPU", profile.cpu_count + " 核"],
              ["可用内存", sizeLabel(profile.free_memory)],
              ["磁盘剩余", sizeLabel(profile.disk_free)],
            ].map(([t, v]) => (
              <div key={t}>
                <small>{t}</small>
                <strong>{v}</strong>
              </div>
            ))}
          </div>
          <details className="ad-card">
            <summary>运行时与端口池</summary>
            <dl className="ad-kv">
              {Object.entries(profile.runtimes).map(([k, v]) => (
                <div key={k} style={{ display: "contents" }}>
                  <dt>{k}</dt>
                  <dd>{v || "未检测到"}</dd>
                </div>
              ))}
              <dt>安全端口池</dt>
              <dd>{profile.safe_pool.join("–")}</dd>
              <dt>上次体检</dt>
              <dd>{timeLabel(profile.checked_at)}</dd>
            </dl>
          </details>
        </>
      )}
      </>}
      {section!=="system" && <><div className="ad-subhead">
        <h2>审批桌面提醒</h2>
      </div>
      <div className="ad-card">
        <div className="ad-labelrow">
          <div className="ad-pair">
            <span className="ad-provider-symbol">
              <BellRing size={17} />
            </span>
            <div>
              <strong>浏览器通知</strong>
              <small>
                {permission === "granted"
                  ? "已允许显示待审批提醒"
                  : permission === "denied"
                    ? "已被浏览器阻止，可在网站权限中开启"
                    : permission === "unavailable"
                      ? "当前浏览器不支持通知"
                      : "允许后，其他标签页也能收到审批提醒"}
              </small>
            </div>
          </div>
          <button
            className="ad-button"
            disabled={permission !== "default"}
            onClick={() => void a.run(async () => setPermission(await Notification.requestPermission()))}
          >
            允许通知
          </button>
        </div>
      </div>
      <div className="ad-subhead">
        <h2>外部通知渠道</h2>
        <small>{channels.length} 个渠道</small>
      </div>
      <Feedback busy={a.busy} notice={a.notice} error={a.error} />
      {edit && (
        <form
          className="ad-form-panel ad-form"
          onSubmit={(e) => {
            e.preventDefault();
            void a.run(create, "通知渠道已保存");
          }}
        >
          <div className="ad-labelrow">
            <strong>添加通知渠道</strong>
            <button type="button" className="ad-button" onClick={() => setEdit(false)} aria-label="关闭通知编辑">
              <X size={14} />
            </button>
          </div>
          <div className="ad-form-grid">
            <label>
              通知类型
              <select value={type} onChange={(e) => setType(e.target.value as NotificationChannel["type"])}>
                {Object.entries(typeNames).map(([v, t]) => (
                  <option key={v} value={v}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <label>
              渠道名称
              <input value={name} onChange={(e) => setName(e.target.value)} required />
            </label>
          </div>
          {type === "telegram" ? (
            <div className="ad-form-grid">
              <label>
                Bot Token
                <input
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  type="password"
                  required
                  autoComplete="off"
                />
              </label>
              <label>
                Chat ID
                <input value={chat} onChange={(e) => setChat(e.target.value)} required />
              </label>
            </div>
          ) : (
            <label>
              推送地址
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                type="url"
                required
                placeholder="https://…"
                autoComplete="off"
              />
            </label>
          )}
          <div>
            <button className="ad-primary" disabled={a.busy}>
              保存渠道
            </button>
          </div>
        </form>
      )}
      {!channels.length ? (
        <Empty
          title="尚未连接通知渠道"
          description="配置一个接收端，即可在任务完成、失败或审批挂起时收到通知。"
          icon={<Bell size={22} />}
        />
      ) : (
        <div className="ad-grid">
          {channels.map((c) => (
            <article className="ad-card" key={c.id}>
              <div className="ad-labelrow">
                <div className="ad-pair">
                  <span className="ad-provider-symbol">
                    <Radio size={16} />
                  </span>
                  <div>
                    <strong>{c.name}</strong>
                    <small>{typeNames[c.type]}</small>
                  </div>
                </div>
                <span className="ad-pill">{c.enabled ? "已启用" : "已停用"}</span>
              </div>
              <div className="ad-actions">
                <button className="ad-button" disabled={a.busy} onClick={()=>void a.run(async()=>{
                  await api("/api/notification-channels/"+c.id,json("PATCH",{enabled:!c.enabled})); await load();
                })}>{c.enabled?"停用渠道":"启用渠道"}</button>
                <button
                  className="ad-button"
                  disabled={a.busy}
                  onClick={() =>
                    void a.run(async () => {
                      await api("/api/notification-channels/" + c.id + "/test", json("POST", {}));
                    }, "测试通知已发送")
                  }
                >
                  <Send size={13} />
                  发送测试通知
                </button>
                <button className="ad-button" onClick={() => setRemoval(c.id)}>
                  <Trash2 size={13} />
                  移除
                </button>
              </div>
              {removal === c.id && (
                <div className="ad-actions">
                  <span>移除该通知渠道？</span>
                  <button
                    className="ad-button ad-danger"
                    onClick={() =>
                      void a.run(async () => {
                        await api("/api/notification-channels/" + c.id, json("DELETE"));
                        setRemoval(null);
                        await load();
                      }, "已移除")
                    }
                  >
                    确认
                  </button>
                  <button className="ad-button" onClick={() => setRemoval(null)}>
                    取消
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>
      )}</>}
    </>
  );
}
