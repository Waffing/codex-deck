<div align="center">
  <img src="docs/assets/banner.svg" alt="CodexDeck · 自托管 Codex 控制台" width="1280">
  <h1>CodexDeck</h1>
  <p>面向 Codex CLI 的自托管 Web 控制台，集成兼容 OpenAI 的模型网关、远程审批和部署验收。</p>
  <p><a href="README.md">English</a> · <strong>简体中文</strong></p>
  <p>
    <a href="LICENSE"><img alt="MIT 许可证" src="https://img.shields.io/github/license/Waffing/codex-deck?style=flat-square"></a>
    <a href="https://github.com/Waffing/codex-deck/actions/workflows/ci.yml"><img alt="CI 状态" src="https://img.shields.io/github/actions/workflow/status/Waffing/codex-deck/ci.yml?branch=main&amp;label=CI&amp;style=flat-square"></a>
    <a href="https://github.com/Waffing/codex-deck/pkgs/container/codex-deck"><img alt="GHCR 镜像发布版本" src="https://img.shields.io/github/v/release/Waffing/codex-deck?label=GHCR&amp;style=flat-square"></a>
    <a href="#本地开发"><img alt="Node.js 22+" src="https://img.shields.io/badge/Node.js-22%2B-339933?style=flat-square"></a>
    <a href="https://github.com/Waffing/codex-deck/stargazers"><img alt="GitHub Stars" src="https://img.shields.io/github/stars/Waffing/codex-deck?style=flat-square"></a>
  </p>
  <p>
    <a href="#核心功能">核心功能</a> ·
    <a href="#快速开始">快速开始</a> ·
    <a href="#系统架构">系统架构</a> ·
    <a href="#安全模型">安全模型</a> ·
    <a href="#open-api">Open API</a> ·
    <a href="#路线图">路线图</a>
  </p>
</div>

## 快速开始

**Linux Docker Compose（amd64 或 arm64）**

```sh
release=$(curl -fsSL -o /dev/null -w '%{url_effective}' https://github.com/Waffing/codex-deck/releases/latest) && tag=${release##*/} && curl -fsSL "https://raw.githubusercontent.com/Waffing/codex-deck/$tag/deploy/install.sh" | CODEXDECK_VERSION="$tag" bash
```

V1.2 安装器默认只监听 `127.0.0.1:3000`。通过 SSH 执行 `cdx password` 设置管理员密码，复制安装后的隧道命令，登录面板后配置模型和工作区。非交互安装可传入 `--local-only`。选择 `--public` 会额外开启高位 HTTPS 端口并生成 8 位随机入口。使用 IP 登录前，通过 SSH 运行 `cdx status`，核对自签名证书的 SHA-256 指纹。以上参数要求安装包含 V1.2 的发布版本。

`tag` 让安装脚本、Compose 文件和镜像使用同一已发布版本。指定版本时，把 `tag` 改成已发布的 `vX.Y.Z`。需要 Chromium 验收时追加 `--with-playwright`。

每个托管业务容器默认限制为 1 CPU、512 MiB 内存和 128 个进程。`CODEXDECK_RELEASE_KEEP` 默认保留 5 个最近快照，线上版本及其上一版本会额外受保护。服务重启后只恢复带有 CodexDeck 所有权标签的业务容器。

```sh
tag="${CODEXDECK_VERSION:-$(curl -fsSL -o /dev/null -w '%{url_effective}' https://github.com/Waffing/codex-deck/releases/latest)}"; tag="${tag##*/}"; curl -fsSL "https://raw.githubusercontent.com/Waffing/codex-deck/$tag/deploy/install.sh" | CODEXDECK_VERSION="$tag" bash -s -- --with-playwright
```

**Linux 原生安装（systemd）**。安装 Node.js 22.13+、Corepack、Git 和系统级官方 Codex CLI。独立构建账户负责安装依赖，`codexdeck` 服务账户运行发布版本。默认目录下用 `sudo cat /opt/codexdeck/source/data/setup-code` 读取首次启动代码。

```sh
tag="${CODEXDECK_VERSION:-$(curl -fsSL -o /dev/null -w '%{url_effective}' https://github.com/Waffing/codex-deck/releases/latest)}"; tag="${tag##*/}"; curl -fsSL "https://raw.githubusercontent.com/Waffing/codex-deck/$tag/deploy/install.sh" | CODEXDECK_VERSION="$tag" bash -s -- --native
```

**使用 npx 运行本地 CLI**。npm 上的 `codex-deck` 已被另一个项目使用。构建源码后，将 npx 指向本仓库的 `packages/cli`，以离线模式启动。

```sh
git clone https://github.com/Waffing/codex-deck.git
cd codex-deck
pnpm install --frozen-lockfile
pnpm build
mkdir -p ./data ./workspaces
(
  umask 077
  if [ ! -s ./data/master.key ]; then
    openssl rand -hex 32 > ./data/master.key
  fi
)
export CODEXDECK_MASTER_KEY="$(cat ./data/master.key)"
NODE_ENV=production npx --offline --yes --package=./packages/cli -- codex-deck start --port 3000 --data ./data --workspaces ./workspaces
```

在另一个终端进入仓库根目录，读取 `./data/setup-code` 完成首次设置。运行 `npx --offline --yes --package=./packages/cli -- codex-deck status` 查看服务状态，将 `status` 换成 `doctor` 检查运行环境。

<details>
<summary>HTTPS、升级和备份</summary>

在公网模式指定域名后，若相关端口均空闲，可在安装器中选择托管 Caddy。配置 DNS，并将公网 TCP 80 和 443 分别转发到宿主机 8080 和 8443。已有网站的服务器可执行 `cdx proxy panel.example.com`，生成独立反代配置片段并检查公网证书。请将 `CODEXDECK_TRUSTED_PROXIES` 设为面板实际看到的代理 IP，并由该代理覆盖转发头。

执行 `cdx` 打开管理菜单。常用命令有 `cdx tasks`、`cdx kill THREAD`、`cdx public on`、`cdx backup` 和 `cdx restore 备份文件名`。Web 与 SSH 共用安全配置，例如 `printf '%s' '{"max_failures":6}' | cdx security set` 将连续失败上限改为 6 次。Docker 面板容器停止时，恢复操作使用本机已有镜像和数据库，需 Docker 守护进程可用。[宿主机运维指南](deploy/HOST-ADMIN.md)

运行安装目录的 `install.sh --upgrade --dir /path/to/install --version vX.Y.Z` 升级指定已发布版本，传入 `--uninstall --dir /path/to/install` 卸载，systemd 部署沿用 `--native`。升级会保留正在运行的镜像或服务单元，健康检查失败时回滚。跨数据库架构版本升级前先备份。

```sh
archive="$PWD/backup-$(date +%Y%m%d-%H%M%S)"
python3 backup.py backup --data ./data --workspaces ./workspaces --managed-data /data --managed-workspaces /workspaces --to "$archive"
python3 backup.py verify --from "$archive"
python3 backup.py restore --from "$archive" --to ./recovery --target-data /data --target-workspaces /workspaces
```

恢复后将 `CODEXDECK_DATA_PATH` 和 `CODEXDECK_WORKSPACES_HOST` 指向 `recovery/data` 与 `recovery/workspaces`。原生安装备份 `source/data` 和实际工作区路径，并使用服务最终绝对路径作为 `--target-data`、`--target-workspaces`。恢复目录需要归属服务账户。备份包含项目文件和历史记录，必须加密保存并单独保管匹配的主密钥。校验会检查哈希和 SQLite 完整性，包含符号链接的项目需要使用文件系统快照。

密钥轮换前先备份并停止服务。用密钥管理器提供新的随机 32 字节值到 `CODEXDECK_NEXT_MASTER_KEY`，执行 `docker compose stop codexdeck`，再运行 `docker compose run --rm --no-deps -e CODEXDECK_NEXT_MASTER_KEY codexdeck node apps/server/dist/rotate-key.js /data`。原生安装停止 systemd 后，在安装版本目录执行同名命令。事务成功后将 `CODEXDECK_MASTER_KEY` 替换为新值并重启。重复使用同一对密钥会识别已提交轮换，旧会话、下载链接和 webhook 签名需要重新建立。

</details>

## 核心功能

| 需求 | CodexDeck 的处理方式 |
| --- | --- |
| 接入仅支持 Chat Completions 的模型 | Codex 使用 Responses 协议访问本地网关。网关可以原样转发 Responses，也可将流式输出和工具调用转为 Chat Completions，并支持配置备用模型。 |
| 将供应商凭证与代理进程隔离 | 网关在发送上游请求时解密凭证。Codex 通过短期签名令牌访问本地网关。 |
| 在任务运行时审批敏感操作 | `codex app-server` 的审批请求以非阻塞卡片显示。待审操作暂停期间，控制台仍可继续使用。 |
| 交付产物并保留审计记录 | 检查文件和 Git 检查点，订阅可续传的任务事件，通过有作用域且会过期的签名链接下载产物。 |
| 部署后先验收再确认上线 | Server Probe 检查可用运行时。部署至预发布、检查 HTTP 和日志，按需启用 Playwright，并在发布验收失败时回滚。 |
| 离开电脑后继续审批 | 响应式控制台可在手机上查看任务、审批、日志和服务预览。 |

<p align="center">
  <img src="docs/assets/workbench.png" alt="桌面工作台，展示已完成任务和产物预览" width="100%">
</p>

<table>
  <tr>
    <td align="center"><img src="docs/assets/approval.png" alt="桌面工作台中的待审批卡片" width="720"></td>
    <td align="center"><img src="docs/assets/mobile.png" alt="手机上的预发布待审批卡片" width="195"></td>
  </tr>
  <tr><td align="center">桌面审批</td><td align="center">移动端审批</td></tr>
</table>

*截图来自使用合成测试数据的本地控制台。*

## 系统架构

```mermaid
flowchart LR
    client["浏览器 / API 客户端"]
    provider["兼容 OpenAI 的模型供应商"]

    subgraph control["控制平面"]
      api["Fastify API · WebSocket · SSE"]
      db[("SQLite WAL")]
      gateway["Responses 网关"]
      preview["受限预览代理"]
      api --> db
      api --> preview
      gateway -.->|"加密凭证"| db
    end

    subgraph runtime["代理运行时"]
      codex["Codex app-server"]
      mcp["运维 MCP"]
      work["工作区 · Git · 产物"]
      codex --> work
      codex --> mcp
    end

    subgraph deployment["业务网络"]
      service["预发布 / 线上部署"]
    end

    client <-->|"会话或有作用域的 API Key"| api
    api <-->|"JSON-RPC · 审批"| codex
    codex -->|"短期回环令牌"| gateway
    gateway -->|"供应商凭证"| provider
    mcp -->|"签名回环令牌"| api
    preview -->|"受管目标"| service
```

Docker 模式下，控制平面通过独立内部网络上的 socket proxy 调用 Docker API。业务容器与 Caddy 位于业务网络。Caddy 将外部请求转发给控制平面，由控制平面解析预览和线上部署目标。

## 第三方 API 兼容矩阵

| 供应商预设 | CodexDeck 接入能力 | 推荐模式 |
| --- | --- | --- |
| OpenAI | 根据所选模型使用 Responses 透传或 Chat 转译 | `auto`，或对已验证的原生模型使用 `responses` |
| OneAPI / NewAPI | 兼容 OpenAI 的中转，端点和功能由上游路由决定 | 探测后用 `auto`，仅支持 Chat 的中转用 `chat` |
| OpenRouter | 可用的 Responses / Chat 端点取决于所选模型 | 探测所选模型后使用 `auto` |
| DeepSeek | 兼容 OpenAI 的 Chat Completions | `chat`，工具调用能力按模型确认 |
| Ollama | 可达的 Ollama 实例提供兼容 OpenAI 的端点 | 探测后用 `auto`，仅支持 Chat 的实例用 `chat` |

接入真实端点后请运行供应商探测，按模型确认流式输出、工具调用和图片能力。Docker 宿主机上的 Ollama 可使用 `http://host.docker.internal:11434/v1`，并在 `CODEXDECK_TRUSTED_HTTP_ORIGINS` 只加入 `http://host.docker.internal:11434`。公网供应商使用 HTTPS。

## 安全模型

1. **凭证隔离。** 供应商 Key 和自定义请求头以 AES-256-GCM 加密存入 SQLite。网关为上游请求解密，Codex 只收到本地网关令牌。生产环境需要保留固定的 `CODEXDECK_MASTER_KEY`。
2. **文件访问边界。** 使用 `realpath` 检查工作区、数据库和导出产物的根目录边界，防止通过符号链接穿越目录。
3. **Docker 接口最小权限。** 控制平面通过内部网络的 `docker-socket-proxy` 使用允许的 Docker 接口。Docker 写权限仍属于宿主机高权限能力。
4. **预览代理的 SSRF 防护。** 代理只解析受管部署目标，检查预发布权限和端口归属，剥离浏览器凭证。浏览器验收限制请求访问部署本身的来源。
5. **凭证脱敏。** `SecretMasker` 对日志、持久化线程事件和发送给客户端的事件遮罩可识别的凭证。
6. **生产部署边界。** 生产环境默认禁用宿主机进程部署，受管业务应使用 Docker 或 Compose。只有明确隔离的开发机才应设置 `CODEXDECK_ALLOW_LOCAL_DEPLOYMENTS=true`。

漏洞请按 [SECURITY.md](SECURITY.md) 私下报告。

## Open API

在控制台的**Open API 与用量**页面创建 Key，并授权 `tasks:write`、`tasks:read` 与目标工作区。将 Key 和工作区 ID 放入本地环境变量 `CODEXDECK_API_KEY` 和 `WORKSPACE_ID`。以下 Bash 示例需要 `curl` 与 `jq`。

```bash
export CODEXDECK_URL=http://127.0.0.1:3000
JOB_KEY=$(openssl rand -hex 16)
: "${CODEXDECK_API_KEY:?请设置 CODEXDECK_API_KEY}"
: "${WORKSPACE_ID:?请设置 WORKSPACE_ID}"

TASK_ID=$(
  curl -fsS "$CODEXDECK_URL/api/v1/tasks" \
    -H "Authorization: Bearer $CODEXDECK_API_KEY" \
    -H "Idempotency-Key: $JOB_KEY" \
    -H "Content-Type: application/json" \
    --data "$(jq -nc --arg id "$WORKSPACE_ID" \
      '{workspace_id: $id, prompt: "概述项目并列出测试命令。"}')" \
  | jq -er '.task_id'
)

curl -fNsS "$CODEXDECK_URL/api/v1/tasks/$TASK_ID/stream" \
  -H "Authorization: Bearer $CODEXDECK_API_KEY" \
  -H "Last-Event-ID: 0"
```

创建任务返回 HTTP `202`，响应包含 `task_id` 和 `thread_id`。同一个逻辑任务重试时保留 `JOB_KEY` 与请求体，新任务需生成新 Key。SSE 重连时传入最后处理的事件 ID。通过 `GET /api/v1/tasks/{task_id}` 查询状态和产物，读取签名下载地址还需 `files:download` 权限。任务可设置白名单中的 `webhook_url` 来接收签名回调。

## 本地开发

使用 Node.js 22.13+、Corepack 管理的固定 pnpm 版本以及 Git。执行真实代理任务还需要官方 Codex CLI。

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
```

在不同终端运行 `pnpm dev:server` 和 `pnpm dev:web`。API 默认监听 `127.0.0.1:3210`，Vite 会代理开发环境的 API、WebSocket 和预览请求。安装兼容的 Playwright Chromium 后，可运行 `pnpm e2e` 使用本地测试夹具验收控制台。

## 路线图

- [x] **V1 基础能力** · 协议网关、凭证隔离、审批、签名产物、Open API 和部署验收。
- [x] **V1 控制台** · 桌面工作台、移动端审批、供应商探测和可续传事件。
- [ ] **发布验证** · 跟踪两个目标架构的发布 CI 和冒烟结果，确定可用的 npm 包名。
- [ ] **V2 规划** · 加强业务容器隔离、扩充供应商兼容性覆盖并改进部署恢复。

## 贡献与许可证

参阅[贡献指南](CONTRIBUTING.md)了解检查和提交流程。CodexDeck 使用 [MIT 许可证](LICENSE)。

[![Waffing/codex-deck 星标历史](https://api.star-history.com/svg?repos=Waffing%2Fcodex-deck&type=Date)](https://star-history.com/#Waffing/codex-deck&Date)

