import { useEffect, useRef, useState } from "react";
import { Copy, KeyRound, Plus, ShieldMinus, X } from "lucide-react";
import type { ApiKey, Workspace } from "@codexdeck/shared";
import { api, json } from "../../lib/api";
import { UsageLedger } from "./UsageLedger";
import { Empty, Feedback, SectionHead, useAction } from "./common";

type Created = { api_key: string; webhook_signing_secret: string; workspaceId: string; scopes: ApiKey["scopes"] };
type Scope = ApiKey["scopes"][number];
const scopes: Scope[] = ["tasks:read", "tasks:write", "files:download"];
function KeyReceipt({ item, close }: { item: Created; close: () => void }) {
  const dialog = useRef<HTMLDialogElement | null>(null);
  const a = useAction();
  useEffect(() => {
    const modal = dialog.current;
    modal?.showModal();
    return () => modal?.close();
  }, []);
  const writeExample =
    "curl -X POST " +
    window.location.origin +
    '/api/v1/tasks \\\n  -H "Authorization: Bearer $CODEXDECK_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d ' +
    JSON.stringify({ workspace_id: item.workspaceId, prompt: "列出当前项目文件" }).replace(/^|$/g, "'");
  const example = item.scopes.includes("tasks:write")
    ? writeExample
    : item.scopes.includes("tasks:read")
      ? 'curl -H "Authorization: Bearer $CODEXDECK_API_KEY" "' +
        window.location.origin +
        '/api/v1/tasks/$CODEXDECK_TASK_ID"'
      : 'curl -o artifact "$CODEXDECK_DOWNLOAD_URL"';
  const exampleHint = item.scopes.includes("tasks:write")
    ? "将 API Key 设为 CODEXDECK_API_KEY 后测试请求。"
    : item.scopes.includes("tasks:read")
      ? "设置 CODEXDECK_API_KEY 和已授权工作区的 CODEXDECK_TASK_ID 后查询任务。"
      : "使用具有 tasks:read 和 files:download 权限的密钥查询已完成任务，从 artifacts 取出签名下载地址并设为 CODEXDECK_DOWNLOAD_URL。";
  return (
    <dialog className="ad-onekey" ref={dialog} aria-labelledby="receipt-title" onCancel={close}>
      <div className="ad-labelrow">
        <KeyRound size={21} />
        <button className="ad-button" onClick={close} aria-label="关闭密钥回执">
          <X size={15} />
        </button>
      </div>
      <h2 id="receipt-title">保存新密钥</h2>
      <p>关闭后仅显示前缀。请将 API Key 与回调签名密钥存入凭据管理器。</p>
      {[
        [item.api_key, "API Key"],
        [item.webhook_signing_secret, "回调签名密钥"],
      ].map(([v, t]) => (
        <div key={t}>
          <div className="ad-labelrow">
            <strong>{t}</strong>
            <button
              className="ad-button"
              onClick={() => void a.run(() => navigator.clipboard.writeText(v), "已复制")}
            >
              <Copy size={12} />
              复制
            </button>
          </div>
          <pre className="ad-code">
            <code>{v}</code>
          </pre>
        </div>
      ))}
      <p>{exampleHint}</p>
      <pre className="ad-code">{example}</pre>
      <Feedback notice={a.notice} error={a.error} />
      <button className="ad-primary" onClick={close}>
        已保存，关闭
      </button>
    </dialog>
  );
}
export function OpenApi() {
  const [keys, setKeys] = useState<ApiKey[]>([]),
    [spaces, setSpaces] = useState<Workspace[]>([]);
  const [editing, setEditing] = useState(false),
    [name, setName] = useState(""),
    [rpm, setRpm] = useState(60),
    [allowed, setAllowed] = useState<string[]>([]),
    [rights, setRights] = useState<Scope[]>(["tasks:read"]);
  const [receipt, setReceipt] = useState<Created | null>(null),
    [revoke, setRevoke] = useState<string | null>(null);
  const a = useAction();
  async function keysLoad() {
    const [ks, ws] = await Promise.all([api<ApiKey[]>("/api/api-keys"), api<Workspace[]>("/api/workspaces")]);
    setKeys(ks);
    setSpaces(ws);
  }
  useEffect(() => {
    void a.run(keysLoad);
  }, []);
  async function issue() {
    const data = await api<Created>(
      "/api/api-keys",
      json("POST", { name, scopes: rights, workspace_ids: allowed, rate_limit_rpm: rpm }),
    );
    setReceipt({ ...data, workspaceId: allowed[0], scopes: rights });
    setEditing(false);
    setName("");
    setRights(["tasks:read"]);
    setAllowed([]);
    await keysLoad();
  }
  return (
    <>
      <SectionHead
        title="Open API 与用量"
        description="管理外部系统的访问范围，核对各渠道的 Token 与成本。"
        actions={
          <button className="ad-primary" onClick={() => setEditing((v) => !v)}>
            <Plus size={14} />
            创建 API Key
          </button>
        }
      />
      <Feedback busy={a.busy} notice={a.notice} error={a.error} />
      {editing && (
        <form
          className="ad-form-panel ad-form"
          onSubmit={(e) => {
            e.preventDefault();
            void a.run(issue);
          }}
        >
          <div className="ad-labelrow">
            <strong>创建访问密钥</strong>
            <button
              type="button"
              className="ad-button"
              onClick={() => setEditing(false)}
              aria-label="关闭密钥表单"
            >
              <X size={14} />
            </button>
          </div>
          <div className="ad-form-grid">
            <label>
              密钥名称
              <input value={name} required onChange={(e) => setName(e.target.value)} />
            </label>
            <label>
              每分钟请求数（RPM）
              <input
                value={rpm}
                type="number"
                min={1}
                max={10000}
                required
                onChange={(e) => setRpm(Number(e.target.value))}
              />
            </label>
          </div>
          <fieldset>
            <legend>作用域</legend>
            {scopes.map((s) => (
              <label className="ad-check" key={s}>
                <input
                  type="checkbox"
                  checked={rights.includes(s)}
                  onChange={(e) => setRights(e.target.checked ? [...rights, s] : rights.filter((v) => v !== s))}
                />
                {s}
              </label>
            ))}
          </fieldset>
          <fieldset>
            <legend>工作区白名单</legend>
            <div className="ad-scroll-list">
              {spaces.map((s) => (
                <label className="ad-check" key={s.id}>
                  <input
                    type="checkbox"
                    checked={allowed.includes(s.id)}
                    onChange={(e) =>
                      setAllowed(e.target.checked ? [...allowed, s.id] : allowed.filter((v) => v !== s.id))
                    }
                  />
                  {s.name}
                </label>
              ))}
            </div>
          </fieldset>
          <div>
            <button className="ad-primary" disabled={a.busy || !rights.length || !allowed.length}>
              生成密钥
            </button>
          </div>
        </form>
      )}
      <div className="ad-subhead">
        <h2>访问密钥</h2>
        <small>{keys.filter((k) => !k.revoked_at).length} 个有效密钥</small>
      </div>
      {keys.length ? (
        <div className="ad-table-wrap">
          <table className="ad-table">
            <thead>
              <tr>
                {["名称", "密钥前缀", "作用域", "RPM", "状态", ""].map((t, i) => (
                  <th key={i}>{t}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id}>
                  <td>{k.name}</td>
                  <td className="num">{k.prefix}…</td>
                  <td>{k.scopes.join(" · ")}</td>
                  <td className="num">{k.rate_limit_rpm}</td>
                  <td>{k.revoked_at ? "已撤销" : "有效"}</td>
                  <td>
                    {!k.revoked_at && (
                      <button className="ad-button" onClick={() => setRevoke(k.id)}>
                        <ShieldMinus size={13} />
                        撤销
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty
          title="尚无外部访问密钥"
          description="创建密钥后，外部客户端可以提交任务、订阅事件或下载产物。"
          icon={<KeyRound size={23} />}
        />
      )}
      {revoke && (
        <div className="ad-message">
          确认撤销此密钥？
          <button
            className="ad-button ad-danger"
            disabled={a.busy}
            onClick={() =>
              void a.run(async () => {
                await api("/api/api-keys/" + revoke, json("DELETE"));
                setRevoke(null);
                await keysLoad();
              }, "密钥已撤销")
            }
          >
            确认撤销
          </button>
          <button className="ad-button" onClick={() => setRevoke(null)}>
            取消
          </button>
        </div>
      )}
      <UsageLedger />
      {receipt && <KeyReceipt item={receipt} close={() => setReceipt(null)} />}
    </>
  );
}
