#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
CDX_LIB=$(cd -- "$(dirname -- "$(realpath -- "$0")")" && pwd -P)
# shellcheck source=deploy/install.sh
source "$CDX_LIB/install.sh"

usage_cdx() {
  cat <<'HELP'
cdx status | start | stop | restart | logs | doctor | upgrade | uninstall
cdx public on|off | port NUMBER | entry random|off|/PATH | password
cdx unban [IP] | two-factor-off | ip off|allow|deny [CIDR ...]
cdx security [set|reset] | preferences [set|reset]     # JSON patch on stdin
cdx defaults-reset                                    # restore both sets of defaults
cdx channels | channel-create | channel-update ID | channel-delete ID  # JSON on stdin for create/update
cdx temp-link [list|create URL|extend ID|revoke ID]    # JSON input for create / extend
cdx workspaces | audit | bans | sessions | session-revoke ID | totp-enroll | totp-confirm
cdx proxy [hostname] | backup | restore SNAPSHOT | tasks | kill THREAD
HELP
}

load_install() {
  local metadata=/etc/codexdeck/host-install
  [[ -f "$metadata" ]] || fail "找不到安装记录。请从 CodexDeck 安装目录运行 V1.2 安装器升级。"
  mapfile -t lines < "$metadata"
  MODE="${lines[0]}" INSTALL_DIR="${lines[1]}" NATIVE_SOURCE="${lines[2]}"
  if [[ "$MODE" == docker && "$(id -u)" == 0 && "${lines[3]}" != 0 ]]; then
    exec runuser -u "$(id -nu "${lines[3]}")" -- "$0" "$@"
  fi
  case "$MODE" in
    docker)
    if ! docker info >/dev/null 2>&1; then DOCKER_SUDO=1; fi
      ENVFILE="$INSTALL_DIR/.env"
      load_existing_config
      DATA="$(native_setting "$ENVFILE" CODEXDECK_DATA_PATH)"
      [[ "$DATA" == /* ]] || DATA="$INSTALL_DIR/${DATA:-data}"
      SERVICE_UID="$(native_setting "$ENVFILE" PUID)" SERVICE_GID="$(native_setting "$ENVFILE" PGID)"
      SERVICE_UID="${SERVICE_UID:-1000}" SERVICE_GID="${SERVICE_GID:-1000}"
      ;;
    native)
      ENVFILE=/etc/codexdeck/codexdeck.env; load_native_config
      DATA="$(native_setting "$ENVFILE" CODEXDECK_DATA_DIR)"
      SERVICE_UID=codexdeck SERVICE_GID=codexdeck
      ;;
    *) fail "Invalid installation record." ;;
  esac
}
running() {
  if [[ "$MODE" == native ]]; then systemctl is-active --quiet codexdeck
  else [[ -n "$(compose ps --status running -q codexdeck)" ]]; fi
}
service_action() {
  local action="$1"
  if [[ "$MODE" == native ]]; then as_root systemctl "$action" codexdeck; return; fi
  case "$action" in
    start) compose up -d codexdeck ;;
    reload) compose up -d --no-deps codexdeck ;;
    stop|restart) compose "$action" codexdeck ;;
    *) fail "Unknown service action." ;;
  esac
}
admin() {
  local mode_args=()
  if ! running; then mode_args=(--offline); fi
  if [[ "$MODE" == native ]]; then
    as_root systemd-run --quiet --pipe --wait --collect --uid=codexdeck \
      --property="EnvironmentFile=$ENVFILE" --setenv=NODE_ENV=production \
      "$(command -v node)" "$NATIVE_SOURCE/apps/server/dist/admin-cli.js" "${mode_args[@]}" "$@"
  elif [[ "${#mode_args[@]}" == 0 ]]; then
    compose exec -T --user "$SERVICE_UID:$SERVICE_GID" codexdeck node /app/apps/server/dist/admin-cli.js "$@"
  else
    compose run --rm -T --no-deps --pull never --user "$SERVICE_UID:$SERVICE_GID" --entrypoint node codexdeck /app/apps/server/dist/admin-cli.js --offline "$@"
  fi
}
cfg() {
  if [[ "$MODE" == native ]]; then update_systemd_env "$ENVFILE" "$1" "$2"
  else update_env_key "$ENVFILE" "$1" "$2"; fi
}
service_health() {
  if [[ "$MODE" == native ]]; then wait_for_native_health; else wait_for_health; fi
}
network_change() {
  local field="$1" arg="$2" previous backup active=0 desired port="$PUBLIC_PORT"
  running && active=1
  if [[ "$field" == public ]]; then
    case "$arg" in on) desired=true ;; off) desired=false ;; *) fail "Usage: cdx public on|off";; esac
    if [[ "$desired" == true ]]; then
      [[ -n "$port" ]] || port="$(free_high_port)"
      if [[ "$PUBLIC" != true ]] && ! port_available "$port"; then fail "HTTPS port $port is occupied."; fi
      panel_cert "$DATA" "$SERVICE_UID" "$SERVICE_GID"
    fi
  else
    valid_port "$arg" || fail "Choose a port between 1024 and 65535."
    previous="$PORT"; [[ "$PUBLIC" != true ]] || previous="$port"
    [[ "$arg" != "$previous" ]] || return 0
    port_available "$arg" || fail "Port $arg is occupied."
  fi
  backup="$(as_root mktemp "$ENVFILE.cdx.XXXXXX")"
  as_root cp -p -- "$ENVFILE" "$backup"
  local priorPort="$PORT" patch=''
  if [[ "$field" == public ]]; then
    cfg CODEXDECK_PUBLIC_PORT "$port"; cfg CODEXDECK_PUBLIC_ENABLED "$desired"
    if [[ "$desired" == true ]]; then
      if [[ -z "$ENTRY_PATH" ]]; then ENTRY_PATH="/$(openssl rand -hex 4)"; cfg CODEXDECK_ENTRY_PATH "$ENTRY_PATH"; fi
      patch='{"public_enabled":true,"entry_enabled":true}'
      if [[ "$MODE" == native ]]; then cfg CODEXDECK_TLS_PORT "$port"; fi
    else
      patch='{"public_enabled":false}'
      if [[ "$MODE" == native ]]; then cfg CODEXDECK_TLS_PORT ''; fi
    fi
  elif [[ "$PUBLIC" == true ]]; then
    cfg CODEXDECK_PUBLIC_PORT "$arg"
    if [[ "$MODE" == native ]]; then cfg CODEXDECK_TLS_PORT "$arg"; fi
  else
    if [[ "$MODE" == native ]]; then cfg CODEXDECK_PORT "$arg"; else cfg CODEXDECK_BIND_PORT "$arg"; fi
    PORT="$arg"
  fi
  local reload=reload
  [[ "$MODE" != native ]] || reload=restart
  local caddy_active=0
  if [[ "$field" == public && "$MODE" == docker && "$MANAGED_CADDY" == 1 &&
      -n "$(compose --profile https ps --status running -q caddy)" ]]; then caddy_active=1; fi
  if { [[ "$active" == 0 ]] || { service_action "$reload" && service_health; }; } &&
     { [[ -z "$patch" ]] || printf '%s' "$patch" | admin security-set; }; then
    if [[ "$field" == public && "$MODE" == docker && "$MANAGED_CADDY" == 1 ]]; then
      if [[ "$desired" == false && "$caddy_active" == 1 ]]; then compose --profile https stop caddy
      elif [[ "$desired" == true && "$active" == 1 ]]; then compose --profile https up -d --no-deps caddy; fi
    fi
    as_root rm -- "$backup"; return
  fi
  as_root cp -p -- "$backup" "$ENVFILE"; PORT="$priorPort"
  if [[ "$active" == 1 ]]; then
    if ! service_action "$reload" || ! service_health; then fail "Rollback needs attention. Prior config: $backup"; fi
  fi
  as_root rm -- "$backup"; fail "Network change failed. The previous configuration was restored."
}

panel_status() {
  local ip config entry=""
  if running; then printf '服务运行中\n'; else printf '服务已停止\n'; fi
  config="$(admin security)" || return 1
  if grep -q '"entry_enabled": true' <<< "$config"; then
    entry="$(sed -n 's/.*"entry_path": "\(\/[A-Za-z0-9_-]*\)".*/\1/p' <<< "$config")"
  fi
  printf '本机入口 http://127.0.0.1:%s%s\n' "$PORT" "$entry"
  if [[ "$PUBLIC" == true ]]; then
    for ip in $(hostname -I); do if [[ "$ip" != *:* ]]; then printf 'HTTPS https://%s:%s%s\n' "$ip" "$PUBLIC_PORT" "$entry"; fi; done
    as_root openssl x509 -in "$DATA/panel-tls.crt" -noout -fingerprint -sha256 -enddate
  fi
  if [[ -n "$DOMAIN" ]]; then printf '域名 https://%s%s\n' "$DOMAIN" "$entry"; fi
  printf '%s\n' "$config"
}
backup_db() {
  local folder="$INSTALL_DIR/backups" dest
  as_root test ! -L "$folder" || fail "Invalid backup directory."
  as_root install -d -m 0700 "$folder"
  dest="$folder/panel-$(date -u +%Y%m%dT%H%M%SZ)-$(openssl rand -hex 4).sqlite"
  as_root python3 "$CDX_LIB/backup.py" backup-db --from "$DATA/codexdeck.sqlite" --to "$dest"
  printf '%s\n' "$dest"
}
restore_db() {
  local file="$1" active=0 prior
  [[ "$file" != */* ]] || file="$(basename "$file")"
  [[ "$file" =~ ^panel-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}\.sqlite$ ]] || fail "Choose an existing panel backup filename."
  file="$INSTALL_DIR/backups/$file"; as_root test -f "$file" || fail "Backup not found."
  confirm "恢复将替换 CodexDeck 数据库并注销会话。输入 RESTORE" RESTORE || return 1
  running && active=1
  if [[ "$active" == 1 ]]; then service_action stop; fi
  if ! prior="$(backup_db)"; then [[ "$active" == 0 ]] || service_action start; fail "Pre-restore backup failed."; fi
  prior="${prior##*$'\n'}"
  if as_root python3 "$CDX_LIB/backup.py" restore-db --from "$file" --to "$DATA/codexdeck.sqlite" &&
    { [[ "$active" == 0 ]] || { service_action start && service_health; }; }; then
    printf '恢复完成；恢复前备份 %s\n' "$prior"; return
  fi
  [[ "$active" == 0 ]] || service_action stop
  as_root python3 "$CDX_LIB/backup.py" restore-db --from "$prior" --to "$DATA/codexdeck.sqlite"
  [[ "$active" == 0 ]] || { service_action start && service_health; }
  fail "Restore failed. Recovered the pre-restore database."
}
confirm() { local value; printf '%s: ' "$1" >/dev/tty; IFS= read -r value </dev/tty && [[ "$value" == "$2" ]]; }

guest_wizard() {
  local name permission ids hours turns tokens cost origin code bind
  admin workspaces
  read -rp '授权工作区 ID（多个用空格分开）: ' ids
  read -rp '访问名称: ' name
  read -rp '权限 readonly / collab_restricted / full_with_approval [readonly]: ' permission
  read -rp '有效小时数 [1]: ' hours
  read -rp '最多轮次（回车不限）: ' turns
  read -rp '最多 Token（回车不限）: ' tokens
  read -rp '最高费用 USD（回车不限）: ' cost
  read -rp '生成提取码？[Y/n]: ' code
  read -rp '绑定首次 IP？[y/N]: ' bind
  read -rp '访客可访问的面板地址（含 https://）: ' origin
  python3 - "$name" "$ids" "${permission:-readonly}" "${hours:-1}" "$turns" "$tokens" "$cost" "$code" "$bind" <<'PY' | admin temp-create "$origin"
import datetime, json, sys
name, ids, permission, hours, turns, tokens, cost, code, bind = sys.argv[1:]
expires = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=float(hours))
print(json.dumps(dict(name=name, workspace_ids=ids.split(), permission=permission,
    expires_at=expires.isoformat(), require_code=code.lower() != 'n', bind_first_ip=bind.lower() == 'y',
    max_turns=int(turns) if turns else None, max_tokens=int(tokens) if tokens else None,
    max_cost=float(cost) if cost else None)))
PY
}
proxy_check() {
  DOMAIN="${1:-$DOMAIN}"; [[ -n "$DOMAIN" ]] || fail "Usage: cdx proxy panel.example.com"; validate_domain
  for tool in nginx caddy; do
    if command -v "$tool" >/dev/null; then printf '检测到 %s ' "$tool"; command -v "$tool"; fi
  done
  cat <<CONFIG
Nginx（独立 TLS server 块内）
  server_name $DOMAIN;
  location = /api/auth/setup { return 404; }
  location ^~ /internal/ { return 404; }
  location / {
    proxy_pass http://127.0.0.1:$PORT;
    proxy_http_version 1.1;
    proxy_set_header Host \$http_host;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-For \$remote_addr;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-CodexDeck-Proxy "";
    proxy_buffering off;
    proxy_read_timeout 3600s;
  }
Caddy
  $DOMAIN {
    @private path /api/auth/setup /internal/*
    respond @private 404
    reverse_proxy 127.0.0.1:$PORT {
      header_up -X-CodexDeck-Proxy
      header_up X-Forwarded-For {remote_host}
    }
  }
配置 CODEXDECK_TRUSTED_PROXIES 为面板看到的反代 IP。快照备份站点配置后，验证 nginx -t 或 caddy validate，再平滑 reload。
CONFIG
  if command -v timeout >/dev/null; then
    timeout 5 openssl s_client -connect "$DOMAIN:443" -servername "$DOMAIN" -verify_hostname "$DOMAIN" -verify_return_error -brief </dev/null || note '公网 TLS 证书或连通性尚待确认。'
  fi
}

command_cdx() {
  local cmd="${1:-status}"; shift || true
  case "$cmd" in
    status) panel_status ;;
    start|stop|restart) service_action "$cmd" ;;
    port|public) network_change "$cmd" "${1:?需要参数}" ;;
    entry)
      case "${1:-random}" in off) printf '%s' '{"entry_enabled":false}' ;;
        random) printf '{"entry_enabled":true,"entry_path":"/%s"}' "$(openssl rand -hex 4)" ;;
        *) [[ "$1" =~ ^/[a-zA-Z0-9_-]{8,64}$ ]] || fail "入口为 / 和 8-64 位字母数字、下划线或短横线。"; printf '{"entry_enabled":true,"entry_path":"%s"}' "$1" ;;
      esac | admin security-set ;;
    password)
      if [[ -t 0 ]]; then
        local secret again
        read -rs -p '新管理员密码（至少 12 位）: ' secret; printf '\n'
        read -rs -p '再次输入: ' again; printf '\n'; [[ "$again" == "$secret" ]] || fail "输入不一致。"
        printf '%s' "$secret" | admin reset-password
      else admin reset-password; fi ;;
    unban|two-factor-off|tasks|kill|sessions|session-revoke|bans|audit|workspaces|totp-enroll|totp-confirm|channels|channel-create|channel-update|channel-delete) admin "$cmd" "$@" ;;
    ip)
      local mode="${1:-off}"; shift || true
      python3 -c 'import json,sys;print(json.dumps(dict(ip_mode=sys.argv[1],ip_ranges=sys.argv[2:])))' "$mode" "$@" | admin security-set ;;
    preferences|security)
      case "${1:-get}" in get) admin "$cmd";; set|reset) admin "$cmd-$1";; *) fail "Use get, set or reset.";; esac ;;
    defaults-reset)
      confirm "恢复工作台与安全默认值，关闭 2FA 并注销管理员会话。输入 RESET" RESET || return 1
      admin defaults-reset ;;
    temp-link)
      if [[ "$#" == 0 && -t 0 ]]; then guest_wizard; return; fi
      local op="${1:-list}"; shift || true
      case "$op" in create|extend|revoke|list|live) admin "temp-$op" "$@";; *) fail "Use list/create/extend/revoke/live.";; esac ;;
    logs) if [[ "$MODE" == native ]]; then as_root journalctl -fu codexdeck; else compose logs -f --tail=50 codexdeck; fi ;;
    backup) backup_db ;; restore) restore_db "${1:?指定备份文件名}" ;;
    proxy) proxy_check "$@" ;;
    doctor) panel_status; if [[ "$MODE" == native ]]; then curl --fail --max-time 5 "http://127.0.0.1:$PORT/api/health"; else compose exec -T codexdeck curl -fsS --max-time 5 http://127.0.0.1:3000/api/health; fi; printf '\n' ;;
    upgrade|uninstall)
      local flags=("--$cmd" --dir "$INSTALL_DIR")
      [[ "$MODE" != native ]] || flags+=(--native)
      bash "$CDX_LIB/install.sh" "${flags[@]}" "$@" ;;
    *) usage_cdx; return 2 ;;
  esac
}

menu() {
  local n args cmd
  local -a words
  while true; do
    if [[ -t 1 ]]; then printf '\033[1;36m'; fi
    cat <<'MENU'
=============== CodexDeck 命令行工具 (cdx) ===============
 (1) 面板状态与访问地址      (2) 启动 / 停止 / 重启
 (3) 开启 / 关闭公网        (4) 修改面板端口
 (5) 设置 / 随机入口        (6) 紧急关闭入口
 (7) 重置管理员密码         (8) 解封 IP / 关闭 2FA
 (9) IP 黑白名单            (10) 临时访问链接
(11) 实时日志               (12) 反代与 SSL 自检
(13) 数据库备份 / 还原      (14) 正在运行的任务 / 精准终止
(15) 升级 / 健康检查        (16) 卸载 CodexDeck
 (0) 退出
MENU
    if [[ -t 1 ]]; then printf '\033[0m'; fi
    read -rp '选择: ' n || return 0
    args=""; cmd=""
    case "$n" in
      0) return;; 1) cmd=status;; 2) read -rp 'start / stop / restart: ' cmd; [[ "$cmd" =~ ^(start|stop|restart)$ ]] || continue;;
      3) cmd=public; read -rp 'on / off: ' args;; 4) cmd=port; read -rp '端口: ' args;;
      5) cmd=entry; read -rp 'random 或 /自定义路径: ' args;; 6) cmd=entry;args=off;; 7) cmd=password;;
      8) read -rp 'unban / two-factor-off: ' cmd; [[ "$cmd" =~ ^(unban|two-factor-off)$ ]] || continue;;
      9) cmd=ip; read -rp 'off 或 allow/deny 后接空格分隔的 CIDR: ' args;;
      10) cmd='temp-link'; read -rp '回车创建邀请，或 list / live / extend ID / revoke ID: ' args;;
      11) cmd=logs;; 12) cmd=proxy; read -rp '域名: ' args;;
      13) read -rp 'backup 或 restore 备份名: ' args;cmd="${args%% *}"; [[ "$args" != "$cmd" ]] && args="${args#* }" || args=""; [[ "$cmd" =~ ^(backup|restore)$ ]] || continue;;
      14) cmd=tasks; read -rp '列出任务按回车，或输入要终止的 threadId: ' args; [[ -z "$args" ]] || cmd='kill';;
      15) read -rp 'doctor / upgrade: ' cmd; [[ "$cmd" =~ ^(doctor|upgrade)$ ]] || continue;;
      16) confirm '输入 UNINSTALL 以卸载 CodexDeck' UNINSTALL || continue; cmd=uninstall;;
      *) continue;;
    esac
    read -ra words <<<"$args"
    if [[ "$cmd" == temp-link && "$args" =~ ^(create|extend) ]]; then
      local payload
      read -rp '输入请求 JSON: ' payload
      (set -e; printf '%s' "$payload" | command_cdx "$cmd" "${words[@]}") || note '操作失败。'
    else
      # Isolate fail/exit from the interactive menu.
      (set -e; command_cdx "$cmd" "${words[@]}") || note '操作失败。'
    fi
  done
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  if [[ "${1:-}" =~ ^(help|--help|-h)$ ]]; then usage_cdx; exit; fi
  load_install "$@"
  if [[ "$#" == 0 ]]; then menu; else command_cdx "$@"; fi
fi
