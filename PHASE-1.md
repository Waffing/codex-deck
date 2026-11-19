# CodexDeck Phase 1 验收报告

2026 年 11 月 19 日在 Windows、Node.js 24.18.0、pnpm 11.25.0 下验收。服务由 Fastify 提供 HTTP 接口，管理数据、凭证和用量记录存储在 SQLite。集成测试在回路地址启动 HTTP 模拟上游，所有请求使用测试凭证。

## 验收记录

| 根目录命令 | 实际验证内容 |
| --- | --- |
| `pnpm typecheck` | 共享 Schema、服务端和测试代码通过严格 TypeScript 检查 |
| `pnpm build` | shared 和 server 均生成 ESM 构建产物 |
| `pnpm test` | 6 个 Vitest 文件，31 项测试通过 |
| `pnpm dev:server` | 临时数据目录冷启动成功，`/health` 与 `/api/auth/status` 返回 200，首次启动要求初始化管理员 |
| `pnpm smoke` | 临时配置连接实际网关，模拟上游收到真实模型 ID，一次成功响应记入 4 个输入 token 和 1 个输出 token |

本机 Codex CLI 0.157.1 的 `codex debug models` 已能读取生成的模型目录。第三方线上服务的实际可用性及价格由具体供应商决定，本次验收使用本地模拟服务。

## 已覆盖的行为

- SQLite 冷启动执行 V1 SQL 迁移，建立 12 张业务表，启用 WAL 与外键。重复启动保留数据与迁移版本。
- 管理员并发初始化只有一次成功。登录后签发 HttpOnly、SameSite=Strict 会话 Cookie。退出后再次提交原 Cookie 会返回 401。
- Provider 和 Model 支持创建、列表、详情、部分更新与删除。六个预设可通过 `GET /api/providers/presets` 获取。API Key 和自定义请求头值经 AES-256-GCM 加密保存，接口返回密钥后缀与遮罩后的头值。
- 探测优先使用该供应商已启用的模型。没有绑定模型时，从发现列表中选择模型。模型列表不可用时仍尝试协议探测。TTFT 记录首个非空文本增量到达的耗时。工具能力通过实际函数调用判断，视觉能力通过识别测试色块判断。结果写入 `providers.last_probe_json`。
- 原生 Responses 支持 JSON 与 SSE。测试逐字节比对无凭证 SSE 的 UTF-8 内容、注释及 CRLF 行尾。Chat 转译支持文本、图片、多轮消息、并发函数与工具结果回传。Chat 渠道需要调用方传入完整历史。
- 网关在发出下游首字节前可因 429、5xx 或连接超时切换渠道。集成测试验证 429、503、首事件超时及已开始输出后的流中断。响应头 `X-CodexDeck-Failover` 给出已尝试的模型记录 ID，`usage_logs` 记录最终渠道、token、按模型费率估算的美元成本与耗时。
- 内部请求校验回路来源及带到期时间的签名 Bearer Token。配置生成的子进程环境只含 `CODEX_HOME` 与 `CODEXDECK_INTERNAL_TOKEN`。

## 本地运行

1. 从仓库根目录执行 `pnpm install --frozen-lockfile` 和 `pnpm dev:server`。默认地址是 `http://127.0.0.1:3210`，数据目录是仓库内的 `.codexdeck`。
2. 向 `POST /api/auth/setup` 提交含 `password` 的 JSON 并保存返回的会话 Cookie。密码长度为 12 至 256 个字符。后续使用 `POST /api/auth/login` 与 `POST /api/auth/logout`。
3. 携带 Cookie 调用 `POST /api/providers`，传入 `name`、`preset`、`base_url`，按需传入 `api_key` 和 `headers`。再调用 `POST /api/models`，传入 `provider_id`、本地 `alias` 与上游 `model_id`。`protocol` 支持 `auto`、`responses`、`chat`。备用模型创建后，可将其记录 ID 按优先顺序写入主模型的 `fallback_model_ids`。
4. 保持服务运行，从仓库根目录执行 `pnpm smoke`。脚本使用相同的数据目录、主密钥与端口。配置生成器优先读取 `settings.default_model`，缺省使用首个已启用且供应商可用的模型。

本地开发首次启动可生成持久化的 `master.key`。生产模式要求通过 `CODEXDECK_MASTER_KEY` 提供 32 字节密钥，可使用十六进制或 Base64。已有数据需要相同的主密钥解密。监听端口由 `CODEXDECK_PORT` 设置，`CODEXDECK_DATA_DIR` 必须位于工作区内。

**探测端口限制。** 根目录 `AGENTS.md` 要求保护 22、80、443 及服务自身的监听端口。探测器会在联网前拒绝这些目标，包括使用默认 443 的公网 HTTPS 预设。正常网关转发支持这些预设的 HTTPS API。自动协议选择可以使用已保存的能力结果，也可在上游 Responses 返回 404 或 405 时尝试 Chat。
