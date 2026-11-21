# 宿主机管理命令

安装器将 `cdx` 和 `codexdeck` 登记到 `/usr/local/bin`。`cdx status` 显示实际入口路径、端口、证书指纹和安全配置。`--public --port N` 指定额外的 HTTPS 端口。使用 `--local-only --port N` 时，N 为本机监听端口。首次开启公网前通过 SSH 用 `cdx password` 设置管理员密码。

| 操作 | 命令 |
|---|---|
| 启停和诊断 | `cdx start`、`cdx stop`、`cdx restart`、`cdx doctor`、`cdx logs` |
| 网络 | `cdx public on`、`cdx public off`、`cdx port 27310`、`cdx proxy panel.example.com` |
| 入口恢复 | `cdx entry random`、`cdx entry off` |
| 凭证、封禁与设备 | `cdx password`、`cdx bans`、`cdx unban`、`cdx sessions`、`cdx session-revoke ID` |
| 动态口令 | `cdx totp-enroll`，将输出的密钥录入验证器，然后将当前 6 位码通过标准输入传给 `cdx totp-confirm`。妥善保存一次性恢复码。紧急恢复用 `cdx two-factor-off` |
| IP 模式 | `cdx ip allow 192.0.2.20/32`、`cdx ip deny 192.0.2.40/32`、`cdx ip off` |
| 配置同步 | `cdx security`、`cdx security set`、`cdx security reset`、`cdx preferences`、`cdx preferences set`、`cdx preferences reset`；set 操作从标准输入读取 JSON 对象 |
| 临时访客 | `cdx workspaces`、`cdx temp-link list`、`cdx temp-link live`、`cdx temp-link revoke ID`、`cdx audit` |
| 通知渠道 | `cdx channels` 查看名称、类型和启用状态。`cdx channel-create` 和 `cdx channel-update ID` 从标准输入读取 JSON，`cdx channel-delete ID` 移除接收端 |
| 全部恢复默认 | `cdx defaults-reset` 在确认后同时恢复工作台和安全策略默认值，关闭 2FA、解除封禁并注销管理员会话 |
| 任务 | `cdx tasks` 显示运行的任务。用 `cdx kill THREAD` 终止指定会话当前任务 |
| 数据库 | `cdx backup` 在线生成受限快照。`cdx restore 备份文件名` 在替换前创建恢复点，清理旧会话并吊销访客链接。已启动的面板会短暂停机 |
| 生命周期 | `cdx upgrade`、`cdx uninstall` |

一条只读邀请可以限制在单个工作区。先用 `cdx workspaces` 找到工作区 ID，将下例中的 ID 和地址换成实际值。

```bash
expiry=$(date -u -d '+1 hour' +%Y-%m-%dT%H:%M:%SZ)
printf '{"name":"Review","expires_at":"%s","permission":"readonly","workspace_ids":["%s"],"require_code":true,"bind_first_ip":true}' "$expiry" "WORKSPACE_ID" |
  cdx temp-link create https://panel.example.com
printf '%s' '{"hours":6,"turns":5}' | cdx temp-link extend LINK_ID
```

面板设置中的公网开关控制请求准入。宿主机绑定地址由 `cdx public` 或安装器管理。在仅本机安装上需要远程访问时，运行 `cdx public on` 建立 TLS 监听。已有 Nginx 或 Caddy 的服务器可以只使用已有 TLS 反代，配置准确的可信代理 IP，并开启面板的公网准入。

通知渠道使用 Web 中的四种类型 `webhook`、`feishu`、`telegram`、`bark`。创建时提交 `name`、`type` 和 `config`。Telegram 的配置包含 `token` 和 `chat_id`，其他类型包含 `url`。可用 `cdx channel-create < /path/to/private-channel.json` 输入凭证，文件权限设为 600。执行 `printf '%s' '{"enabled":false}' | cdx channel-update ID` 可保留已有凭证并暂停投递。

启用外层 HTTP BasicAuth 后，Open API 客户端使用 Basic 的 `Authorization` 头，并用 `X-Api-Key` 单独传递 Open API 密钥。例如 `curl --user "$CDX_BASIC_USER" -H "X-Api-Key: $CDX_API_KEY" "$CDX_URL/api/v1/tasks/$TASK_ID"` 会在终端询问 Basic 密码。关闭 BasicAuth 时，继续使用 `Authorization: Bearer` 认证。

Docker 面板离线恢复通过 `compose run --no-deps` 以配置的 UID/GID 打开同一数据库。原生安装使用 systemd 的服务账户和环境文件。备份包含加密的应用数据，主密钥需单独妥善保存。恢复时选用当前实例生成的快照。
