# CodexDeck Phase 2 开发与验收报告

2026 年 11 月 19 日，Windows 本地验收。Phase 2 在 Phase 1 网关之上接通了 Codex 会话、文件与 Git、管理事件流、运维 MCP 和外部任务 API。服务默认监听回路地址，测试使用临时工作区和数据库。模型流量与通知验收均指向本地测试服务。

## 可复现的质量门禁

| 根目录命令 | 实测结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 锁文件安装成功 |
| `pnpm typecheck` | shared、server（含测试）、ops-mcp 严格类型检查通过 |
| `pnpm build` | 三个包的 ESM 构建通过 |
| `pnpm test` | 12 个 Vitest 文件，47 项全部通过，含 Phase 1 回归 |

开发启动命令为 `pnpm dev:server`。已有 Phase 1 数据库在启动时自动升级到 V2。升级测试使用含历史线程事件、产物和通知配置的 V1 数据库，连续执行两次迁移，并验证原数据关联和配置加密。

## 验收证据

| 链路 | 已验证行为 |
| --- | --- |
| Codex stdio | 使用本机 Codex 0.157.1 走完 initialize、thread/start、MCP 启动和一次模型 Turn。该轮通过本机网关访问模拟 Responses 上游，得到 completed 并正常退出。使用 fake app-server 另外验证插话、打断、同一 PID 热切模型、进程崩溃后以原远端线程 ID resume。 |
| 队列与审批 | 同工作区的多个会话按 FIFO 执行，排队任务可取消。四种审批决策、会话内同类放行、超时拒绝和本地 Webhook 提醒均有专项测试。宿主重启后恢复排队任务，已经执行中的任务标记失败，避免重复产生副作用。 |
| WebSocket 与 SSE | WS 客户端收到第 3 条后断开，重连仅补到第 4–8 条，随后收到实时第 9 条。SQLite 和客户端均为脱敏数据。公开 SSE 使用 Last-Event-ID 从同一套序号续传。 |
| 工作区与 Git | 越界路径和外部链接返回 403。上传、单文件下载、整轮 ZIP 解包、签名篡改和过期校验均已验证。真实临时 Git 仓库回滚后，文件恢复，HEAD 和用户索引字节保持一致。另用本地 HTTPS Git 远端验证异步 clone 成功。 |
| 运维 | 官方 SDK 的真实 stdio MCP 客户端发现七个工具。测试验证租用端口、托管进程身份、HTTP/WS 预览、受限 Node 服务及静态发布。候选版本健康检查失败后，请求稳定入口实际读到上一版本的内容。 |
| 双视口验收 | 本机 Playwright Chromium 159 实际生成 1440×900 和 390×844 两个视口的 PNG 并登记为产物。运行时缺少 Chromium 时，验证器在结果中报告 unavailable 并提供 HTTP 与日志结果。 |
| 公开任务 | 请求返回 202，外部客户端读取实时与续传事件、验证 HMAC 回调，并通过签名链接获取 Turn 生成的文件。模拟接收端先返回 503，再返回 204，两次请求签名均验证通过。另覆盖跨工作区 403、细粒度 scope、限流 429、Key 撤销 401。 |

## 新增 API 清单

除标出独立凭证的端点，管理接口使用 Phase 1 的管理员 Session Cookie。

| 功能 | 方法与路径 |
| --- | --- |
| 工作区 | `GET/POST /api/workspaces`、`DELETE /api/workspaces/:id`、`POST /api/workspaces/clone` |
| 指令文件 | `GET/PUT /api/workspaces/:id/agents-md`，scope 可选 global 或 project |
| 文件 | `GET /api/workspaces/:id/files/tree`、`GET/PUT /api/workspaces/:id/files/content`、`POST /api/workspaces/:id/files/upload`（multipart） |
| 产物 | `POST /api/artifacts/sign` 接受 artifact_id 或 turn_id。返回的 `GET /api/dl/:token` 可免 Cookie 下载，默认有效 30 分钟 |
| Git | `GET /api/workspaces/:id/git/status`、`GET /api/workspaces/:id/git/diff`（加 `?format=patch` 导出）、`POST /api/workspaces/:id/checkpoints/:ref/restore` |
| 会话 | `GET/POST /api/threads`、`POST /api/threads/:id/messages`、`POST /api/threads/:id/inject`、`POST /api/threads/:id/interrupt`、`PATCH /api/threads/:id/model` |
| 审批与实时状态 | `GET /api/approvals`、`POST /api/approvals/:id/decision`、`WS /ws/events?thread_id=…&last_seq_id=…`。WS 可接收订阅帧、待审批总数和心跳 |
| 通知 | `GET/POST /api/notification-channels`、`DELETE /api/notification-channels/:id`。支持 webhook、feishu、telegram、bark |
| 探测与部署 | `GET /api/server/profile`、`POST /api/server/probe`、`GET /api/deployments`、`POST /api/deployments/:id/action`（verify、promote、rollback、logs、stop） |
| 预览与流量 | `/preview/:port/*` 校验管理员、端口池及运行实例归属，支持 HTTP 与 WS。`/live/:workspace/*` 提供已上线版本的稳定入口 |
| 运维 MCP | `POST /internal/ops/:tool` 需要回路来源、带线程身份的 ops 签名 Token。stdio 工具为 server_inspect、port_allocate、app_deploy_staging、app_logs、verify_url、app_promote_live、app_rollback |
| API Key 管理 | `GET/POST /api/api-keys`、`PATCH/DELETE /api/api-keys/:id`。创建时一次返回 API Key 和回调签名密钥 |
| 外部任务 | `POST /api/v1/tasks`、`GET /api/v1/tasks/:id`、`GET /api/v1/tasks/:id/stream`、`POST /api/v1/tasks/:id/cancel`。均使用带作用域和工作区白名单的 Bearer Key |

共享请求、结果及实时帧定义位于 `packages/shared/src`。管理员创建 Key 时设置 `workspace_ids`、`scopes`、`rate_limit_rpm`。提交任务至少提供 `workspace_id` 和 `prompt`，可用 `thread_id` 追加到已有会话。持有 `tasks:read` 可查询任务，额外持有 `files:download` 才返回下载链接。签名下载链接在到期前是独立的持有者凭证。

回调接收方使用创建 API Key 时取得的 `webhook_signing_secret`，对原始 HTTP 请求体计算 HMAC-SHA256。将十六进制摘要前加 `sha256=` 后与 `X-CodexDeck-Signature` 比对。回调失败按指数退避重试，最多六次。私网回调需要管理员在该 Key 的 `webhook_origins` 中显式列出目标来源。

## 配置与运行范围

- `CODEX_BIN` 可覆盖 app-server 可执行文件。`CODEXDECK_APPROVAL_TIMEOUT_MS` 默认 600000。待审批超过 30 秒发送提醒。独立 Codex home 使用带线程 ID 的短期内部凭证，网关每次请求读取当前模型。
- `CODEXDECK_PORT_POOL` 默认 `10000-19999`，排除服务监听端口和受保护系统端口。`server-profile.json` 持久化在数据目录中。
- `CODEXDECK_PROXY_TYPE` 取 caddy 或 nginx，与 `CODEXDECK_PROXY_CONFIG` 同时设置时，切流前检查受控配置语法。可让外部反代指向稳定的 live 入口，由 CodexDeck 切换实际提供流量的托管版本。
- 删除工作区接口执行注销，保留磁盘工作文件。Git checkpoint 按 `git add -A` 语义保存已跟踪及未忽略的新增文件。产物链接对应登记的工作区路径，下载时读取该路径当前内容。
- 本机实际部署验收覆盖 Windows 上的静态资源与受限 Node 进程。Docker、Compose、Caddy、Nginx 及 Linux Python/bubblewrap 路径已编译，本机没有对应运行时验收结果。通知投递已通过本地 Webhook 实测，第三方通知账号和公网生产流量均未用于本次验收。
