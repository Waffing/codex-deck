#!/usr/bin/env bash
set -Eeuo pipefail

if [ "$(id -u)" -eq 0 ]; then
  DEFAULT_DIR="/opt/codexdeck"
else
  DEFAULT_DIR="${HOME:-/tmp}"/codexdeck
fi
REPOSITORY="${CODEXDECK_REPOSITORY:-}"
IMAGE="${CODEXDECK_IMAGE:-}"
INSTALL_DIR=""
WORKSPACES=""
DOMAIN=""
PORT="3000"
STORED_PORT=""
MODE="docker"
ACTION="install"
YES=0
WITH_PLAYWRIGHT=0
PORT_SET=0
WORKSPACES_SET=0
DOMAIN_SET=0
DIR_SET=0
PLAYWRIGHT_SET=0
UPGRADE_SET=0
UNINSTALL_SET=0
EXISTING_INSTALL=0
SOURCE_DIR=""
DOCKER_SUDO=0

usage() {
  cat <<'USAGE'
CodexDeck installer

Usage:
  install.sh [--native] [--upgrade] [--uninstall] [--yes]
             [--port PORT] [--workspaces PATH] [--domain DOMAIN]
             [--with-playwright] [--dir PATH]

Environment overrides:
  CODEXDECK_REPOSITORY=Waffing/codex-deck
  CODEXDECK_IMAGE=ghcr.io/waffing/codex-deck:latest

Install directory defaults to /opt/codexdeck for root and $HOME/codexdeck otherwise.
Use --native for a systemd installation on the host. --yes keeps data on uninstall.
USAGE
}

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

note() {
  printf '%s\n' "$*"
}

as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    command -v sudo >/dev/null 2>&1 || fail "This operation requires root or sudo."
    sudo "$@"
  fi
}

prompt_value() {
  local prompt="$1" default="$2" value=""
  if [ "$YES" -eq 1 ] || [ ! -r /dev/tty ]; then
    REPLY="$default"
    return
  fi
  printf '%s [%s] ' "$prompt" "$default" >/dev/tty
  IFS= read -r value </dev/tty || value=""
  REPLY="${value:-$default}"
}

script_repository() {
  local origin=""
  if [ -n "$REPOSITORY" ]; then
    printf '%s' "$REPOSITORY"
    return
  fi
  if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
    local script_dir
    script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
    if git -C "$script_dir" rev-parse --show-toplevel >/dev/null 2>&1; then
      origin="$(git -C "$script_dir" config --get remote.origin.url || true)"
    fi
  fi
  if [[ "$origin" =~ github\.com[:/]([^/]+)/([^/.]+)(\.git)?$ ]]; then
    printf '%s/%s' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
  else
    printf '%s' "Waffing/codex-deck"
  fi
}

discover_local_source() {
  if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
    local candidate
    candidate="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
    if [ -f "$candidate/pnpm-workspace.yaml" ] && [ -d "$candidate/apps/server/src" ]; then
      SOURCE_DIR="$candidate"
    fi
  fi
}

fetch_deploy_file() {
  local name="$1" destination="$2" downloaded
  if [ -n "$SOURCE_DIR" ] && [ -f "$SOURCE_DIR/deploy/$name" ]; then
    install -m 0644 "$SOURCE_DIR/deploy/$name" "$destination"
    return
  fi
  local repo
  repo="$(script_repository)"
  downloaded="$(mktemp "$destination.XXXXXX")"
  if ! curl -fsSL "https://raw.githubusercontent.com/$repo/main/deploy/$name" -o "$downloaded"; then
    rm -f -- "$downloaded"
    fail "Could not download deploy/$name from $repo. Verify CODEXDECK_REPOSITORY."
  fi
  chmod 0644 "$downloaded"
  mv -f -- "$downloaded" "$destination"
}

valid_port() {
  [[ "$1" =~ ^[0-9]{1,5}$ ]] && [ "$1" -ge 1024 ] && [ "$1" -le 65535 ]
}

port_available() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -H -ltn | awk -v port=":$port" '$4 ~ (port "$") { found=1 } END { exit found+0 }'
    return
  fi
  if command -v python3 >/dev/null 2>&1 && python3 -c 'import socket' >/dev/null 2>&1; then
    python3 - "$port" <<'PY'
import socket, sys
sock = socket.socket()
sock.settimeout(0.5)
try:
    sys.exit(1 if sock.connect_ex(("127.0.0.1", int(sys.argv[1]))) == 0 else 0)
finally:
    sock.close()
PY
    return
  fi
  if (echo >/dev/tcp/127.0.0.1/"$port") >/dev/null 2>&1; then return 1; fi
  return 0
}

check_port() {
  valid_port "$PORT" || fail "Port must be between 1024 and 65535."
  if port_available "$PORT"; then return 0; fi
  if [ "$EXISTING_INSTALL" -eq 1 ] && [ "$PORT" = "$STORED_PORT" ] &&
      curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    return 0
  fi
  fail "Port $PORT is already accepting local connections. Choose another port."
}

canonical_directory() {
  local requested="$1"
  mkdir -p -- "$requested"
  (cd -- "$requested" && pwd -P)
}

validate_domain() {
  [ -z "$DOMAIN" ] && return 0
  [[ "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] ||
    fail "Domain must be a hostname without a scheme, path, or port."
  [[ "$DOMAIN" == *.* && "$DOMAIN" != *..* ]] || fail "Enter a fully qualified domain name."
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --native) MODE="native"; shift ;;
      --upgrade) ACTION="upgrade"; UPGRADE_SET=1; shift ;;
      --uninstall) ACTION="uninstall"; UNINSTALL_SET=1; shift ;;
      --yes|-y) YES=1; shift ;;
      --with-playwright) WITH_PLAYWRIGHT=1; PLAYWRIGHT_SET=1; shift ;;
      --port)
        [ "$#" -ge 2 ] || fail "--port requires a value."
        PORT="$2"; PORT_SET=1; shift 2 ;;
      --workspaces)
        [ "$#" -ge 2 ] || fail "--workspaces requires a path."
        WORKSPACES="$2"; WORKSPACES_SET=1; shift 2 ;;
      --domain)
        [ "$#" -ge 2 ] || fail "--domain requires a value."
        DOMAIN="$2"; DOMAIN_SET=1; shift 2 ;;
      --dir)
        [ "$#" -ge 2 ] || fail "--dir requires a path."
        INSTALL_DIR="$2"; DIR_SET=1; shift 2 ;;
      --help|-h) usage; exit 0 ;;
      *) fail "Unknown option: $1. See --help." ;;
    esac
  done
  if [ "$UPGRADE_SET" -eq 1 ] && [ "$UNINSTALL_SET" -eq 1 ]; then
    fail "--upgrade and --uninstall cannot be combined."
  fi
  if [ -n "$REPOSITORY" ] && ! [[ "$REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
    fail "CODEXDECK_REPOSITORY must be a GitHub repository slug."
  fi
}

load_existing_config() {
  local file="$INSTALL_DIR/.env"
  [ -f "$file" ] || return 0
  STORED_PORT="$(sed -n 's/^CODEXDECK_BIND_PORT=//p' "$file" | head -n 1 | tr -d "\"'")"
  if [ -z "$STORED_PORT" ]; then
    STORED_PORT="$(sed -n 's/^CODEXDECK_PORT=//p' "$file" | head -n 1 | tr -d '"')"
    [ "$STORED_PORT" != "3000" ] || STORED_PORT=""
  fi
  if [ "$PORT_SET" -eq 0 ]; then
    PORT="${STORED_PORT:-3000}"
  fi
  if [ "$WORKSPACES_SET" -eq 0 ]; then
    WORKSPACES="$(sed -n 's/^CODEXDECK_WORKSPACES_HOST=//p' "$file" | head -n 1 | tr -d '"' | tr -d "'")"
    if [ -z "$WORKSPACES" ]; then
      WORKSPACES="$(sed -n 's/^CODEXDECK_WORKSPACES=//p' "$file" | head -n 1 | tr -d '"' | tr -d "'")"
    fi
  fi
  if [ "$DOMAIN_SET" -eq 0 ]; then
    DOMAIN="$(sed -n 's/^CODEXDECK_DOMAIN=//p' "$file" | head -n 1 | tr -d '"' | tr -d "'")"
  fi
  if [ "$PLAYWRIGHT_SET" -eq 0 ] && grep -q 'latest-playwright' "$file"; then
    WITH_PLAYWRIGHT=1
  fi
  if [ -z "$IMAGE" ]; then
    IMAGE="$(sed -n 's/^CODEXDECK_IMAGE=//p' "$file" | head -n 1 | tr -d '"' | tr -d "'")"
  fi
  if [ "$PLAYWRIGHT_SET" -eq 1 ] && [ "$WITH_PLAYWRIGHT" -eq 1 ] &&
      [[ "$IMAGE" == *:latest || "$IMAGE" == *:latest-playwright ]]; then
    IMAGE="${IMAGE%:*}:latest-playwright"
  fi
}

load_native_config() {
  local file="/etc/codexdeck/codexdeck.env"
  [ -f "$file" ] || return 0
  STORED_PORT="$(sed -n 's/^CODEXDECK_PORT=//p' "$file" | head -n 1)"
  if [ "$PORT_SET" -eq 0 ]; then
    PORT="${STORED_PORT:-3000}"
  fi
  if [ "$WORKSPACES_SET" -eq 0 ]; then
    WORKSPACES="$(sed -n 's/^CODEXDECK_WORKSPACES=//p' "$file" | head -n 1)"
  fi
}

install_environment_file() {
  local file="$INSTALL_DIR/.env"
  if [ -f "$file" ]; then
    update_env_key "$file" CODEXDECK_BIND_PORT "$PORT"
    update_env_key "$file" CODEXDECK_PORT "3000"
    update_env_key "$file" CODEXDECK_HOST "0.0.0.0"
    update_env_key "$file" CODEXDECK_WORKSPACES_HOST "$WORKSPACES"
    update_env_key "$file" CODEXDECK_DATA_DIR "/data"
    update_env_key "$file" CODEXDECK_DEPLOYMENT_NETWORK "codexdeck-net"
    update_env_key "$file" CODEXDECK_DOMAIN "$DOMAIN"
    update_env_key "$file" CODEXDECK_IMAGE "$IMAGE"
    chmod 0600 "$file"
    return
  fi

  local master_key uid gid
  master_key="$(openssl rand -hex 32)" || fail "Could not generate CODEXDECK_MASTER_KEY. Install openssl."
  uid="${INSTALL_UID:-1000}"
  gid="${INSTALL_GID:-1000}"
  umask 077
  cat >"$file" <<EOF
CODEXDECK_PORT=3000
CODEXDECK_BIND_PORT=$PORT
CODEXDECK_HOST=0.0.0.0
CODEXDECK_MASTER_KEY=$master_key
CODEXDECK_IMAGE=$IMAGE
CODEXDECK_DATA_DIR=/data
CODEXDECK_WORKSPACES_HOST='$WORKSPACES'
CODEXDECK_DEPLOYMENT_NETWORK=codexdeck-net
CODEXDECK_DOMAIN=$DOMAIN
PUID=$uid
PGID=$gid
EOF
  chmod 0600 "$file"
}

update_env_key() {
  local file="$1" key="$2" value="$3" temporary
  temporary="$(mktemp "$file.XXXXXX")"
  awk -v key="$key" 'index($0, key "=") != 1 { print }' "$file" >"$temporary"
  printf "%s='%s'\n" "$key" "$value" >>"$temporary"
  chmod 0600 "$temporary"
  mv -f -- "$temporary" "$file"
}

compose() {
  if [ "$DOCKER_SUDO" -eq 1 ]; then
    (cd -- "$INSTALL_DIR" && sudo docker compose --env-file .env -f docker-compose.yml "$@")
  else
    (cd -- "$INSTALL_DIR" && docker compose --env-file .env -f docker-compose.yml "$@")
  fi
}

detect_docker_access() {
  if docker info >/dev/null 2>&1; then
    DOCKER_SUDO=0
  elif command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; then
    DOCKER_SUDO=1
  else
    fail "Docker is unavailable or this account cannot access the daemon."
  fi
}

compose_version_available() {
  if [ "$DOCKER_SUDO" -eq 1 ]; then
    sudo docker compose version >/dev/null 2>&1
  else
    docker compose version >/dev/null 2>&1
  fi
}

ensure_docker() {
  [[ "$(uname -s)" == Linux ]] || fail "Docker installation mode is supported on Linux only."
  case "$(uname -m)" in x86_64|aarch64|arm64) ;; *) fail "Docker installation supports amd64 and arm64 only." ;; esac
  if ! command -v docker >/dev/null 2>&1; then
    command -v curl >/dev/null 2>&1 || fail "Install curl before installing Docker."
    local installer
    installer="$(mktemp)"
    curl -fsSL https://get.docker.com -o "$installer" || fail "Could not download the Docker installer."
    as_root sh "$installer"
    rm -f -- "$installer"
    if command -v systemctl >/dev/null 2>&1; then as_root systemctl enable --now docker; fi
  fi
  if ! docker info >/dev/null 2>&1 && command -v systemctl >/dev/null 2>&1; then
    as_root systemctl enable --now docker || true
  fi
  detect_docker_access
  if ! compose_version_available; then
    if command -v apt-get >/dev/null 2>&1; then
      as_root apt-get update
      as_root apt-get install -y docker-compose-plugin
    elif command -v dnf >/dev/null 2>&1; then
      as_root dnf install -y docker-compose-plugin
    elif command -v yum >/dev/null 2>&1; then
      as_root yum install -y docker-compose-plugin
    else
      fail "Docker Compose v2 is missing. Install docker-compose-plugin for this distribution."
    fi
    detect_docker_access
  fi
}

prepare_install_directory() {
  if [ "$DIR_SET" -eq 0 ]; then
    prompt_value "安装目录" "$DEFAULT_DIR"
    INSTALL_DIR="$REPLY"
  fi
  [ -n "$INSTALL_DIR" ] || fail "Install directory cannot be empty."
  case "$INSTALL_DIR" in /*) ;; *) INSTALL_DIR="$PWD/$INSTALL_DIR" ;; esac
  [ ! -L "$INSTALL_DIR" ] || fail "Install directory cannot be a symlink."
  mkdir -p -- "$INSTALL_DIR" 2>/dev/null ||
    as_root install -d -o "$(id -u)" -g "$(id -g)" -m 0755 "$INSTALL_DIR"
  INSTALL_DIR="$(cd -- "$INSTALL_DIR" && pwd -P)"
  [ "$INSTALL_DIR" != "/" ] || fail "Refusing to use the filesystem root as the install directory."
}

prepare_workspaces() {
  if [ -z "$WORKSPACES" ]; then
    local default_workspaces="$INSTALL_DIR/workspaces"
    [ "$MODE" = "native" ] && default_workspaces="$INSTALL_DIR/source/workspaces"
    prompt_value "工作区目录" "$default_workspaces"
    WORKSPACES="$REPLY"
  fi
  case "$WORKSPACES" in /*) ;; *) WORKSPACES="$INSTALL_DIR/$WORKSPACES" ;; esac
  mkdir -p -- "$WORKSPACES" 2>/dev/null || as_root mkdir -p -- "$WORKSPACES"
  WORKSPACES="$(as_root realpath -- "$WORKSPACES")"
  [ "$WORKSPACES" != "/" ] || fail "The filesystem root cannot be used as a workspace directory."
  case "$WORKSPACES" in *"'"*|*$'\n'*) fail "Workspace paths cannot contain a single quote or newline." ;; esac
}

choose_install_options() {
  if [ "$ACTION" = "upgrade" ] || [ "$EXISTING_INSTALL" -eq 1 ]; then load_existing_config; fi
  if [ "$MODE" = "native" ] && { [ "$ACTION" = "upgrade" ] || [ "$EXISTING_INSTALL" -eq 1 ]; }; then
    load_native_config
  fi
  if [ "$PORT_SET" -eq 0 ] && [ "$ACTION" != "upgrade" ] && [ "$EXISTING_INSTALL" -eq 0 ]; then
    prompt_value "访问端口" "3000"
    PORT="$REPLY"
  fi
  if [ "$WORKSPACES_SET" -eq 0 ] && [ -z "$WORKSPACES" ] && [ "$ACTION" != "upgrade" ] && [ "$EXISTING_INSTALL" -eq 0 ]; then
    local default_workspaces="$INSTALL_DIR/workspaces"
    [ "$MODE" = "native" ] && default_workspaces="$INSTALL_DIR/source/workspaces"
    prompt_value "工作区目录" "$default_workspaces"
    WORKSPACES="$REPLY"
  fi
  if [ "$DOMAIN_SET" -eq 0 ] && [ "$ACTION" != "upgrade" ] && [ "$EXISTING_INSTALL" -eq 0 ]; then
    prompt_value "公网域名（留空跳过 HTTPS）" ""
    DOMAIN="$REPLY"
  fi
  if [ "$PLAYWRIGHT_SET" -eq 0 ] && [ "$YES" -eq 0 ] && [ "$ACTION" != "upgrade" ] && [ "$EXISTING_INSTALL" -eq 0 ]; then
    prompt_value "安装完整浏览器验收镜像？(y/N)" "n"
    [[ "$REPLY" =~ ^[Yy]$ ]] && WITH_PLAYWRIGHT=1
  fi
  if [ "$ACTION" != "upgrade" ] || [ "$PORT_SET" -eq 1 ]; then check_port; fi
  validate_domain
  if [ "$MODE" = "native" ] && [ -n "$DOMAIN" ]; then
    fail "Native mode leaves HTTPS termination to an existing reverse proxy. Omit --domain."
  fi
}

select_image() {
  if [ -z "$IMAGE" ]; then
    local repo
    repo="${CODEXDECK_IMAGE_REPOSITORY:-ghcr.io/waffing/codex-deck}"
    if [ "$WITH_PLAYWRIGHT" -eq 1 ]; then
      IMAGE="$repo:latest-playwright"
    else
      IMAGE="$repo:latest"
    fi
  fi
}

docker_install() {
  ensure_docker
  fetch_deploy_file docker-compose.yml "$INSTALL_DIR/docker-compose.yml"
  fetch_deploy_file .env.example "$INSTALL_DIR/.env.example"
  fetch_deploy_file Caddyfile.template "$INSTALL_DIR/Caddyfile.template"
  fetch_deploy_file install.sh "$INSTALL_DIR/install.sh"
  if [ ! -f "$INSTALL_DIR/.env.example" ]; then fail "deploy/.env.example was not installed."; fi
  if [ ! -f "$INSTALL_DIR/docker-compose.yml" ]; then fail "deploy/docker-compose.yml was not installed."; fi
  mkdir -p "$INSTALL_DIR/data"
  chmod 0755 "$INSTALL_DIR/install.sh"
  if [ -z "$WORKSPACES" ]; then WORKSPACES="$INSTALL_DIR/workspaces"; fi
  prepare_workspaces
  if [ -z "$IMAGE" ]; then select_image; fi
  [[ "$IMAGE" =~ ^[A-Za-z0-9][A-Za-z0-9._/:@-]*$ ]] ||
    fail "CODEXDECK_IMAGE is not a valid registry image reference."
  local current_uid current_gid
  current_uid="$(id -u)"
  current_gid="$(id -g)"
  if [ "$current_uid" -eq 0 ] && [ -n "${SUDO_USER:-}" ]; then
    current_uid="$(id -u "$SUDO_USER")"
    current_gid="$(id -g "$SUDO_USER")"
  elif [ "$current_uid" -eq 0 ]; then
    current_uid=1000
    current_gid=1000
  fi
  INSTALL_UID="$current_uid" INSTALL_GID="$current_gid" install_environment_file
  if [ -n "$DOMAIN" ]; then
    grep -q 'CODEXDECK_DOMAIN' "$INSTALL_DIR/Caddyfile.template" ||
      fail "Caddyfile.template does not support CODEXDECK_DOMAIN."
    cp "$INSTALL_DIR/Caddyfile.template" "$INSTALL_DIR/Caddyfile"
  fi
  chmod 0600 "$INSTALL_DIR/.env"
  if [ "$ACTION" = "upgrade" ]; then compose pull; fi
  if [ -n "$DOMAIN" ]; then
    compose --profile https up -d
  else
    compose up -d
  fi
  wait_for_health
}

wait_for_health() {
  local attempt
  for ((attempt=1; attempt<=45; attempt++)); do
    if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
      printf '%s\n' "CodexDeck is ready."
      return 0
    fi
    sleep 2
  done
  printf '%s\n' "CodexDeck did not become healthy. Recent container logs:" >&2
  compose logs --tail 50 >&2 || true
  return 1
}

native_install() {
  [[ "$(uname -s)" == Linux ]] || fail "Native systemd installation is supported on Linux only."
  command -v systemctl >/dev/null 2>&1 || fail "Native installation requires systemd."
  command -v node >/dev/null 2>&1 || fail "Native installation requires Node.js 22.13 or newer."
  node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 13) ? 0 : 1)' ||
    fail "Native installation requires Node.js 22.13 or newer."
  command -v corepack >/dev/null 2>&1 || fail "Native installation requires Corepack."
  command -v codex >/dev/null 2>&1 || fail "Install the OpenAI Codex CLI and retry native installation."
  command -v git >/dev/null 2>&1 || fail "Native installation requires Git."
  if [ "$ACTION" != "upgrade" ] || [ "$PORT_SET" -eq 1 ]; then check_port; fi
  validate_domain
  local source="$INSTALL_DIR/source" data_dir="$INSTALL_DIR/source/data" repo service_user node_bin codex_bin service_file env_dir path_value
  repo="$(script_repository)"
  service_user="codexdeck"
  if ! getent passwd "$service_user" >/dev/null; then
    as_root useradd --system --create-home --home-dir /var/lib/codexdeck --shell /usr/sbin/nologin "$service_user"
  fi
  if [ "$ACTION" = "upgrade" ]; then
    [ -d "$source/.git" ] || fail "No native installation was found under $source."
    as_root git -C "$source" pull --ff-only
  elif [ ! -d "$source/.git" ]; then
    as_root git clone --depth 1 "https://github.com/$repo.git" "$source"
  fi
  if [ -z "$WORKSPACES" ]; then WORKSPACES="$source/workspaces"; fi
  as_root mkdir -p "$source/data" "$WORKSPACES" /etc/codexdeck
  WORKSPACES="$(as_root realpath -- "$WORKSPACES")"
  as_root chown -R "$service_user:$service_user" "$source/data"
  as_root chmod 0750 "$source/data"
  if [ -z "$(find "$WORKSPACES" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
    as_root chown "$service_user:$service_user" "$WORKSPACES"
    as_root chmod 0750 "$WORKSPACES"
  elif [ "$(id -u)" -eq 0 ]; then
    { runuser -u "$service_user" -- test -r "$WORKSPACES" &&
      runuser -u "$service_user" -- test -w "$WORKSPACES" &&
      runuser -u "$service_user" -- test -x "$WORKSPACES"; } ||
      fail "The existing workspace is not accessible to codexdeck. Grant it read/write/execute access first."
  else
    { sudo -u "$service_user" test -r "$WORKSPACES" &&
      sudo -u "$service_user" test -w "$WORKSPACES" &&
      sudo -u "$service_user" test -x "$WORKSPACES"; } ||
      fail "The existing workspace is not accessible to codexdeck. Grant it read/write/execute access first."
  fi
  (cd "$source" && as_root corepack pnpm install --frozen-lockfile && as_root corepack pnpm build)
  node_bin="$(command -v node)"
  codex_bin="$(command -v codex)"
  if [ "$(id -u)" -eq 0 ]; then
    runuser -u "$service_user" -- test -x "$node_bin" ||
      fail "Node.js is not executable by codexdeck. Install Node.js system-wide."
    runuser -u "$service_user" -- test -x "$codex_bin" ||
      fail "The Codex CLI is not executable by codexdeck. Install it system-wide."
  else
    sudo -u "$service_user" test -x "$node_bin" ||
      fail "Node.js is not executable by codexdeck. Install Node.js system-wide."
    sudo -u "$service_user" test -x "$codex_bin" ||
      fail "The Codex CLI is not executable by codexdeck. Install it system-wide."
  fi
  path_value="$(dirname "$node_bin"):$(dirname "$codex_bin"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  if [ "$WITH_PLAYWRIGHT" -eq 1 ]; then
    as_root install -d -o "$service_user" -g "$service_user" -m 0750 /var/lib/codexdeck
    as_root runuser -u "$service_user" -- env HOME=/var/lib/codexdeck PATH="$path_value" \
      "$source/apps/server/node_modules/.bin/playwright-core" install chromium
  fi
  service_file="/etc/systemd/system/codexdeck.service"
  env_dir="/etc/codexdeck"
  if [ ! -f "$env_dir/codexdeck.env" ]; then
    local key
    key="$(openssl rand -hex 32)" || fail "Could not generate a master key. Install openssl."
    as_root install -m 0600 /dev/null "$env_dir/codexdeck.env"
    as_root tee "$env_dir/codexdeck.env" >/dev/null <<EOF
CODEXDECK_MASTER_KEY=$key
CODEXDECK_PORT=$PORT
CODEXDECK_HOST=127.0.0.1
CODEXDECK_DATA_DIR=$(systemd_quote "$data_dir")
CODEXDECK_WORKSPACES=$(systemd_quote "$WORKSPACES")
CODEX_BIN=$(systemd_quote "$codex_bin")
EOF
  else
    update_systemd_env "$env_dir/codexdeck.env" CODEXDECK_PORT "$PORT"
    update_systemd_env "$env_dir/codexdeck.env" CODEXDECK_DATA_DIR "$data_dir"
    update_systemd_env "$env_dir/codexdeck.env" CODEXDECK_WORKSPACES "$WORKSPACES"
    update_systemd_env "$env_dir/codexdeck.env" CODEX_BIN "$codex_bin"
  fi
  as_root chmod 0600 "$env_dir/codexdeck.env"
  as_root tee "$service_file" >/dev/null <<EOF
[Unit]
Description=CodexDeck local AI workbench
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$service_user
Group=$service_user
WorkingDirectory=$(systemd_quote "$source")
Environment=NODE_ENV=production
Environment=PATH=$(systemd_quote "$path_value")
Environment=HOME=/var/lib/codexdeck
EnvironmentFile=$env_dir/codexdeck.env
ExecStart=$(systemd_quote "$node_bin") apps/server/dist/index.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/lib/codexdeck $(systemd_quote "$source/data") $(systemd_quote "$WORKSPACES")

[Install]
WantedBy=multi-user.target
EOF
  as_root systemctl daemon-reload
  as_root systemctl enable --now codexdeck
  if [ "$ACTION" = "upgrade" ]; then as_root systemctl restart codexdeck; fi
  wait_for_native_health
}

update_systemd_env() {
  local file="$1" key="$2" value="$3" temporary
  temporary="$(mktemp)"
  as_root sed "/^$key=/d" "$file" >"$temporary"
  printf "%s=%s\n" "$key" "$(systemd_quote "$value")" >>"$temporary"
  as_root install -m 0600 "$temporary" "$file"
  rm -f -- "$temporary"
}

systemd_quote() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//%/%%}"
  printf '"%s"' "$value"
}

wait_for_native_health() {
  local attempt
  for ((attempt=1; attempt<=45; attempt++)); do
    if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
      printf '%s\n' "CodexDeck is ready."
      return 0
    fi
    sleep 2
  done
  printf '%s\n' "CodexDeck did not become healthy. Recent service logs:" >&2
  as_root journalctl -u codexdeck -n 50 --no-pager >&2 || true
  return 1
}

uninstall() {
  prepare_install_directory
  if [ "$MODE" = "native" ]; then load_native_config
  else load_existing_config
  fi
  if [ "$MODE" = "native" ]; then
    as_root systemctl disable --now codexdeck 2>/dev/null || true
    as_root rm -f /etc/systemd/system/codexdeck.service
    as_root systemctl daemon-reload
  elif [ -f "$INSTALL_DIR/docker-compose.yml" ]; then
    ensure_docker
    compose --profile https down --remove-orphans
  fi

  local keep="y"
  if [ "$YES" -eq 0 ] && [ -r /dev/tty ]; then
    prompt_value "保留数据与工作区目录？(Y/n)" "y"
    keep="$REPLY"
  fi
  if [[ "$keep" =~ ^[Nn]$ ]]; then
    local data="$INSTALL_DIR/data" target
    if [ "$MODE" = "native" ]; then data="$INSTALL_DIR/source/data"; fi
    if [ -d "$data" ] && [ ! -L "$data" ]; then as_root rm -rf -- "$data"; fi
    if [ -n "$WORKSPACES" ]; then
      if [ -d "$WORKSPACES" ]; then target="$(cd -- "$WORKSPACES" && pwd -P)"
      else target="$WORKSPACES"
      fi
      if [ -d "$target" ] && [[ "$target" == "$INSTALL_DIR/"* ]] && [ ! -L "$WORKSPACES" ]; then
        as_root rm -rf -- "$target"
      elif [ -d "$target" ]; then
        note "Keeping workspace directory outside the install directory: $target"
      fi
    elif [ -d "$INSTALL_DIR/workspaces" ] && [ ! -L "$INSTALL_DIR/workspaces" ]; then
      as_root rm -rf -- "$INSTALL_DIR/workspaces"
    fi
    if [ "$MODE" = "native" ] && [ -d "$INSTALL_DIR/source" ] && [ ! -L "$INSTALL_DIR/source" ]; then
      as_root rm -rf -- "$INSTALL_DIR/source"
      as_root rm -f /etc/codexdeck/codexdeck.env
      as_root userdel codexdeck 2>/dev/null || true
      as_root rm -rf /etc/codexdeck
    else
      as_root rm -f -- "$INSTALL_DIR/.env" "$INSTALL_DIR/.env.example" "$INSTALL_DIR/docker-compose.yml" \
        "$INSTALL_DIR/Caddyfile" "$INSTALL_DIR/Caddyfile.template" "$INSTALL_DIR/install.sh"
    fi
  else
    note "Data, workspaces, configuration and the encryption key have been retained for reinstall."
  fi
  note "CodexDeck services have been removed."
}

print_success() {
  local host="http://127.0.0.1:$PORT" public="$DOMAIN"
  if [ -n "$public" ]; then host="https://$public"; fi
  local docker_command="docker"
  if [ "$DOCKER_SUDO" -eq 1 ]; then docker_command="sudo docker"; fi
  local logs="cd \"$INSTALL_DIR\" && $docker_command compose logs -f"
  local upgrade="bash \"$INSTALL_DIR/install.sh\" --upgrade --dir \"$INSTALL_DIR\" --yes"
  local uninstall_command="bash \"$INSTALL_DIR/install.sh\" --uninstall --dir \"$INSTALL_DIR\""
  if [ "$MODE" = "native" ]; then
    logs="sudo journalctl -u codexdeck -f"
    upgrade="sudo bash \"$INSTALL_DIR/source/deploy/install.sh\" --native --upgrade --dir \"$INSTALL_DIR\" --yes"
    uninstall_command="sudo bash \"$INSTALL_DIR/source/deploy/install.sh\" --native --uninstall --dir \"$INSTALL_DIR\""
  fi
  cat <<EOF

  CodexDeck is ready
  ------------------
  Local URL:       http://127.0.0.1:$PORT
  Public URL:      ${public:+https://$public}
  Setup wizard:    http://127.0.0.1:$PORT
  Health check:    curl -fsS http://127.0.0.1:$PORT/api/health
  Logs:            $logs
  Upgrade:         $upgrade
  Uninstall:       $uninstall_command

  Configure the first administrator, provider, model and workspace in the setup wizard.
EOF
  if [ -n "$public" ]; then
    printf '  Public endpoint: %s\n' "$host"
  fi
}

main() {
  parse_args "$@"
  discover_local_source
  if [ "$DIR_SET" -eq 0 ]; then
    if [ "$ACTION" = "upgrade" ] || [ "$ACTION" = "uninstall" ]; then
      INSTALL_DIR="$DEFAULT_DIR"
    fi
  fi
  prepare_install_directory
  if [ "$ACTION" = "uninstall" ]; then
    uninstall
    return
  fi
  if { [ "$MODE" = "native" ] && [ -f /etc/codexdeck/codexdeck.env ]; } ||
      { [ "$MODE" = "docker" ] && [ -f "$INSTALL_DIR/.env" ]; }; then
    EXISTING_INSTALL=1
  fi
  choose_install_options
  if [ "$MODE" = "native" ]; then
    native_install
  else
    docker_install
  fi
  print_success
}

main "$@"

